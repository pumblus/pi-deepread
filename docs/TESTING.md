# Testing and Verification

This document covers the test suites, verification procedures, and benchmarks for `pi-deepread`.

The testing strategy is split into three tiers:
1. **Offline Correctness Gate**: Fast, deterministic unit and smoke tests. Requires no network access, no API keys, and no external dependencies.
2. **Local PDF Fallback**: Tests local document extraction through `pdftotext` using checked-in fixtures.
3. **Live Scenario Benchmarks**: Optional integration tests executed against live search and fetch endpoints.

---

## Quick Reference

| Command | Purpose | Network | API Keys |
|---|---|---|---|
| `npm run check` | Run type checking, unit tests, HTML sanitization, and prompt budget checks | No | None |
| `npm test` | Run deterministic unit tests only | No | None |
| `npm run test:pdf` | Test local PDF parsing fallback via `pdftotext` | No | None |
| `npm run bench:prompt` | Measure tool description prompt character and token budgets | No | None |
| `WEB_BENCH_LIVE=1 node bench/scenarios.ts p0` | Run basic live integration smoke tests | Yes | DeepSeek |
| `WEB_BENCH_LIVE=1 node bench/scenarios.ts noexa` | Run live tests with Exa disabled (isolated empty config) | Yes | DeepSeek |

---

## 1. Offline Correctness Gate

Run the full offline verification suite before committing:

```sh
npm ci
npm run check
```

`npm run check` executes four verification steps:
1. `npm run typecheck` — TypeScript compiler checks (`tsc --noEmit`).
2. `npm test` — Core unit tests running against deterministic mocks.
3. `node bench/sanitize.ts` — HTML cleanup and content extraction verification using fixed local HTML fixtures.
4. `npm run bench:prompt` — Prompt surface budget verification.

### Offline Testing Constraints

- **No network access**: All search, fetch, and proxy calls must use synthetic fixtures or mock handlers.
- **No credentials**: Tests must not read personal API keys from environment variables or `auth.json`.
- **Zero side effects**: Tests must not write persistent cache files to agent directories or download external models.
- **Strict exit codes**: Any assertion failure exits immediately with a non-zero code.

### Prompt Surface Budget

`bench/prompt-surface.ts` ensures that always-on tool definitions stay within budget:
- Maximum metadata limit: **3,500 characters** across all registered tools (`web_search`, `fetch_content`, `get_search_content`).
- Estimated tokens: ~971 tokens (using a 3.6 characters-per-token baseline).

This check acts as a regression gate to prevent tool descriptions from bloating the LLM's system prompt.

---

## 2. Test Coverage Specifications

The offline test suite validates the following subsystems and edge cases:

### Search & Result Enrichment
- **Content enrichment**: Verifies that full DeepSeek search results are preferred over short snippets, and that secondary fetches are only triggered when content is partial or missing.
- **Deep text retrieval**: Ensures facts located past character 8,000 in long articles are properly indexed and retrievable via `findText`.
- **Session deduplication**: Verifies that repeated requests for the same URL in a single session hit the in-memory cache with zero repeated network calls.

### Query Parsing & Boundary Handling
- **128-character limit**: Validates that queries exceeding DeepSeek's 128-character cap are trimmed gracefully (dropping search operators first, then truncating cleanly at word boundaries).
- **Multilingual inputs**: Ensures Chinese queries without spaces around length thresholds truncate safely without producing malformed Unicode characters or empty requests.

### URL Normalization & SSRF Protection
- **URL integrity**: Verifies that case-sensitive paths, port numbers, and query parameters (`ref`, `source`) are preserved and do not cause false cache collisions.
- **SSRF boundaries**: Verifies that requests to private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254`) are blocked by default.
- **Fake-IP proxy bypass**: Confirms that whitelisting `198.18.0.0/15` allows requests through TUN-mode proxies when explicitly configured.

### Cache & Storage Lifecycle
- **Cache states**: Verifies correct behavior across fresh cache, search-warmed cache, and repeat fetch scenarios using exact call counters.
- **Eviction policy**: Tests LRU eviction behavior based on age (7 days), file count (200 files), and total directory size (64 MB).
- **Pagination & search**: Tests forward and backward pagination across cached `responseId` records, including case-insensitive and fuzzy substring searches.

### Fallback Mechanics & Content Integrity
- **Wall detection**: Distinguishes between paywalls, login walls, and valid short articles using structural heuristics (prose length vs. navigation chrome ratio) rather than fragile keyword lists.
- **Parallel racing**: Verifies that reader proxies and the Wayback Machine race in parallel when primary fetch methods fail.
- **Cancellation handling**: Ensures that canceled requests abort cleanly and never trigger secondary fallback requests.

### Local Document Parsers
- **Format coverage**: Validates conversion pathways for `.pdf`, `.docx`, `.xlsx`, `.epub`, images, and audio metadata.
- **Local isolation**: Guarantees that local file paths never generate external network calls.
- **Graceful degradation**: Verifies that missing optional binaries (`anymd`, `tesseract`) fail silently without disrupting core web search functionality.
- **OCR shim**: Checks that `bin/tesseract` correctly passes through explicit language flags (`-l`, `--psm`, `--oem`) and injects `-l chi_sim+eng` only when language parameters are omitted.

---

## 3. Real Local PDF Fallback Smoke Test

Run the local PDF extraction test:

```sh
npm run test:pdf
```

### Requirements & Behavior
- **Prerequisite**: Requires Poppler's `pdftotext` installed on the host system (`brew install poppler` on macOS).
- **Isolation**: Simulates the absence of `anymd` to verify that the built-in `pdftotext` fallback works reliably.
- **Assertions**: Reads a checked-in, two-page synthetic PDF fixture and verifies that tabular data, multi-column layout, and final-page facts are extracted accurately.
- **Cleanup**: Ensures all temporary working files are removed upon completion, regardless of exit status.

---

## 4. Live Scenario Benchmarks (Optional)

Live benchmarks verify behavior against live web services and provider APIs. Because these tests make real network requests, they may consume paid API credits.

> **Warning:** Live tests should never be included in the default offline test suite or CI pipelines without explicit configuration. Never commit real API keys to repository files.

### Running Live Tests

```sh
# Basic smoke tests against live endpoints
WEB_BENCH_LIVE=1 node bench/scenarios.ts p0

# Extended scenario suite
WEB_BENCH_LIVE=1 node bench/scenarios.ts p1

# Difficult edge cases and bot-protected sites
WEB_BENCH_LIVE=1 node bench/probe-hard.ts

# Isolated no-Exa test (verifies keyless fallback paths)
WEB_BENCH_LIVE=1 DEEPSEEK_API_KEY=sk-... node bench/scenarios.ts noexa
```

### Isolated Configuration (`noexa`)

The `noexa` scenario suite runs with `EXA_API_KEY` explicitly stripped. It creates an isolated temporary configuration directory and deletes it upon completion, ensuring that DeepSeek search, keyless social fallbacks (`sov2ex`, Sogou), and reader proxies function without an Exa subscription.

### Optional Environment Variables

- `WEB_BENCH_LIVE`: Must be set to `1` to enable live network tests.
- `WEB_BENCH_COLD_URL`: Specifies a stable article URL for cold-cache fetch testing before any search is run.
- `WEB_BENCH_LOCAL_PDF`: Path to a local PDF file for real-world document parsing tests.
- `WEB_BENCH_LOCAL_EXPECT`: Expected text string that must be present in the parsed output of `WEB_BENCH_LOCAL_PDF`.
- `WEB_BENCH_MANIFEST`: Path to an external JSON test corpus for automated regression suites.

Example manifest format:

```json
[
  {
    "url": "https://example.com/sample-article",
    "mustInclude": [
      "Exact Article Title",
      "Specific fact from the concluding section"
    ],
    "mustNotInclude": [
      "Please log in to continue reading"
    ]
  }
]
```

### Result Classifications & Exit Codes

The test runner categorizes results into four states:
- **`pass`**: The assertion completed successfully and verified expected facts.
- **`fail`**: Output was missing expected content, contained blacklisted strings, or threw an unexpected error. Exits with code `1`.
- **`skip`**: An optional dependency or input fixture was missing. Skips are printed explicitly and do not count toward release verification.
- **`observation`**: Informational latency or character count measurement; does not assert semantic correctness.

If live testing is disabled (`WEB_BENCH_LIVE` not set), live test commands exit with code `2`.
