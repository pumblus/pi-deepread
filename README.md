# pi-deepread

English | [简体中文](README_zh-CN.md)

Lightweight web search and document reading for [Pi](https://pi.dev). 3 tools, **under 1k tokens** of always-on prompt surface, single-file extension, no provider bloat.

- **`web_search`** — Uses DeepSeek `/v1/tools/search` with `need_content: true`. Every result includes the **full extracted page text**, not a short snippet.
- **`fetch_content`** — Extracts web pages via DeepSeek `/v1/tools/fetch`, then falls back to a reader proxy and the Wayback Machine when a page is paywalled or blocks bots. Local files (`.pdf`, `.docx`, `.xlsx`, `.epub`, images, audio) are converted on your machine with `anymd` / `pdftotext` — pass a plain path and nothing is uploaded.
- **`get_search_content`** — Stores results on disk with a `responseId`. Read through them with pagination or jump directly to passages using `findText`.

DeepSeek handles standard searches at ¥0.005/call. Exa is an optional fallback for DeepSeek's blind spots (WeChat articles, Xiaohongshu, V2EX, YouTube) or when queries fail — and without an Exa key those platforms still route to a keyless endpoint instead of failing.

## Installation

```bash
# From npm (recommended)
pi install npm:pi-deepread

# Or install from a local clone
pi install /path/to/pi-deepread

# Or test in a single session without installing
pi -e /path/to/pi-deepread
```

> **Note:** If you have `pi-web-access` installed, remove it first. Both register the same tool names (`web_search`, `fetch_content`, `get_search_content`) and will conflict:
>
> ```bash
> pi remove npm:pi-web-access
> ```

## Credentials

If Pi already has a DeepSeek API key configured, you don't need to configure anything—`pi-deepread` reads it directly from Pi's `auth.json`.

Key resolution order:

1. `deepseekApiKey` in `<agent dir>/web-search.json`
2. `DEEPSEEK_API_KEY` environment variable
3. `deepseek` entry in Pi's `auth.json`

Exa is optional and only used as a fallback — blind-spot platforms, empty results, DeepSeek failures. Without a key those queries still work through a keyless path (`sov2ex`, Sogou, the reader proxy), but **an Exa key gives noticeably better coverage and speed on 公众号 / 小红书 / V2EX / YouTube**, so it is worth requesting one. Set `exaApiKey` in the same config file or via the `EXA_API_KEY` environment variable.

Example configuration (`~/.pi/agent/web-search.json`):

```json
{
  "deepseekApiKey": "sk-...",
  "exaApiKey": "exa-...",
  "fetch": { "timeout": 45, "gapMs": 900 },
  "ssrf": { "allowRanges": ["198.18.0.0/15"] }
}
```

Keys also accept shell commands: `"deepseekApiKey": "!jq -r .deepseek.key ~/.pi/agent/auth.json"`.

> **Using a TUN proxy (Clash, Surge, sing-box)?**
> Fake-IP proxies map domain names into `198.18.0.0/15`. `pi-deepread` blocks private IP ranges by default to prevent SSRF. If your requests fail with blocked internal addresses, add `"ssrf": { "allowRanges": ["198.18.0.0/15"] }` to your config. Only enable this if your proxy uses that range.

## Local Document Parsing

Local files are converted directly on your machine without uploading anything:

| Format | Parser |
|---|---|
| `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.epub`, `.csv` | [anymd](https://github.com/SylphxAI/anymd) → Markdown (headings, tables, captions, OCR) |
| `.pdf` (when anymd is not installed) | `pdftotext` (plain text fallback) |
| Images / Audio / Subtitles | anymd (OCR / transcripts) |
| Web pages | DeepSeek `/v1/tools/fetch`, fallback to built-in HTTP reader |

Install the optional local parsers:

```bash
# Optional, recommended: structured Markdown converter
npm i -g @sylphx/anymd

# Required only if you need OCR on images or scanned PDFs
brew install tesseract tesseract-lang
```

**Chinese OCR Shim:** anymd runs `tesseract <image> stdout` without language arguments, which turns Chinese scans into garbled Latin text. `pi-deepread` includes a shim in `bin/tesseract` that injects `-l chi_sim+eng` unless custom language flags are provided (customizable via `ANYMD_TESS_LANGS`).

## Benchmarks

Measured on local hardware:

| Benchmark | Result | Notes |
|---|---|---|
| `need_content: false` (standard API) | ~431 chars | Short summary snippet only |
| `need_content: true` (this extension) | 3.7k–12.6k chars | Full extracted page text for the same ¥0.005 |
| Fetch concurrency (6 different hosts) | 9.31 s → **1.85 s** | Global ceiling of 3 vs. per-host scheduling |
| Same URL fetched twice | 7.04 s → **1 ms** | In-session hot cache |
| Repeated sites in a 6-hit answer | 1–3 duplicate hosts | Over-fetch by 2, then drop duplicate URLs / a third hit per host / near-identical wire titles — the slot count never shrinks |
| arXiv `abs` page | 6.44 s → **0.80 s** | HTML `/html/` version first when it exists |
| Paywalled pages (6 sites) | 0/6 → **5/6** with content | Reader proxy + Wayback raced in parallel |
| arXiv paper (15 pages) | anymd: 41k chars, 26 headings, 146 table rows (0.22 s) | `pdftotext`: 59k chars, 0 headings, broken columns (0.09 s) |
| Always-on prompt surface (3 tools) | 5,896 → **3,494 chars** (~971 tok) | Behaviour lives in tool output, not the system prompt |

Run `node bench/scenarios.ts all` to reproduce (needs real API keys).

## Limits & Design Details

- **128-character query limit**: DeepSeek counts the final query string including `site:` and `after:` filter operators. A compiled query over the limit is trimmed automatically (filters first, then trailing words) and the reply states what was dropped, instead of failing the call.
- **Index blind spots**: WeChat Official Accounts (公众号), Xiaohongshu (小红书), and parts of V2EX are not indexed well by DeepSeek; YouTube links frequently resolve to `music.youtube.com`. With an Exa key these queries route to Exa. Without one they go to a keyless endpoint (`sov2ex`, Sogou, the reader proxy), merged with DeepSeek's own hits, and listings that turn out to be login walls are dropped rather than passed to the model.
- **Paywalls and bot walls**: `fetch_content` tries DeepSeek, then a direct HTTP fetch, then (in parallel) a reader proxy and the Wayback Machine, and finally the search index. "A wall" is not only keyword matching: a short page with no long prose line and a majority of nav/login/footer lines counts too (it caught a 123-char Weibo JS shell that the length check alone let through). A page that is only available behind a wall returns the wall, or nothing — it does not pretend.
- **Local cache**: Search and fetch results are cached in `<agent dir>/cache/web/`. Automatically pruned every hour (retains up to 7 days, 200 files, or 64 MB).
- **Status check**: Run `/web-status` inside Pi to inspect resolved API keys, active routing, timeouts, OCR shim detection, and cache size.

## Development

```bash
git clone https://github.com/pumblus/pi-deepread
pi -e ./pi-deepread          # run extension from local checkout
```

The extension lives in a single file: [`extensions/web-access.ts`](extensions/web-access.ts).

See [`docs/BUILD_LOG.md`](docs/BUILD_LOG.md) for the backstory, debugging notes, and engineering tradeoffs behind this project.

## Credits & Inspiration

This project was inspired by [@Arcadia_Bao](https://x.com/Arcadia_Bao/article/2111711040757006401)'s benchmark on using DeepSeek's search and fetch tools with `need_content: true`.

## License

[MIT](LICENSE) © Eric Zhou
