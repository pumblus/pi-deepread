import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'deepread-core-'));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.DEEPSEEK_API_KEY = 'offline-test-only';
process.env.EXA_API_KEY = 'offline-test-only';
process.env.WEB_FETCH_GAP_MS = '0';
const { __test: api, looksLikeWall, htmlToText } = await import('../extensions/web-access.ts');
const { loadTools, textOf } = await import('../bench/lib.ts');
const tools = await loadTools();
const realFetch = globalThis.fetch;
// Every test must explicitly supply a fake response. Accidental network is a hard failure.
const noNetwork = (async () => { throw new Error('Unexpected outbound network in offline test'); }) as typeof fetch;
beforeEach(() => { globalThis.fetch = noNetwork; api.hotCache.clear(); api.hostStates.clear(); api.targetStarts.clear(); });
after(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });
function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
const article = 'This fixture is a complete article about a measured result, not navigation. '.repeat(130) + '\n尾部关键事实：实验结果是 42。';

for (const count of [127, 128, 129, 200]) {
  test(`Chinese query ${count} code points stays meaningful and inside limit`, () => {
    const question = '中'.repeat(count);
    const trimmed = api.trimToLimit(`${question} site:example.com after:2026-01-01`, 128);
    assert.ok(trimmed.query.length > 0);
    assert.ok(Array.from(trimmed.query).length <= 128);
    assert.equal(trimmed.query, '中'.repeat(Math.min(count, 128)));
    assert.ok(trimmed.dropped.some((part) => part.startsWith('site:')));
  });
}
test('Unicode truncation does not split surrogate pairs; ordinary queries unchanged', () => {
  assert.equal(api.trimToLimit('🧠'.repeat(129), 128).query, '🧠'.repeat(128));
  assert.equal(api.trimToLimit('small query site:example.com', 128).query, 'small query site:example.com');
  assert.throws(() => api.trimToLimit('site:' + 'x'.repeat(200), 128), /no searchable text/);
});

test('URL identity preserves case, ports, protocol, www, slash and semantic params', () => {
  for (const [a, b] of [
    ['https://example.com/A', 'https://example.com/a'],
    ['https://example.com/?id=Ab', 'https://example.com/?id=ab'],
    ['https://example.com:8443/a', 'https://example.com/a'],
    ['http://example.com/a', 'https://example.com/a'],
    ['https://www.example.com/a', 'https://example.com/a'],
    ['https://example.com/a/', 'https://example.com/a'],
    ['https://example.com/?source=a', 'https://example.com/?source=b'],
    ['https://example.com/?ref=a', 'https://example.com/?ref=b'],
  ]) assert.notEqual(api.urlKey(a), api.urlKey(b));
  assert.equal(api.urlKey('https://EXAMPLE.com/a?utm_source=x#part'), api.urlKey('https://example.com/a'));
});

test('search content distinguishes extracted full text, Exa excerpts, and summaries', () => {
  const full = api.normalizeHits({ results: [{ url: 'https://example.com/a', content: article }] });
  const summary = api.normalizeHits({ results: [{ url: 'https://example.com/b', summary: article }] });
  const exa = api.normalizeHits({ results: [{ url: 'https://example.com/c', text: article.slice(0, 8000) }] }, 'exa');
  assert.equal(full[0].contentKind, 'full'); assert.equal(summary[0].contentKind, 'summary'); assert.equal(exa[0].contentKind, 'partial');
  api.rememberHits([...full, ...summary, ...exa]);
  assert.ok(api.hotLookup(full[0].url));
  assert.equal(api.hotLookup(summary[0].url), undefined); assert.equal(api.hotLookup(exa[0].url), undefined);
});

test('a long login wall never enters reusable content cache; a short real page is allowed', () => {
  const wall = 'Log in to continue ' + 'Please enter your credentials. '.repeat(40);
  assert.equal(looksLikeWall(wall), true);
  assert.equal(looksLikeWall('营业通知：今天下午三点关门。'), false);
  api.rememberHits(api.normalizeHits({ results: [{ url: 'https://example.com/wall', content: wall }] }));
  assert.equal(api.hotLookup('https://example.com/wall'), undefined);
});

test('Exa excerpt can be completed by DeepSeek; tail fact survives pagination and repeated fetch is free', async () => {
  const url = 'https://mp.weixin.qq.com/s/example';
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const endpoint = String(input); requests.push(endpoint);
    if (endpoint.includes('api.exa.ai')) return json({ results: [{ url, title: 'Long fixture', text: article.slice(0, 8000) }] });
    if (endpoint.endsWith('/fetch')) return json({ title: 'Long fixture', content: article });
    throw new Error(`Unexpected endpoint ${endpoint}`);
  }) as typeof fetch;
  const search = await tools.get('web_search')!.execute('search', { query: '公众号 fixture', provider: 'exa' });
  assert.match(textOf(search), /partial/);
  assert.equal(api.hotLookup(url), undefined);
  const fetched = await tools.get('fetch_content')!.execute('fetch', { url });
  const found = await tools.get('get_search_content')!.execute('read', { responseId: fetched.details.responseId, findText: '实验结果是 42', findMode: 'exact' });
  assert.match(textOf(found), /实验结果是 42/);
  await tools.get('fetch_content')!.execute('again', { url });
  assert.deepEqual(requests, ['https://api.exa.ai/search', 'https://api.deepseek.com/v1/tools/fetch']);
});

test('true cold fetch makes one request; full search content and warm fetch make none', async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return json({ title: 'Fixture', content: article }); }) as typeof fetch;
  const cold = await api.fetchOne('https://example.com/cold');
  assert.equal(requests, 1); assert.equal(cold.source, 'deepseek');
  const warm = await api.fetchOne('https://example.com/cold');
  assert.equal(requests, 1); assert.equal(warm.source, 'cache'); assert.equal(warm.originalSource, 'deepseek');
  api.rememberHits(api.normalizeHits({ results: [{ title: 'Cached', url: 'https://example.com/search', content: article }] }));
  const indexed = await api.fetchOne('https://example.com/search');
  assert.equal(requests, 1); assert.equal(indexed.originalSource, 'deepseek-search');
});

test('expired hot content is removed; capacity stays bounded; wrong-case URL cannot hit', () => {
  api.rememberPage({ url: 'https://example.com/A', title: 'A', content: article, source: 'http' });
  assert.equal(api.hotLookup('https://example.com/a'), undefined);
  const entry = api.hotCache.get(api.urlKey('https://example.com/A'))!;
  entry.at = Date.now() - 31 * 60_000;
  assert.equal(api.hotLookup('https://example.com/A'), undefined);
  for (let i = 0; i < 85; i++) api.rememberPage({ url: `https://example.com/${i}`, title: `Item ${i}`, content: article, source: 'http' });
  assert.equal(api.hotCache.size, 80); assert.equal(api.hotLookup('https://example.com/0'), undefined);
});

test('forced DeepSeek receives a nonempty bounded Chinese query in actual request', async () => {
  let sent = '';
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)).query;
    return json({ results: [{ url: 'https://example.com/q', title: 'Query', content: article }] });
  }) as typeof fetch;
  await tools.get('web_search')!.execute('query', { query: '中文问题'.repeat(50), provider: 'deepseek', domainFilter: ['example.com'] });
  assert.ok(sent.startsWith('中文问题')); assert.ok(Array.from(sent).length <= 128); assert.ok(sent.length > 0);
});

test('endpoint budgets are separate; Retry-After delay is parsed', () => {
  assert.notEqual(api.requestBudget('https://api.deepseek.com/v1/tools/search'), api.requestBudget('https://api.deepseek.com/v1/tools/fetch'));
  assert.equal(api.retryDelay('2', 100), 2000); assert.equal(api.retryDelay('invalid', 100), 100);
  assert.ok(api.retryDelay(new Date(Date.now() + 10_000).toUTCString(), 100) > 8000);
});

test('429 and server failures retry within budget; unchanged client error and non-JSON do not', async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return requests < 3 ? json({}, requests === 1 ? 429 : 503, { 'retry-after': '0' }) : json({ ok: true }); }) as typeof fetch;
  assert.deepEqual(await api.requestJson('https://api.deepseek.com/v1/tools/search', {}, 5000), { ok: true }); assert.equal(requests, 3);
  requests = 0;
  globalThis.fetch = (async () => { requests++; return json({}, 400); }) as typeof fetch;
  await assert.rejects(api.requestJson('https://api.deepseek.com/v1/tools/search', {}, 5000), /HTTP 400/); assert.equal(requests, 1);
  globalThis.fetch = (async () => new Response('not json')) as typeof fetch;
  await assert.rejects(api.requestJson('https://api.deepseek.com/v1/tools/search', {}, 5000), /Non-JSON/);
});

test('cancelling a retry delay prevents another request or fallback', async () => {
  const controller = new AbortController(); let requests = 0;
  globalThis.fetch = (async () => { requests++; setTimeout(() => controller.abort(), 20); return json({}, 429, { 'retry-after': '20' }); }) as typeof fetch;
  await assert.rejects(api.requestJson('https://api.deepseek.com/v1/tools/search', {}, 5000, controller.signal), /Aborted/);
  assert.equal(requests, 1);
  await assert.rejects(api.fetchOne('https://example.com/a', controller.signal), /Aborted/);
  assert.equal(requests, 1);
});

test('fixed HTML fixture preserves facts and removes menu; short valid article not discarded', () => {
  const output = htmlToText('<html><title>Fixture</title><nav>Menu Subscribe</nav><article><h1>结果</h1><p>关键事实：42。</p></article><script>secret()</script></html>');
  assert.equal(output.title, 'Fixture'); assert.match(output.text, /关键事实：42/); assert.doesNotMatch(output.text, /Subscribe|secret/);
});

test('stored pagination, findText and expiry fail clearly rather than returning wrong text', async () => {
  api.saveStored({ kind: 'fetch', id: 'fixture', createdAt: '2026-01-01', pages: [
    { url: 'https://example.com/1', title: 'One', content: 'abcdefghij', source: 'http' },
    { url: 'https://example.com/2', title: 'Two', content: '第二段关键事实42', source: 'http' },
  ] });
  const read = tools.get('get_search_content')!;
  const result = await read.execute('read', { responseId: 'fixture', offset: 8, limit: 6 });
  assert.match(textOf(result), /ij/); assert.match(textOf(result), /第二段关/); assert.equal(result.details.returned, 6);
  await assert.rejects(read.execute('read', { responseId: 'fixture', findText: 'missing' }), /not found/);
  await assert.rejects(read.execute('read', { responseId: 'fixture', offset: 999 }), /past the end/);
  const fs = await import('node:fs');
  const files = fs.readdirSync(dir, { recursive: true }).map(String);
  const storedPath = join(dir, files.find((file) => file.endsWith('fixture.json'))!);
  utimesSync(storedPath, new Date(0), new Date(0));
  assert.equal(api.loadStored('fixture'), undefined);
  writeFileSync(storedPath, '{broken'); assert.equal(api.loadStored('fixture'), undefined);
});

test('three tools only and prompt character budget does not grow beyond baseline', () => {
  assert.deepEqual([...tools.keys()].sort(), ['fetch_content', 'get_search_content', 'web_search']);
  const chars = [...tools.values()].reduce((sum, tool) => sum + (tool.promptSnippet?.length ?? 0) + (tool.description?.length ?? 0) + (tool.promptGuidelines ?? []).join('').length + JSON.stringify(tool.parameters).length, 0);
  assert.ok(chars <= 3500, `prompt chars ${chars} > 3500`);
});

test('short application shells and chrome-only pages fail but factual short content survives', () => {
  for (const shell of ['Loading...', 'Please enable JavaScript', 'Sign in', 'Menu\nHome\nSearch\nSign in', 'Please wait…']) assert.equal(looksLikeWall(shell), true, shell);
  assert.equal(looksLikeWall('收据：订单 42，实付 27 元。'), false);
});

test('unknown media, partial fetches and archived content are not promoted into full cached pages', () => {
  for (const [contentKind, source] of [['unknown', 'anymd'], ['partial', 'deepseek'], ['full', 'wayback']] as const) {
    api.rememberPage({ url: 'https://example.com/item', title: 'Item', content: article, contentKind, source });
    assert.equal(api.hotLookup('https://example.com/item'), undefined);
  }
});

test('index fallback refuses a related but different URL and labels exact summary honestly', async () => {
  const url = 'https://example.com/story/orchid-results';
  globalThis.fetch = (async () => json({ results: [{ url: 'https://example.com/story/orchid-other', title: 'Related', content: article }] })) as typeof fetch;
  await assert.rejects(api.indexSubstitute(url), /no exact indexed copy/);
  globalThis.fetch = (async () => json({ results: [{ url, title: 'Exact', summary: article.slice(0, 500) }] })) as typeof fetch;
  const page = await api.indexSubstitute(url);
  assert.equal(page.url, url); assert.equal(page.contentKind, 'summary');
  api.saveStored({ kind: 'fetch', id: 'indexed', createdAt: '2026-01-01', pages: [page] });
  const read = await tools.get('get_search_content')!.execute('read', { responseId: 'indexed' });
  assert.match(textOf(read), /summary/);
});

test('URL deduplication never restores identical URLs in a small result set', () => {
  const hit = { url: 'https://example.com/a', title: 'Same', content: article };
  assert.equal(api.squeezeHits([hit, { ...hit }], 'query').length, 1);
});

test('cancelling a saturated scheduler removes its waiter without waiting for other requests', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const occupied = Array.from({ length: 12 }, (_, i) => api.paced(`https://host${i}.example.com`, () => blocked));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const controller = new AbortController();
  let executed = false;
  const queued = api.paced('https://queued.example.com', async () => { executed = true; }, undefined, controller.signal);
  controller.abort();
  try {
    await Promise.race([
      assert.rejects(queued, { name: 'AbortError' }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('queued cancellation did not finish promptly')), 200)),
    ]);
    assert.equal(executed, false);
  } finally { release(); await Promise.all(occupied); }
  await api.paced('https://next.example.com', async () => {});
});

test('removing tracking parameters preserves exact nontracking query encoding', () => {
  assert.equal(api.urlKey('https://example.com/a?q=~&utm_source=x'), api.urlKey('https://example.com/a?q=~'));
  assert.equal(api.urlKey('https://example.com/a?q=%7E&utm_source=x'), api.urlKey('https://example.com/a?q=%7E'));
});
