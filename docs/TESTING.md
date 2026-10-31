# Testing pi-deepread

## 1. Offline correctness gate

```sh
npm ci
npm run check                 # TypeScript + deterministic tests + HTML/prompt gates
node bench/sanitize.ts        # fixed HTML fixture, no network
node bench/prompt-surface.ts  # three tools, <=3,500 metadata characters
```

Offline tests must use synthetic or checked-in fixtures, fake provider responses and fake converters. They must not read personal API keys, download OCR models, or contact live services. A failed assertion exits nonzero. The registration harness in `bench/lib.ts` captures tool definitions; it is **not** Pi's actual extension loader or runtime schema validator.

The prompt script's characters / 3.6 calculation is an estimate only. A character budget catches growth; it does not guarantee a particular token count across models. The offline suite also smoke-tests the actual pinned Pi 1.4 extension loader and three-tool registration. Invoking a real model and measuring its assembled request remains separate.

### Priority coverage

- Partial Exa result vs complete DeepSeek search content; a required fact beyond character 8,000; only incomplete text triggers enrichment; repeat reads avoid repeated requests.
- Chinese questions without spaces around the query length boundary; filters dropped before the question; no empty request.
- Case-sensitive URL paths/query values, ports, and meaningful `ref`/`source` parameters do not share content accidentally.
- A long login wall, a short valid article, and a similar but different article are not equivalent successes.
- Fresh cache, search-warmed cache, repeat fetch, expiry and eviction use request counts rather than timing to prove behavior.
- Provider errors, rate limits, cancellation, timeouts and bounded fallback; cancellation never starts another provider request.
- Stored content pagination and exact/case-insensitive/fuzzy fact finding, including a fact at the end.
- anymd success, nonzero exit with partial output, timeout, cancellation, missing dependency and empty output; PDF fallback downloads once and removes temporary files on all exits.
- Small document samples: short valid PDF, Chinese scan/image, DOCX headings/tables, XLSX cells and EPUB chapter order. Assert facts and structure, not a minimum character count.
- Local paths (including spaces and Chinese) generate zero network calls; metadata is not mislabeled as an audio transcript; missing optional converters do not disable web search.
- OCR language flags, psm/oem flags, missing language data, and packaging/executable permissions. Windows compatibility needs a separate supported-platform run.

This list is the target coverage map, not a claim that every combination or real converter platform is already exercised. Check the actual test names and final test output for implemented coverage. Real anymd/OCR and Pi loader smoke tests require their corresponding installed dependencies.

## 2. Optional live observations

Live calls may consume paid API credits. Nothing below belongs in the offline default test command.

```sh
WEB_BENCH_LIVE=1 node bench/scenarios.ts p0
WEB_BENCH_LIVE=1 node bench/scenarios.ts p1
WEB_BENCH_LIVE=1 node bench/probe-hard.ts
# Isolated configuration; only DEEPSEEK_API_KEY is used. EXA_API_KEY is removed.
WEB_BENCH_LIVE=1 DEEPSEEK_API_KEY=... node bench/scenarios.ts noexa
```

Do not put real credentials in committed files or saved command examples. The `all` group skips no-Exa cases because a clean configuration must be selected before importing the extension. `noexa`/`p2` use a temporary empty configuration directory and delete it afterward; they never copy existing config or auth files.

Optional environment inputs:

- `WEB_BENCH_COLD_URL`: a fixed article URL for the first fetch in a new process, before any search. The subsequent search-to-fetch case is explicitly labeled possibly pre-warmed.
- `WEB_BENCH_LOCAL_PDF` and `WEB_BENCH_LOCAL_EXPECT`: existing local document plus a known fact to assert. A missing fixture is a skip, never a pass.
- `WEB_BENCH_MANIFEST`: path to a reviewed JSON corpus, for example:

```json
[
  {
    "url": "https://your-test-site.example/fixed-article",
    "mustInclude": ["Exact article title", "Verified fact from the final paragraph"],
    "mustNotInclude": ["Exact known login-wall message"]
  }
]
```

Use specific stable article URLs, not changing section pages. Review expected facts and original source identity when maintaining the corpus. The runner pages through stored content, not only its first display excerpt. For paid/blocked articles, never label a related substitute as the original simply because its text is long. Assertions alone still need a corpus whose expected facts are sufficiently specific.

Output distinguishes `pass`, `fail`, `skip` and `observation`. Observations report latency/returned text without claiming verified correctness. Any failed case exits 1; disabled live access exits 2. Skips are printed explicitly and do not satisfy release coverage. Compare latency and request costs only after content correctness passes. Historical README timings are not current guarantees.

## 3. Real local PDF fallback

`npm run test:pdf` requires Poppler (`pdftotext`) already installed. It reads the checked-in synthetic two-page PDF through the real PDF fallback, checks table and final-page facts, and forbids network access. It deliberately simulates anymd being absent; this is not an anymd or OCR quality test. The fixture was generated with ReportLab; ReportLab is not needed to run it.
