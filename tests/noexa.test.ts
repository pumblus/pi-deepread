import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const dir = mkdtempSync(join(tmpdir(), 'deepread-noexa-'));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.DEEPSEEK_API_KEY = 'offline-only';
delete process.env.EXA_API_KEY;
process.env.WEB_FETCH_GAP_MS = '0';
const { loadTools } = await import('../bench/lib.ts');
const tools = await loadTools();
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });
test('no-Exa isolated config never uses Exa and Chinese truncation reaches DeepSeek', async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    requests.push(String(url));
    assert.equal(String(url), 'https://api.deepseek.com/v1/tools/search');
    const body = JSON.parse(String(init?.body));
    assert.ok(body.query.length > 0); assert.ok(Array.from(body.query).length <= 128);
    return new Response(JSON.stringify({ results: [{ title: 'Fixture', url: 'https://example.com/fixture', content: 'A complete short factual article.' }] }));
  }) as typeof fetch;
  await tools.get('web_search')!.execute('query', { query: '中文'.repeat(100) });
  assert.equal(requests.length, 1);
  await assert.rejects(tools.get('web_search')!.execute('forced', { query: 'example', provider: 'exa' }), /needs an Exa key/);
  assert.equal(requests.length, 1);
});
