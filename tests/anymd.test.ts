import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "deepread-converter-test-"));
const binary = join(dir, "anymd");
const log = join(dir, "calls.jsonl");
const converter = `#!${process.execPath}
const fs = require('node:fs');
const name = require('node:path').basename(process.argv[1]);
const mode = name === 'pdftotext' ? process.env.TEST_PDF_MODE : process.env.TEST_ANYMD_MODE;
fs.appendFileSync(process.env.TEST_CONVERTER_LOG, JSON.stringify({ name, args: process.argv.slice(2), pid: process.pid }) + '\\n');
if (mode === 'partial') { process.stdout.write('incomplete text'); process.exitCode = 2; }
else if (mode === 'empty') { }
else if (mode === 'hang') { process.stdout.write('unfinished'); setInterval(() => {}, 1000); }
else { process.stdout.write(name === 'pdftotext' ? 'PDF fallback fact 42' : '收据：已付款 42 元'); }
`;
writeFileSync(binary, converter, { mode: 0o755 });
writeFileSync(join(dir, "pdftotext"), converter, { mode: 0o755 });
process.env.ANYMD_BIN = binary;
process.env.ANYMD_SHIM_DIR = "";
process.env.TEST_CONVERTER_LOG = log;
process.env.PATH = `${dir}:${process.env.PATH}`;
process.env.WEB_FETCH_GAP_MS = "0";
const { __test } = await import("../extensions/web-access.ts");
const pdf = join(dir, "短收据.pdf");
writeFileSync(pdf, "%PDF-1.7\nSynthetic converter fixture; never uploaded.");
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });
function reset(anymd = "success", pdftotext = "success") {
  process.env.TEST_ANYMD_MODE = anymd;
  process.env.TEST_PDF_MODE = pdftotext;
  writeFileSync(log, "");
}
function calls(): Array<{ name: string; args: string[]; pid: number }> {
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("short valid local PDF is accepted and never fetched over the network", async () => {
  reset();
  globalThis.fetch = (() => { throw new Error("unexpected network"); }) as typeof fetch;
  try {
    const page = await __test.localToText(pdf);
    assert.equal(page.content, "收据：已付款 42 元");
    assert.equal(page.source, "anymd");
    assert.deepEqual(calls().map((call) => call.name), ["anymd"]);
  } finally { globalThis.fetch = realFetch; }
});

test("converter nonzero exit with partial stdout is rejected, not cached as full content", async () => {
  reset("partial", "partial");
  await assert.rejects(__test.execAnymd(pdf), /incomplete output discarded/);
  await assert.rejects(__test.execPdftotext(pdf), /incomplete output discarded/);
});

test("empty anymd output triggers PDF fallback", async () => {
  reset("empty");
  const page = await __test.localToText(pdf);
  assert.equal(page.source, "pdftotext");
  assert.equal(page.content, "PDF fallback fact 42");
});

test("cancellation stops converter and does not start fallback", async () => {
  reset("hang");
  const controller = new AbortController();
  const pending = __test.localToText(pdf, controller.signal);
  const deadline = Date.now() + 5000;
  while (!calls().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls().length, 1, "fake converter must start before cancellation");
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(calls().map((call) => call.name), ["anymd"]);
  assert.throws(() => process.kill(calls()[0].pid, 0), { code: "ESRCH" });
});

test("already cancelled local conversion never spawns a process", async () => {
  reset();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(__test.localToText(pdf, controller.signal), { name: "AbortError" });
  assert.equal(calls().length, 0);
});

test("remote PDF fallback reuses one download and removes it afterwards", async () => {
  reset("partial");
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return new Response("%PDF-1.7 fake PDF"); }) as typeof fetch;
  try {
    const page = await __test.anymdToText("https://example.com/fixture.pdf", undefined, true);
    assert.equal(page.source, "pdftotext");
    assert.equal(requests, 1);
    const paths = calls().map((call) => call.name === "anymd" ? call.args[0] : call.args[3]);
    assert.equal(paths.length, 2); assert.equal(paths[0], paths[1]);
    assert.equal(existsSync(paths[0]), false);
  } finally { globalThis.fetch = realFetch; }
});

test("interrupted download leaves no partially written temp file", async () => {
  reset();
  const prefix = `wa-${process.pid}-`;
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));
  let pulls = 0;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
      else controller.error(new Error("connection interrupted"));
    },
  }))) as typeof fetch;
  try {
    await assert.rejects(__test.downloadToTemp("https://example.com/broken.pdf"), /connection interrupted/);
    assert.deepEqual(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)), before);
  } finally { globalThis.fetch = realFetch; }
});

test("OCR shim adds Chinese for psm/oem but respects explicit language", () => {
  const echo = join(dir, "echo-args");
  writeFileSync(echo, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", { mode: 0o755 });
  const run = (args: string[]) => execFileSync("bash", [resolve("bin/tesseract"), ...args], {
    encoding: "utf8", env: { ...process.env, TESSERACT_BIN: echo, ANYMD_TESS_LANGS: "chi_sim+eng" },
  }).trim().split("\n");
  assert.deepEqual(run(["image", "stdout", "--psm", "6", "--oem", "1"]), ["-l", "chi_sim+eng", "image", "stdout", "--psm", "6", "--oem", "1"]);
  assert.deepEqual(run(["image", "stdout", "-l", "eng", "--psm", "6"]), ["image", "stdout", "-l", "eng", "--psm", "6"]);
});

test("missing optional anymd falls back for PDFs without disabling local reading", async () => {
  reset();
  rmSync(binary);
  try {
    const page = await __test.localToText(pdf);
    assert.equal(page.source, "pdftotext");
    assert.deepEqual(calls().map((call) => call.name), ["pdftotext"]);
  } finally { writeFileSync(binary, converter, { mode: 0o755 }); }
});

test("non-PDF failure does not run the PDF parser", async () => {
  reset("partial");
  const path = join(dir, "fixture.docx"); writeFileSync(path, "fixture");
  await assert.rejects(__test.localToText(path), /incomplete output discarded/);
  assert.deepEqual(calls().map((call) => call.name), ["anymd"]);
});

test("oversized declared or streaming downloads are rejected and cleaned", async () => {
  const prefix = `wa-${process.pid}-`;
  const before = readdirSync(tmpdir()).filter((name) => name.startsWith(prefix));
  globalThis.fetch = (async () => new Response("", { headers: { "content-length": String(31 * 1024 * 1024) } })) as typeof fetch;
  try {
    await assert.rejects(__test.downloadToTemp("https://example.com/large.pdf"), /over the/);
    let count = 0;
    globalThis.fetch = (async () => new Response(new ReadableStream({ pull(controller) {
      if (count++ < 31) controller.enqueue(new Uint8Array(1024 * 1024));
      else controller.close();
    } }))) as typeof fetch;
    await assert.rejects(__test.downloadToTemp("https://example.com/large-stream.pdf"), /over the/);
    assert.deepEqual(readdirSync(tmpdir()).filter((name) => name.startsWith(prefix)), before);
  } finally { globalThis.fetch = realFetch; }
});

test("local audio and remote video do not claim automatic transcription", async () => {
  reset();
  const audio = join(dir, "中文 audio 录音.mp3"); writeFileSync(audio, "fixture");
  const local = await __test.localToText(audio);
  assert.equal(local.contentKind, "unknown");
  assert.match(local.note ?? "", /automatic transcription was not requested/);
  globalThis.fetch = (async () => new Response("video fixture")) as typeof fetch;
  try {
    const remote = await __test.anymdToText("https://example.com/video.mp4", undefined, false);
    assert.equal(remote.contentKind, "unknown");
    assert.match(remote.note ?? "", /metadata or existing subtitles/);
  } finally { globalThis.fetch = realFetch; }
});

test("local file URL with spaces and Chinese characters is read without network", async () => {
  reset();
  const { pathToFileURL } = await import("node:url");
  const path = join(dir, "中文 receipt 42.pdf"); writeFileSync(path, "%PDF-fixture");
  globalThis.fetch = (() => { throw new Error("unexpected network"); }) as typeof fetch;
  try {
    const page = await __test.fetchOne(pathToFileURL(path).href);
    assert.equal(page.content, "收据：已付款 42 元");
    assert.equal(calls()[0].args[0], path);
  } finally { globalThis.fetch = realFetch; }
});
