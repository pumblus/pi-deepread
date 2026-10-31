import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'deepread-loader-'));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.JITI_FS_CACHE = join(dir, 'jiti');
delete process.env.DEEPSEEK_API_KEY;
delete process.env.EXA_API_KEY;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => { throw new Error('Loader smoke test must not access network'); }) as typeof fetch;
after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });
test('installed Pi 1.4 loader accepts the TypeScript extension and registers exactly three tools', async () => {
  // Deliberately exercise the pinned dev version's real loader, not bench/lib.ts's fake API.
  const loaderUrl = new URL('./core/extensions/loader.js', import.meta.resolve('@earendil-works/pi-coding-agent'));
  const { loadExtensions } = await import(loaderUrl.href);
  const result = await loadExtensions([resolve('extensions/web-access.ts')], dir);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.deepEqual([...extension.tools.keys()].sort(), ['fetch_content', 'get_search_content', 'web_search']);
  assert.ok(extension.commands.has('web-status'));
});
