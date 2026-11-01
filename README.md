# pi-deepread

English | [简体中文](README_zh-CN.md)

Fast web search and local document reading for [Pi](https://pi.dev). 3 tools, **about 1k tokens** of prompt overhead, single-file extension, zero provider bloat.

Most search tools for AI agents take two steps: search for links, get back tiny 800-character snippets, realize there isn't enough information, and then make a second request to fetch the actual web page. `pi-deepread` gets the full page text on the very first search using DeepSeek's `need_content` feature—for the exact same ¥0.005 (a fraction of a cent) per query.

It also lets Pi read PDFs, Word documents, spreadsheets, and images directly on your machine. Everything is converted locally—no cloud uploads, no privacy concerns.

- **`web_search`** — Searches the web using DeepSeek with `need_content: true`. Returns extracted page text immediately and labels results as full, partial, or summary. You can page through cached text without making another request, or fetch more detail only when needed.
- **`fetch_content`** — Reads any web page or local file. Web pages go through DeepSeek's reader, with automatic fallbacks to a reader proxy and the Wayback Machine if a site blocks bots or hits a paywall. Local files (`.pdf`, `.docx`, `.xlsx`, `.epub`, images, audio) are converted right on your computer with `anymd` or `pdftotext`—pass a local path and nothing leaves your machine.
- **`get_search_content`** — Accesses saved search and fetch results by `responseId`. Read through long documents page by page, or jump straight to specific passages using `findText`.

DeepSeek handles standard searches at ¥0.005 per call. Exa is an optional fallback for platforms DeepSeek struggles to index (WeChat articles, Xiaohongshu, V2EX, YouTube) or when an API call fails. Even without an Exa key, those platforms still route through keyless fallback paths instead of erroring out.

---

## Quick Install

```bash
# Install from npm (recommended)
pi install npm:pi-deepread

# Or install from a local folder
pi install /path/to/pi-deepread

# Or test in a single session without saving
pi -e /path/to/pi-deepread
```

> **Note:** If you currently have `pi-web-access` installed, remove it first. Both extensions use the same tool names (`web_search`, `fetch_content`, `get_search_content`) and will conflict:
>
> ```bash
> pi remove npm:pi-web-access
> ```

---

## API Keys & Configuration

If you already use DeepSeek in Pi, you don't need to configure anything. `pi-deepread` picks up your key directly from Pi's `auth.json`.

Key resolution order:

1. `deepseekApiKey` in `<agent dir>/web-search.json`
2. `DEEPSEEK_API_KEY` environment variable
3. The `deepseek` entry in Pi's `auth.json`

### Optional Exa Key

Exa is strictly an optional fallback for DeepSeek's blind spots (WeChat Official Accounts, Xiaohongshu, V2EX, YouTube) and transient failures. Without an Exa key, these queries still run through keyless alternatives (Sogou, `sov2ex`, reader proxies). However, **an Exa key provides noticeably better coverage and speed on Chinese social platforms and YouTube**, so adding one is recommended if you search those often.

You can set `exaApiKey` in your config file or pass it via the `EXA_API_KEY` environment variable.

### Example Configuration

Save to `~/.pi/agent/web-search.json`:

```json
{
  "deepseekApiKey": "sk-...",
  "exaApiKey": "exa-...",
  "fetch": { "timeout": 45, "gapMs": 900 },
  "ssrf": { "allowRanges": ["198.18.0.0/15"] }
}
```

Config fields also accept shell commands:  
`"deepseekApiKey": "!jq -r .deepseek.key ~/.pi/agent/auth.json"`

> **Using a TUN / fake-IP proxy (Clash, Surge, sing-box)?**  
> Fake-IP proxies map external domain names into the `198.18.0.0/15` IP range. `pi-deepread` blocks private IP ranges by default to protect against SSRF. If your requests fail with a blocked internal address error, add `"ssrf": { "allowRanges": ["198.18.0.0/15"] }` to your config. Only enable this if your proxy actually uses that range.

---

## Reading Local Documents

Local files are parsed directly on your computer without uploading anything to external services:

| Format | Parser | Output |
|---|---|---|
| `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.epub`, `.csv` | [anymd](https://github.com/SylphxAI/anymd) | Clean Markdown with headings, tables, captions, and OCR |
| `.pdf` (when anymd is not installed) | `pdftotext` | Plain text fallback |
| Images / Audio / Subtitles | anymd | OCR text, file metadata, or embedded subtitles |
| Web pages | DeepSeek fetch | Markdown text, falls back to built-in HTTP reader |

### Installing Local Parsers (Optional)

```bash
# Recommended: structured Markdown converter
npm i -g @sylphx/anymd

# Only needed if you want OCR on images or scanned PDFs
brew install tesseract tesseract-lang
```

**Chinese OCR Shim:** By default, `anymd` runs `tesseract <image> stdout` without language flags, turning Chinese scans into garbled Latin text. `pi-deepread` ships with a transparent shim in `bin/tesseract` that automatically injects `-l chi_sim+eng` unless custom language arguments are provided (override with `ANYMD_TESS_LANGS`).

---

## Real-World Measurements

These numbers were measured locally on real web requests (not simulated; returned character counts reflect page length, not semantic correctness):

| Scenario | Result | What it means |
|---|---|---|
| `need_content: false` (standard API default) | ~431 chars | Short summary snippet only |
| `need_content: true` (this extension) | 3.7k–12.6k chars | Full extracted page text on the first search, still ¥0.005 |
| Fetch concurrency (6 different hosts) | 9.31 s → **1.85 s** | Per-host scheduling instead of an arbitrary global bottleneck |
| Same URL fetched twice | 7.04 s → **1 ms** | Instant in-session hot cache |
| Duplicate sites in 6 search hits | 1–3 duplicate hosts | Fetches 2 extra results, then removes duplicates and wire stories |
| arXiv abstract page | 6.44 s → **0.80 s** | Reads the HTML version (`/html/`) first when available |
| Paywalled articles (6 tested sites) | 0/6 → **5/6** with content | Reader proxy and Wayback Machine raced in parallel |
| 15-page arXiv PDF | anymd: 41k chars, 26 headings, 146 table rows (0.22 s) | `pdftotext`: 59k chars, 0 headings, broken columns (0.09 s) |
| Always-on prompt footprint (3 tools) | 5,896 → **3,494 chars** (~971 tokens) | Guidance lives inside tool results, not eating the system prompt |

Run `npm run check` for the offline test suite. To test against live APIs, run `WEB_BENCH_LIVE=1 node bench/scenarios.ts all` (may use API credits). See [testing and coverage](docs/TESTING.md) for test details.

---

## Practical Details & Edge Cases

- **128-character query limit**: DeepSeek counts search operators like `site:` and `after:` toward the 128-character cap. When a query exceeds the limit, `pi-deepread` trims it gracefully (dropping filters first, then truncating safely at word boundaries) and clearly reports what was adjusted, rather than failing the call.
- **Index blind spots**: WeChat Official Accounts (公众号), Xiaohongshu (小红书), and parts of V2EX aren't indexed well by DeepSeek, and YouTube links often resolve to music pages. With an Exa key, these queries route to Exa. Without one, they use keyless search routes (`sov2ex`, Sogou, reader proxies), merged with DeepSeek results. Any search hit that turns out to be a login wall is dropped automatically.
- **Paywalls and bot protections**: `fetch_content` tries DeepSeek first, then a direct fetch, then races a reader proxy and the Wayback Machine in parallel. It also checks page structure: pages that are mostly navigation, login prompts, or empty JavaScript shells are recognized as walls and rejected honestly, rather than pretending to have read the article.
- **Local cache**: Search and fetch results are cached in `<agent dir>/cache/web/`. The cache is cleaned up automatically on writes at most once per hour (keeping up to 7 days, 200 files, or 64 MB).
- **Diagnostics**: Run `/web-status` inside Pi to check resolved API keys, active routes, request timeouts, OCR shim detection, and local cache size.

---

## Development

```bash
git clone https://github.com/pumblus/pi-deepread
pi -e ./pi-deepread          # run extension directly from local checkout
```

The extension lives in a single file: [`extensions/web-access.ts`](extensions/web-access.ts).

Read [`docs/BUILD_LOG.md`](docs/BUILD_LOG.md) for the development story, debugging logs, and architecture tradeoffs.

---

## Credits & License

Inspired by [@Arcadia_Bao](https://x.com/Arcadia_Bao/article/2111711040757006401)'s benchmark on DeepSeek's `need_content: true` mode.

[MIT](LICENSE) © Eric Zhou

### Accuracy & Fair Use Notes

Search summaries and short excerpts are never treated as complete page reads. Full page reads are cached within the current session for instant reuse. When an archived snapshot is returned, its snapshot URL is clearly labeled. Audio and video files return available metadata or existing subtitle tracks; automated speech transcription requires separate tooling. All document conversions run locally on your machine.
