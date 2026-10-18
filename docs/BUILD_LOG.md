# How I Built pi-deepread: From a Single Tweet to a 1,300-Line Extension

English | [简体中文](BUILD_LOG_zh-CN.md)

> This isn't a tutorial. It's a candid log of what I wanted to build, what I guessed wrong, and why the extension ended up the way it is. Most of the code was written with AI assistance; the requirements, debugging, tradeoffs, and verification were mine. All numbers are measured on my local machine.

---

## The Spark: Why Make Two Requests When Search Can Return Full Text?

It started with [@Arcadia_Bao's post](https://x.com/Arcadia_Bao/article/2111711040757006401) benchmarking DeepSeek's Search and Fetch APIs. One observation immediately stood out:

> You should always turn on `need_content: true`. There is no extra charge—it still costs ¥0.005 per query.

That means a single search request returns not just titles and snippets, but the **full extracted page text** for every hit. In actual tests, that was 3.7k to 12.6k characters per result, and nearly 30,000 characters for an arXiv page.

At the time, I was using `pi-web-access`. Its workflow followed the classic "search snippet, then fetch" pattern: search returns a few 800-character snippets, the model decides it doesn't have enough context, and it makes another tool call to fetch the page. Two network roundtrips, double the latency. If search could hand back the full page right away, most "search-then-fetch" roundtrips wouldn't need to happen at all.

Existing extensions didn't enable that flag. So I decided to build one.

---

## Hitting a Wall on Day One: TUN Proxies and Fake-IP Collisions

I wrote a quick prototype, ran a fetch test, and immediately got slapped with a red error:

```text
Error: Blocked internal address for x.com: 198.18.0.14.
This address is in 198.18.0.0/15, commonly used by TUN/fake-IP proxies.
```

My first reaction was that my SSRF validation logic was broken. How on earth could `x.com` be an internal address?

Then I checked my network setup. I run a TUN-mode proxy (Clash/Surge). To handle transparent routing, the proxy intercepts DNS queries and hands out fake IPs from the reserved `198.18.0.0/15` pool; actual traffic is routed by domain name under the hood. Meanwhile, the extension blocks reserved subnets to stop rogue web pages from tricking the agent into querying cloud metadata (like `169.254.169.254`) or local services. `198.18.0.0/15` was right in the blacklist.

The fix was straightforward—adding an opt-in config:

```json
{
  "ssrf": {
    "allowRanges": ["198.18.0.0/15"]
  }
}
```

The tradeoff here is important: adding this line tells the tool "trust this subnet to be handled by the proxy." Behind a TUN proxy, that's safe. But if you move off that proxy, that exemption becomes an actual hole. That's why it is strictly opt-in and will never be a default setting.

---

## Probing with curl: What the Docs Didn't Tell Me

After fixing the proxy config, I tried fetching the original tweet. `x.com` returned an `HTTP 403`. I tried routing it through `r.jina.ai`, and ran straight into Jina's domain block:

```json
{"code":403,"name":"AbuseAlleviationError","message":"Anonymous access to domain x.com blocked until Sun Oct 18 2026..."}
```

In the end, I had to ask a friend to copy-paste the text for me.

That failure was a good reminder: fetching failures fall into three distinct tiers—network issues (timeouts, 429s), target site blocks (403s, paywalls, login walls), and third-party proxy blocks (Jina's own blacklists). It's easy to waste hours debugging local code when the problem is actually at the third tier.

Before writing more extension code, I decided to test DeepSeek's raw API directly using curl. That turned out to be the best decision of the project:

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

Each hit suddenly comes with thousands of characters of extracted text. If I had jumped straight into writing the extension without curling first, searches would have returned titles and URLs, everything would look like it worked, but the agent would receive only short summaries. I would have spent days wondering why DeepSeek wasn't returning full text.

DeepSeek also provides two native fields in the response: `authority` (0–4, ≥3 is authoritative) and `rerank_score` (0–3, ≥1.5 is high quality). They come directly from the API, so there is no need to compute ranking scores locally.

### 2. The 128-character hard cap and query operators

I initially thought it would be neat to compile `domainFilter` and `recencyFilter` into `site:` and `after:` operators inside the search `query`. It saved an extra parameter and felt clean. Then a slightly detailed query blew up:

```text
HTTP 400 {"error":{"message":"'query' must be at most 128 characters (request_id: ...)"}}
```

DeepSeek measures the total character length of the final query string after operators are appended. Operators eat directly into that 128-character limit.

The solution: measure the query length after compilation. If it exceeds 128 characters and an Exa key is configured, hand the entire query to Exa (which doesn't have this limit). If no Exa key is set, fail immediately, but include the compiled query string directly in the error message.

Putting the full context into the error message saved me countless hours—you see right away what caused the query to spill over.

### 3. Concurrency: 10 threads trigger 429s, 3 threads run clean

My benchmarks showed that at 10 concurrent requests, roughly 30% of calls returned `HTTP 429` within 0.6 seconds.

Even though 429 responses aren't billed, the backoff-and-retry penalty kills user responsiveness.

My first version ran purely serially with a 900ms delay between requests. It was bulletproof, but fetching 4 URLs took nearly 6 seconds, mostly spent waiting on timers.

The final setup uses **3 concurrency slots with a staggered launch delay of gap/3 (300ms)**:
- At most 3 requests in flight at once (well below the rate-limit threshold).
- New requests are staggered 300ms apart.

Fetching 4 URLs dropped from 5.71 seconds to **2.85 seconds**, with zero 429s.

---

## The Temptation: Why Not Just Patch Someone Else's Bundle?

While inspecting `pi-web-access`, I found where DeepSeek search results were being sliced:

```javascript
snippet: (text4(entry.summary) || text4(entry.snippet)).slice(0, MAX_SNIPPET_CHARS4)
// MAX_SNIPPET_CHARS4 = 800
```

And `need_content` was nowhere in the request body (`grep -c need_content dist/index.js` returned 0). Upstream issue #582 was open with no activity.

I briefly considered patching the installed bundle: replace 800 with 8000. `node --check` passed, and it worked. But thinking it through made me stop:

1. The next package update would wipe the patch immediately.
2. Hacking a 1MB minified bundle is a maintenance nightmare whenever something breaks.
3. More importantly, my goal wasn't just increasing a snippet cap from 800 to 8000. I wanted responses saved to disk, pagination, and a way to jump straight to passages with `findText`.

So I chose to write a fresh extension: 1,300 lines of TypeScript, a single file, and zero runtime dependencies. Looking back, that was the best call I made.

---

## Local Document Parsing: anymd and the Second SSRF Trap

Web pages can be fetched through DeepSeek, but what if a user asks to read a local PDF, DOCX, spreadsheet, EPUB, image, or audio recording? I didn't want sensitive local files sent to external APIs. Everything had to be converted locally.

I picked [anymd](https://github.com/SylphxAI/anymd). It converts a wide variety of formats into clean Markdown. It supports URLs directly, so I tried passing web URLs straight to it to avoid a separate download step:

```text
anymd: https://arxiv.org/pdf/1706.03762: URL host 'arxiv.org' resolves to a non-public address (SSRF protection).
```

Same root cause: the TUN proxy resolved `arxiv.org` to `198.18.7.138`. But unlike my code, anymd is a precompiled Rust binary. Searching its strings showed no flags or environment variables to disable its SSRF checks.

The fix: **always download to a local temporary file first, then pass the file path to anymd**. This bypasses anymd's SSRF checks, lets me enforce a 30MB file size cap, and ensures temp files get cleaned up automatically.

There was a memory trap here, too: my first pass used `arrayBuffer()` to read 30MB into memory before writing to disk. With 3 concurrent downloads, memory spiked to 90MB. Switching to Node.js stream pipelines dropped peak memory down to tens of kilobytes.

---

## Chinese Scanned PDFs: A 12-Line Shell Shim

Once files parsed properly, Chinese OCR broke. anymd invokes tesseract via `tesseract <image> stdout` without a `-l` flag, which defaults to English. Scanned Chinese documents came out as strings of nonsensical Latin characters.

Instead of forking anymd and recompiling Rust, I wrote a 12-line shell shim and placed it ahead of system binaries in `PATH`:

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

If the caller specifies a language flag, the shim forwards the call untouched. If not, it injects `-l chi_sim+eng`. The shim ships in `bin/tesseract` with this package—install `tesseract-lang`, and Chinese OCR works out of the box.

---

## Benchmarking: Is Structured Markdown Actually Worth It?

To verify that anymd wasn't just unnecessary complexity, I ran benchmarks on two papers: the 15-page *Attention Is All You Need* and the 75-page *GPT-3* paper:

| Tool | Chars Extracted | Headings | Table Rows | Hyphenation Errors | Bad Glyphs | Time |
|---|---|---|---|---|---|---|
| anymd | 41,026 | **26** | **146** | 0 | 0 | 0.22s |
| pdftotext -layout | 59,444 | 0 | 0 | 16 | 15 | 0.09s |
| pdftotext (raw) | 39,919 | 0 | 0 | 0 | 15 | 0.11s |
| mutool -F txt | 40,067 | 0 | 0 | 16 | 16 | 0.14s |

The results showed that **their failure modes are completely different**:

- Traditional tools output an unstructured text stream. On dual-column papers, sentences from left and right columns frequently interleave, and over 60% of lines are broken short fragments. Models struggle to read this.
- anymd preserves document structure: clean heading hierarchies (`## 3 Model Architecture` → `### 3.1 Encoder and Decoder Stacks`), tables formatted as Markdown pipe tables, and figures tagged with captions and page numbers.
- The cost is a 2x slowdown (0.22s vs 0.09s) and occasional table column alignment glitches.

Neither tool solves mathematical formulas: equations come out like `Attention(Q, K, V ) = softmax( √ )V (1) d_k`, where root symbols lose their placement. That is an inherent limitation of font glyph positioning in PDFs, not something a text converter can fix.

---

## Packaging and the `import.meta.url` Quirk

During local testing with a symlink in `~/.pi/agent/extensions/`, `import.meta.url` resolved the sibling `bin/tesseract` shim cleanly.

Once packaged for npm and run via `pi -e`, it suddenly failed:

```text
[pi-deepread] shim:  exists: false
```

Pi uses jiti to load extensions, which converts modules into CommonJS at runtime. In that environment, `import.meta` is an empty object.

The fix was a layered fallback: first check `import.meta.url` (ESM mode), then fall back to `eval("typeof __dirname === 'string' ? __dirname : ''")` (CJS mode). If both fail, silently skip injecting the shim.

**Graceful degradation should be silent.** Missing an optional OCR shim shouldn't crash the entire core search extension.

---

## Features I Intentionally Left Out

A few features were considered early on, but cut after evaluating the tradeoffs:

- **YouTube transcript scraping**: DeepSeek search results for YouTube frequently point to `music.youtube.com`, requiring specialized link-parsing gymnastics for minimal gain.
- **Image search**: Rarely needed when using a coding assistant.
- **gzip compression for cached responses**: Compressing saves ~70% disk space, but requires decompression logic on every read and adds latency. A plain-text LRU policy (7 days / 200 files / 64MB) keeps disk usage well within bounds without the complexity.
- **In-session URL memory cache**: Sounds good to avoid duplicate fetches, but risks serving stale content. Agents rarely fetch the exact same URL twice in a single session, so the complexity isn't worth it.
- **Concurrency higher than 3**: Higher concurrency saves modest fractions of a second while dramatically increasing the probability of `HTTP 429` rate limits. 3 is the sweet spot.

---

## Takeaways for Building Tool Extensions

If you're building similar extensions for coding agents:

1. **Test with curl before writing code.** Don't trust assumptions or skimmed documentation. Verify real payloads, error responses, and defaults first.
2. **Include full context in error messages.** If a query is too long, print the compiled query. If a fetch fails, print the URL and error tier. You will save 90% of your debugging time.
3. **Core failures should shout; optional features should degrade silently.** If DeepSeek fails, make sure the user knows it fell back to Exa. If the OCR shim is missing, just report it in `/web-status`.
4. **Never patch vendor bundles.**
5. **Record numbers while you test.** Not for presentation slides, but so that three days later you have an objective baseline to know whether performance actually degraded.
