# pi-deepread

English | [简体中文](README_zh-CN.md)

Lightweight web search and document reading for [Pi](https://pi.dev). Single-file extension, three tools, no provider bloat.

- **`web_search`** — Uses DeepSeek `/v1/tools/search` with `need_content: true`. Every result includes the **full extracted page text**, not a short snippet.
- **`fetch_content`** — Extracts web pages via DeepSeek `/v1/tools/fetch`, and converts local files (`.pdf`, `.docx`, `.xlsx`, `.epub`, images, audio) directly with `anymd` / `pdftotext`. Nothing is uploaded.
- **`get_search_content`** — Stores results on disk with a `responseId`. Read through them with pagination or jump directly to passages using `findText`.

DeepSeek handles standard searches at ¥0.005/call. Exa is an optional fallback for DeepSeek's blind spots (WeChat articles, Xiaohongshu, V2EX, YouTube) or when queries fail.

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

Exa is optional and only used as a fallback. Set `exaApiKey` in the same config file or via the `EXA_API_KEY` environment variable.

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
| Query length limit | 128 chars | DeepSeek hard limit (returns `HTTP 400` if exceeded) |
| Fetch concurrency | 1–3 threads clean | 10 concurrent requests trigger ~30% `HTTP 429` |
| `fetch_content` (4 URLs) | 5.71 s → **2.85 s** | Serial vs. concurrency of 3 |
| `web_search` (3 query variants) | ~1.2 s → **0.45 s** | Concurrency optimization |
| arXiv paper (15 pages) | anymd: 41k chars, 26 headings, 146 table rows (0.22 s) | `pdftotext`: 59k chars, 0 headings, broken columns (0.09 s) |

## Limits & Design Details

- **128-character query limit**: DeepSeek counts the final query string including `site:` and `after:` filter operators. Queries exceeding 128 characters are routed to Exa (if configured), or return an error displaying the full compiled query.
- **Index blind spots**: WeChat Official Accounts (公众号), Xiaohongshu (小红书), and parts of V2EX are not indexed well by DeepSeek; YouTube links frequently resolve to `music.youtube.com`. With an Exa key configured, these queries route to Exa automatically.
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
