# How I Built pi-deepread: From a Single Tweet to a Single-File Extension

English | [简体中文](BUILD_LOG_zh-CN.md)

> This isn't a tutorial. It's an honest diary of what I set out to build, where my assumptions fell flat, and why the extension ended up the way it is. Most of the code was written with AI assistance; the requirements, debugging, tradeoffs, and verification were mine. All numbers were measured directly on my machine.

---

## The Spark: Why Make Two Requests When Search Can Return Full Text?

It started when I came across [@Arcadia_Bao's post](https://x.com/Arcadia_Bao/article/2111711040757006401) benchmarking DeepSeek's Search and Fetch APIs. One observation immediately jumped out at me:

> You should always turn on `need_content: true`. There is no extra charge—it still costs ¥0.005 per query.

That meant a single search request could return not just titles and snippets, but the **full extracted page text** for every hit. In actual tests, that meant 3.7k to 12.6k characters per result, and nearly 30,000 characters for an arXiv page.

At the time, my daily driver was `pi-web-access`. Its workflow followed the classic "search snippet, then fetch" dance: a search returns a handful of 800-character snippets, the model decides it doesn't have enough context, and it makes another tool call to fetch the page. Two network roundtrips, double the latency. If search could hand back the full page on round one, most "search-then-fetch" roundtrips wouldn't need to happen at all.

Existing extensions didn't enable that flag. So I decided to build my own.

---

## Day One: Slamming Straight into the TUN Proxy Wall

I threw together a quick prototype, ran a fetch test, and was immediately slapped in the face with a bright red error in my terminal:

```text
Error: Blocked internal address for x.com: 198.18.0.14.
This address is in 198.18.0.0/15, commonly used by TUN/fake-IP proxies.
```

My first reaction was that my SSRF validation logic was completely broken. How on earth could `x.com` count as an internal private IP address?

Then the penny dropped: my machine runs a TUN-mode proxy (Clash/Surge). In transparent fake-IP mode, DNS queries are intercepted and mapped to the reserved `198.18.0.0/15` pool; actual routing happens under the hood by domain name. Meanwhile, to stop rogue web pages from tricking the agent into querying cloud metadata (like `169.254.169.254`) or local network services, my extension blocked all reserved subnets. `198.18.0.0/15` was caught right in the crosshairs.

The fix was a simple opt-in config:

```json
{
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"]
  }
}
```

The tradeoff here is worth being candid about: adding this line tells the tool "trust this subnet to be handled by the proxy." In a TUN setup, that's completely safe. But if you take your laptop off that proxy, that exception becomes a real opening. That's why it is strictly opt-in and will never be enabled by default.

---

## Probing with curl: What the Docs Never Mentioned

With the proxy config sorted out, I tried fetching the original tweet. `x.com` promptly returned an `HTTP 403`. So I tried passing it through `r.jina.ai`, and ran smack into Jina's abuse blacklist:

```json
{"code":403,"name":"AbuseAlleviationError","message":"Anonymous access to domain x.com blocked until Sun Oct 18 2026..."}
```

I ended up having to ask a friend to copy-paste the text of the tweet for me in a DM.

That little detour was a good wake-up call: web fetch failures generally happen at three different layers:
1. **Network layer** (timeouts, 429 rate limits).
2. **Target site layer** (403 forbidden, paywalls, login screens).
3. **Proxy layer** (quotas and domain blacklists on public proxies like Jina).

The third layer is the most frustrating, because it easily tricks you into second-guessing your own local code when your code is completely innocent.

To avoid running into more unseen landmines, I decided to stop writing extension code and test DeepSeek's raw API endpoints with plain `curl`. That turned out to be the smartest call I made:

### 1. `need_content` is off by default

Calling the raw search endpoint without `need_content`:

```text
content_len = 0
summary_len = 431
```

You get a 431-character summary and zero page body. Once you pass `need_content: true`:

```text
content_len = 3739 / 12614
authority = 3, rerank_score ≈ 2.19
```

Each hit suddenly comes with thousands of characters of extracted text. If I hadn't verified this with curl first, searches would have returned titles and URLs, everything would look functional on the surface, but the agent would secretly receive only short summaries. I would have spent days wondering why DeepSeek wasn't returning full text.

DeepSeek also provides two native fields in the response: `authority` (0–4, ≥3 is authoritative) and `rerank_score` (0–3, ≥1.5 is high quality). They come directly from the API, so there is no need to invent local ranking heuristics.

### 2. The 128-character hard cap and query operators

I initially thought I was being clever by compiling `domainFilter` and `recencyFilter` into `site:` and `after:` operators right inside the query string. It felt cleaner than managing extra parameters. Then a slightly wordy query blew up:

```text
HTTP 400 {"error":{"message":"'query' must be at most 128 characters (request_id: ...)"}}
```

Turns out DeepSeek measures the length of the *final compiled query string*. Filter operators eat directly into that 128-character limit.

The fix: measure the query length after compilation. If it exceeds 128 characters and an Exa key is configured, hand the entire query to Exa (which doesn't have this limit). If no Exa key is set, fail immediately—but include the full compiled query string directly in the error message so you can see right away what caused it to spill over.

Putting the full context into error messages saved me countless hours of head-scratching.

### 3. Concurrency: 10 threads trigger 429s, 3 threads run clean

At 10 concurrent requests, roughly 30% of calls got slapped with `HTTP 429` within 600ms.

Even though 429 responses aren't billed, the exponential backoff penalty kills responsiveness.

My first version ran purely sequentially with a 900ms delay between requests. It was rock-solid, but fetching 4 URLs took nearly 6 seconds—most of it spent staring at sleep timers.

The sweet spot was **3 concurrency slots with a staggered launch delay of gap/3 (300ms)**:
- At most 3 requests in flight at once (well below the rate-limit threshold).
- New requests are staggered 300ms apart.

Fetching 4 URLs dropped from 5.71 seconds to **2.85 seconds**, with zero 429s.

---

## The Temptation: Why Not Just Patch Someone Else's Minified Code?

While inspecting `pi-web-access`, I found the culprit line where DeepSeek search results were being sliced:

```javascript
snippet: (text4(entry.summary) || text4(entry.snippet)).slice(0, MAX_SNIPPET_CHARS4)
// MAX_SNIPPET_CHARS4 = 800
```

And `need_content` was nowhere in the request body (`grep -c need_content dist/index.js` returned 0). Upstream issue #582 had been sitting open with no activity.

I was genuinely tempted to take the quick way out: open the installed bundle, change 800 to 8000, and call it a day. I tested it with `node --check`, and it actually worked!

Then common sense kicked in:

1. The next package update would wipe my patch immediately.
2. Hacking a 1MB minified bundle is pure agony the moment something breaks.
3. Most importantly, my real goal wasn't just inflating a snippet size from 800 to 8,000 characters. I wanted search results cached on disk by `responseId`, clean pagination, and a `findText` tool so the model could jump straight to relevant sections without blowing its context window.

So I chose to write a clean extension from scratch: 1,300 lines of TypeScript, a single file, and zero runtime dependencies. Looking back, that was definitely the right move.

---

## Local Document Parsing: anymd and the Second SSRF Trap

Web pages can be fetched through DeepSeek, but what if a user asks Pi to read a local PDF, Word doc, spreadsheet, EPUB, image, or audio recording? I was adamant about one thing: sensitive local files should never be uploaded to external APIs. Everything had to be processed 100% on the user's machine.

I picked [anymd](https://github.com/SylphxAI/anymd). It converts a wide variety of formats into clean Markdown. It even supports URLs directly, so I initially tried passing web URLs straight to it to avoid a separate download step:

```text
anymd: https://arxiv.org/pdf/1706.03762: URL host 'arxiv.org' resolves to a non-public address (SSRF protection).
```

The exact same TUN proxy issue, round two! But unlike my own code, `anymd` is a precompiled Rust binary. Searching its strings confirmed there were no configuration flags or environment variables to disable its internal SSRF checks.

The solution: **always download the file to a temporary local file first, then pass the file path to anymd**. This neatly sidesteps `anymd`'s SSRF checks, lets me enforce a hard 30MB file size limit, and guarantees temp files get cleaned up automatically.

There was a sneaky memory gotcha here too: my first version used `arrayBuffer()` to read 30MB into memory before writing to disk. With 3 concurrent downloads, memory spiked by 90MB. Switching to Node.js stream pipelines flattened peak memory usage down to a few kilobytes.

---

## Chinese Scanned PDFs: A 12-Line Shell Shim

Once file parsing was working, Chinese OCR fell apart. `anymd` calls Tesseract via `tesseract <image> stdout` without a `-l` flag, which defaults to English. Scanned Chinese documents came out as lines of garbled Latin letters.

Forking `anymd` and compiling Rust felt like massive overkill for what amounted to missing CLI flags. Instead, I wrote a 12-line shell wrapper and placed it in front of system binaries in `PATH`:

```bash
#!/bin/bash
REAL=/opt/homebrew/bin/tesseract
for arg in "$@"; do
  case "$arg" in
    -l|--oem|--psm) exec "$REAL" "$@" ;;
  esac
done
exec "$REAL" -l "${ANYMD_TESS_LANGS:-chi_sim+eng}" "$@"
```

If the caller passes any language or mode flags, the shim steps aside and forwards the call untouched. If not, it injects `-l chi_sim+eng`. The shim lives in `bin/tesseract` in this repository—install `tesseract-lang`, and Chinese OCR works without touching anything else.

---

## Benchmarking: Is Structured Markdown Actually Worth It?

To make sure `anymd` wasn't just vanity complexity, I ran benchmarks on two papers: the 15-page *Attention Is All You Need* and the 75-page *GPT-3* paper:

| Tool | Chars Extracted | Headings | Table Rows | Hyphenation Errors | Bad Glyphs | Time |
|---|---|---|---|---|---|---|
| anymd | 41,026 | **26** | **146** | 0 | 0 | 0.22s |
| pdftotext -layout | 59,444 | 0 | 0 | 16 | 15 | 0.09s |
| pdftotext (raw) | 39,919 | 0 | 0 | 0 | 15 | 0.11s |
| mutool -F txt | 40,067 | 0 | 0 | 16 | 16 | 0.14s |

The numbers revealed something crucial: **their failure modes are completely different**.

- Traditional command-line tools dump an unstructured stream of text. On two-column academic papers, sentences from the left and right columns frequently interleave, and more than 60% of lines end up as broken, truncated fragments. An LLM trying to read that has to spend half its capacity unscrambling syntax.
- `anymd` preserves the semantic hierarchy: clean heading structures (`## 3 Model Architecture` → `### 3.1 Encoder and Decoder Stacks`), tables formatted as clean Markdown pipe tables, and figures labeled with captions and page numbers.
- The tradeoff is a 2x time penalty (0.22s vs 0.09s) and occasional column alignment quirks in complex tables. For an agent reading technical documents, that's a trade I'll make every day.

Neither tool solves mathematical formulas: equations still turn into things like `Attention(Q, K, V ) = softmax( √ )V (1) d_k`, where square root symbols lose their placement. That's a fundamental limitation of how PDF font glyphs are positioned on a page, not something a text converter can magically repair.

---

## Packaging and the `import.meta.url` Surprise

During local development with a symlink in `~/.pi/agent/extensions/`, `import.meta.url` resolved the sibling `bin/tesseract` shim without a hitch.

Once I packaged it for npm and tested it via `pi -e`, it suddenly threw an error:

```text
[pi-deepread] shim:  exists: false
```

Turns out Pi uses `jiti` under the hood to load extensions, compiling modules into CommonJS at runtime. In that environment, `import.meta` is an empty object.

The fix was a layered fallback: check `import.meta.url` first (for ESM), fall back to `eval("typeof __dirname === 'string' ? __dirname : ''")` (for CJS), and if neither works, gracefully skip injecting the shim.

**Graceful degradation should be silent.** Missing an optional OCR helper should never crash the core search functionality.

---

## Features I Intentionally Left Out

A few features looked attractive early on, but I cut them after weighing the maintenance cost:

- **YouTube transcript scraping**: DeepSeek search results for YouTube frequently resolve to `music.youtube.com`, requiring annoying URL normalization heuristics for very little payoff.
- **Image search**: Almost never needed in an agent primarily focused on coding and documentation.
- **gzip compression for cached responses**: Compressing saves ~70% disk space, but requires decompression overhead on every read and adds latency. A straightforward LRU cleanup policy (7 days / 200 files / 64MB) keeps disk usage in check without the added complexity.

Interestingly, two items that were originally cut came back after I actually started measuring things—see Round 2 below: the in-session URL cache and per-host concurrency.

---

## Round 2: What Happened When I Actually Measured Everything

A month after release, the extension was sitting at around 270 monthly downloads without any promotion. Knowing real people were relying on it gave me the kick I needed: stop adding new features, and actually measure what was already there. I built `bench/`—a real benchmark harness that loads the extension through Pi's actual runtime loader, so every single number below is a measured API call, not an estimate.

Because the harness imports the extension exactly the way Pi does, it needs Pi's own `node_modules` on the path: `ln -s ~/.pi/agent/install/releases/<version>/node_modules node_modules`, then `node bench/prompt-surface.ts` or `node bench/scenarios.ts [p0|p1|p2]`. (The symlink is local-only and not tracked in git.)

| What | Before | After | Why it changed |
| --- | --- | --- | --- |
| Always-on prompt surface | 5,896 chars / 1,638 tok | 3,494 chars / 971 tok | Behavior moved out of the system prompt and into tool outputs |
| Paywalled pages returning content | 0 of 6 | 5 of 6 | Reader proxy and Wayback Machine raced in parallel |
| Browser-only rendered page | 12 s timeout, then failure | 2.8 s, 53 KB | The extractor was fine; the fetch strategy was wrong |
| arXiv abstract page | 6,436 ms | 804 ms | Fetch the HTML version (`/html/`) first when it exists |
| arXiv paper with no HTML version | 5,955 ms | 273 ms | Stop trying HTML when the paper predates arXiv's HTML renderer |
| Six concurrent fetches | 9,314 ms | 2,727 ms | Per-host scheduling instead of an arbitrary global ceiling of 3 |
| Re-fetching the same URL | 7,042 ms | 1 ms | In-session hot cache |
| Local PDF for the agent | Failed with "Blocked internal address" | 143 ms of extracted text | A file path is a local source, not a network URL |
| Wikipedia markdown | 105 KB with 4 junk lines | 100 KB with 1 | Boilerplate stripping scoped to `<article>` and `<main>` |
| 163-char query with filters | Hard error | 617 ms, results returned | Trim the query intelligently instead of failing the call |
| 5 hits × 6,000 chars | 3 of 5 hits had text | 5 of 5 | Reserve a per-hit floor in the character budget |
| Duplicate sites in 6-hit answer | 1–3 repeated hosts | 0–1, slot count unchanged | Over-fetch 2 extra results, then drop duplicate URLs, extra host hits, and wire copies |
| JS shell disguised as content | 123 chars of Weibo navigation | Detected as a wall | "No long prose lines + mostly navigation" is far more reliable than keyword matching |

Three lessons that weren't in the original build log:

**The system prompt is the invisible tax nobody benchmarks.** 1,638 tokens of prompt surface was being charged on every single turn of every conversation, whether the user searched the web or just asked "how do I exit vim." Most of those instructions only mattered *after* a search result was returned to the model. Moving that guidance into the tool's output brought the prompt footprint down to under 1,000 tokens (~3,500 characters). The rule: a tool description should describe what the tool *is*, not lecture the model on how to be a better user.

**"Add a fallback" and "try again harder" are totally different designs.** In my first pass at paywall handling, if the primary fetch failed, it tried a fallback—which effectively doubled latency on every broken page. Racing the reader proxy and the Wayback Machine in parallel turned a 12-second timeout into a 2.8-second answer, using the exact same code.

**The things you guessed wrong deserve a headline, not a footnote.** I cut the in-session cache in v0.1 because I assumed "agents rarely fetch the same URL twice." They do—after context compaction, when re-reading documentation, or when multiple search hits point to different sections of the same site. And my global concurrency cap of 3 was silly: it serialized fetches to *different* hosts that had no risk of rate-limiting each other. Both features are now in, and both gave 1–2 orders of magnitude improvements over the version that "avoided complexity."

---

## Hard-Earned Rules of Thumb

If you're building tool extensions for coding agents:

1. **Probe with curl before writing code.** Don't rely on assumptions or documentation that might be outdated. Verify raw payloads, error responses, and default values first.
2. **Include full context in error messages.** If a query is too long, print the compiled query. If a fetch fails, print the URL and the failure tier. You'll save hours of debugging.
3. **Core failures should shout; optional features should degrade silently.** If DeepSeek fails, make sure the user knows it fell back to Exa. If the OCR shim is missing, just report it quietly in `/web-status`.
4. **Never patch vendor bundles.**
5. **Measure and record numbers as you build.** Not to show off in a README, but so that a week later you have an objective baseline to know whether your latest tweak actually helped or hurt.
