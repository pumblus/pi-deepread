# pi-deepread

Lightweight web search and document reading for [Pi](https://pi.dev) — one small extension, three tools, no provider zoo.

- **`web_search`** — DeepSeek `/v1/tools/search` with `need_content: true`, so every hit arrives with its **full extracted page text**, not a snippet.
- **`fetch_content`** — DeepSeek `/v1/tools/fetch` for pages; **local** conversion (anymd → pdftotext) for PDF/Office/EPUB/images/audio. Nothing is uploaded.
- **`get_search_content`** — every result is stored on disk with a `responseId`; page through it, or jump to passages with `findText`.

Exa is optional, and only used where DeepSeek's index is weak (公众号 / 小红书 / YouTube / V2EX / independent blogs), or when DeepSeek fails.

## Install

```bash
pi install npm:pi-deepread          # from npm (once published)
pi install /path/to/pi-deepread     # from a checkout
pi -e /path/to/pi-deepread          # try it for one run, no install
```

> Not on npm yet — install from the checkout until the first release is published.

Remove `pi-web-access` first if you have it: both register `web_search` / `fetch_content` / `get_search_content`, and they will collide.

```bash
pi remove npm:pi-web-access
```

## Credentials

Nothing to configure if Pi already has a DeepSeek key — `pi-deepread` reads it from Pi's `auth.json` at request time. Resolution order:

1. `deepseekApiKey` in `<agent dir>/web-search.json`
2. `DEEPSEEK_API_KEY` in the environment
3. Pi's own `auth.json` → `deepseek`

Exa uses `exaApiKey` in the same JSON file, or `EXA_API_KEY`. It is entirely optional.

```json
{
  "deepseekApiKey": "sk-...",
  "exaApiKey": "exa-...",
  "fetch": { "timeout": 45, "gapMs": 900 },
  "ssrf": { "allowRanges": ["198.18.0.0/15"] }
}
```

Key values may also be a command: `"deepseekApiKey": "!jq -r .deepseek.key ~/.pi/agent/auth.json"`.

> **On a machine behind a TUN / fake-IP proxy** (Clash, Surge, sing-box), every hostname resolves into `198.18.0.0/15`. `pi-deepread` refuses private addresses to protect against SSRF, so ordinary sites look "internal". Add `ssrf.allowRanges: ["198.18.0.0/15"]` and it works again. Only do that if your proxy really owns that range.

## Documents are parsed locally

| Input | Path |
|---|---|
| `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.epub`, `.csv`, … | [anymd](https://github.com/SylphxAI/anymd) → Markdown (headings, pipe tables, figure captions, OCR) |
| PDF where anymd is unavailable | `pdftotext` |
| images / audio / subtitles | anymd (OCR / transcript) |
| anything else | DeepSeek fetch, then a plain HTTP reader |

```bash
npm i -g @sylphx/anymd        # optional, strongly recommended
brew install tesseract tesseract-lang   # only for OCR (Chinese needs the lang pack)
```

`bin/tesseract` ships with this package: anymd calls `tesseract <image> stdout` without `-l`, which made Chinese scans come out as garbage Latin. The shim adds `-l chi_sim+eng` (override with `ANYMD_TESS_LANGS`, or point `ANYMD_SHIM_DIR` at another shim directory).

anymd's own URL mode is disabled on TUN-proxy machines too — `pi-deepread` always downloads to a temp file first (30 MB cap), so that limitation never applies.

## Measured, not claimed

| Operation | Result |
|---|---|
| `need_content: false` (old default) | 431-char summary, no body |
| `need_content: true` | 3.7k–12.6k chars per hit, same ¥0.005/request |
| query length | hard cap 128 chars — `HTTP 400 'query' must be at most 128 characters` |
| fetch concurrency | 1–3 is clean; 10 threads → ~30% `HTTP 429` |
| `fetch_content` with 4 URLs | 5.71 s serial → **2.85 s** at concurrency 3 |
| `web_search` with 3 query variants | ~1.2 s serial → **0.45 s** |
| arXiv PDF (15 pages) | anymd 41k chars with 26 headings + 146 table rows, 0.22 s; pdftotext 59k chars, 0 headings, 0.09 s |

## Limits worth knowing

- **128-char query cap** is enforced after `domainFilter` / `recencyFilter` are compiled into `site:` / `after:` operators. Over the cap, the query goes to Exa instead (when a key is set), or errors with the composed query in the message.
- **Blind spots** — WeChat 公众号, 小红书, and much of V2EX are not in DeepSeek's index; YouTube results often land on `music.youtube.com`. With an Exa key those queries route to Exa automatically.
- **Cache** — `<agent dir>/cache/web/` keeps 7 days / 200 files / 64 MB; prune runs hourly.
- **`/web-status`** prints which keys resolved, the current timeouts, the OCR shim path, and cache usage.

## Development

```bash
git clone https://github.com/pumblus/pi-deepread
pi -e ./pi-deepread          # load the checkout directly, no install
```

The extension is a single file: [`extensions/web-access.ts`](extensions/web-access.ts). See [`docs/BUILD_LOG.md`](https://github.com/pumblus/pi-deepread/blob/main/docs/BUILD_LOG.md) (Chinese) for why every piece is the way it is — the debugging trail behind `need_content`, the 128-char limit, the 429 wall and the OCR shim.

MIT © Eric Zhou
