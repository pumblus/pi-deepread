/** Explicit local integration check; requires installed Poppler, never calls a provider. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const dir = mkdtempSync(join(tmpdir(), 'deepread-pdf-smoke-'));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.ANYMD_BIN = join(dir, 'intentionally-missing-anymd');
globalThis.fetch = (async () => { throw new Error('Local PDF must never make a network request'); }) as typeof fetch;
try {
  execFileSync('pdftotext', ['-v'], { stdio: 'pipe' });
  const { __test } = await import('../../extensions/web-access.ts');
  const result = await __test.localToText(resolve('tests/fixtures/two-page.pdf'));
  assert.equal(result.source, 'pdftotext');
  for (const fact of ['ORCHID-73', '27.40', 'tail fact is 42']) assert.ok(result.content.includes(fact), `Missing PDF fact: ${fact}`);
  assert.ok(result.content.indexOf('ORCHID-73') < result.content.indexOf('tail fact is 42'));
  console.log('PASS real local PDF: Poppler fallback retains first-page/table/final-page facts; zero network');
} finally { rmSync(dir, { recursive: true, force: true }); }
