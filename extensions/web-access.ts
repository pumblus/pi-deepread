/**
 * pi-deepread — lightweight, full-text web search and document reading for Pi.
 *
 * Built on the two endpoints recommended by
 * https://x.com/Arcadia_Bao/article/2111711040757006401 :
 *   POST /v1/tools/search  with `need_content: true`  → search + extracted page text
 *   POST /v1/tools/fetch                              → single-page extraction
 * Exa is an optional second engine for DeepSeek's blind spots
 * (微信公众号 / 小红书 / YouTube / V2EX / 独立博客).
 *
 * Documents (PDF/Office/EPUB/images/audio) are converted locally by anymd, with pdftotext
 * as the fallback — nothing is uploaded, and `bin/tesseract` adds Chinese OCR to anymd.
 *
 * Tools: web_search · fetch_content · get_search_content   Command: /web-status
 * Config: <agent dir>/web-search.json → { deepseekApiKey, exaApiKey, fetch: { timeout, gapMs },
 *         ssrf: { allowRanges } }; key values may be "!<shell command>", and the env vars
 *         DEEPSEEK_API_KEY / EXA_API_KEY override nothing but act as fallbacks.
 */

import { execFile, execSync } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------- constants

const DS_BASE = "https://api.deepseek.com";
const EXA_SEARCH = "https://api.exa.ai/search";
const DS_QUERY_LIMIT = 128; // hard API limit, returns 400 above this
const DS_SEARCH_TIMEOUT_MS = 30_000;
const DS_FETCH_TIMEOUT_MS = 35_000;
const FETCH_GAP_MS = Math.max(0, Number(process.env.WEB_FETCH_GAP_MS ?? 900) || 0);
const MAX_RESULTS = 10;
const MAX_URLS = 10;
const SEARCH_CHARS_DEFAULT = 1200;
const SEARCH_CHARS_TOTAL = 12_000;
const FETCH_CHARS_DEFAULT = 4_000;
const CACHE_KEEP_DAYS = 7;
const CACHE_KEEP_FILES = 200;
const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const PDF_MAX_BYTES = 30 * 1024 * 1024;

/** Domains DeepSeek does not index well, per the article's measurement table. */
const BLIND_SPOT = /mp\.weixin\.qq\.com|公众号|xiaohongshu\.com|小红书|youtube\.com|youtu\.be|v2ex\.com/i;

// ------------------------------------------------------------------- config

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

interface LiteConfig {
	deepseekApiKey?: string;
	exaApiKey?: string;
	fetchTimeout?: number;
	gapMs?: number;
	allowRanges?: string[];
}

let cachedConfig: LiteConfig | undefined;

function config(): LiteConfig {
	if (cachedConfig) return cachedConfig;
	let out: LiteConfig = {};
	try {
		const parsed = JSON.parse(readFileSync(join(agentDir(), "web-search.json"), "utf8")) as Record<string, any>;
		const fetchBlock = parsed.fetch ?? {};
		out = {
			deepseekApiKey: parsed.deepseekApiKey,
			exaApiKey: parsed.exaApiKey,
			fetchTimeout: typeof fetchBlock.timeout === "number" ? fetchBlock.timeout * 1000 : undefined,
			gapMs: typeof fetchBlock.gapMs === "number" ? fetchBlock.gapMs : undefined,
			allowRanges: Array.isArray(parsed.ssrf?.allowRanges) ? parsed.ssrf.allowRanges : undefined,
		};
	} catch {
		// no config file: fall back to env + auth.json below
	}
	cachedConfig = out;
	return out;
}

/** Resolve a config key: literal value, "!<command>" substitution, or env fallback. */
/** Resolve a config key: literal value, "!<command>" substitution, or env fallback.
 *  Memoized for 10 min — otherwise every call shelled out to `jq` (10-20 ms of blocked loop). */
const KEY_TTL_MS = 10 * 60_000;
const keyMemo = new Map<string, { value: string; at: number }>();

function resolveKey(value: unknown, envName: string): string | undefined {
	const memo = `${envName}\u0000${typeof value === "string" ? value : ""}`;
	const hit = keyMemo.get(memo);
	if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.value || undefined;
	const resolved = resolveKeyUncached(value, envName) ?? "";
	keyMemo.set(memo, { value: resolved, at: Date.now() });
	return resolved || undefined;
}

function resolveKeyUncached(value: unknown, envName: string): string | undefined {
	if (typeof value === "string" && value.trim()) {
		const raw = value.trim();
		if (!raw.startsWith("!")) return raw;
		try {
			const out = execSync(raw.slice(1), { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
			const key = out.trim();
			if (key) return key;
		} catch {
			// fall through to env
		}
	}
	const env = process.env[envName];
	return env && env.trim() ? env.trim() : undefined;
}

function deepseekKey(): string | undefined {
	const direct = resolveKey(config().deepseekApiKey, "DEEPSEEK_API_KEY");
	if (direct) return direct;
	try {
		const auth = JSON.parse(readFileSync(join(agentDir(), "auth.json"), "utf8")) as Record<string, any>;
		const raw = auth.deepseek;
		const key = typeof raw === "string" ? raw : (raw?.key ?? raw?.apiKey ?? raw?.access_token);
		return typeof key === "string" && key.trim() ? key.trim() : undefined;
	} catch {
		return undefined;
	}
}

function exaKey(): string | undefined {
	return resolveKey(config().exaApiKey, "EXA_API_KEY");
}

function fetchGapMs(): number {
	return Math.max(0, config().gapMs ?? FETCH_GAP_MS);
}

function fetchTimeoutMs(): number {
	return config().fetchTimeout ?? DS_FETCH_TIMEOUT_MS;
}

// ------------------------------------------------------------------ helpers

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let counterValue = 0;
const counter = () => counterValue++;
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const num = (value: number): string => value.toLocaleString("en-US");

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.min(max, Math.max(min, n));
}

function nowStamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isPrivateHost(host: string): boolean {
	const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (bare === "localhost" || bare === "::1" || bare.endsWith(".local") || bare.endsWith(".internal")) return true;
	const v4 = bare.startsWith("::ffff:") ? bare.slice(7) : bare;
	const parts = v4.split(".");
	// Anything that is not a dotted quad is a public hostname or an IPv6 literal we do not block.
	if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
		return /^(fc|fd|fe80:)/.test(bare);
	}
	const [a, b] = parts.map(Number);
	if (a === 0 || a === 127) return true;
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 169 && b === 254) return true;
	return false;
}

function inAllowRange(host: string, ranges: string[]): boolean {
	const octets = host.split(".").map(Number);
	if (octets.length !== 4 || octets.some((n) => !Number.isFinite(n))) return false;
	const ip = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
	for (const range of ranges) {
		const [base, bitsRaw] = range.split("/");
		const bits = Number(bitsRaw ?? 32);
		const baseOctets = base.split(".").map(Number);
		if (baseOctets.length !== 4 || baseOctets.some((n) => !Number.isFinite(n))) continue;
		const baseIp = ((baseOctets[0] << 24) >>> 0) + (baseOctets[1] << 16) + (baseOctets[2] << 8) + baseOctets[3];
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		if ((ip & mask) === (baseIp & mask)) return true;
	}
	return false;
}

function assertFetchable(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Not an absolute URL: ${url}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Only http(s) URLs are supported (got ${parsed.protocol})`);
	}
	if (isPrivateHost(parsed.hostname) && !inAllowRange(parsed.hostname, config().allowRanges ?? [])) {
		throw new Error(`Refusing to fetch private/local host ${parsed.hostname} (add it to ssrf.allowRanges in web-search.json)`);
	}
	return parsed;
}

async function requestJson(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<any> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const res = await paced(url, () => fetch(url, { ...init, signal: combined }));
			if (res.status === 429) {
				noteRateLimit(hostOf(url));
				if (attempt < 2) {
					await sleep(1200 * (attempt + 1));
					continue;
				}
				throw new Error(`Rate limited (429) by ${new URL(url).host} — retried 3 times`);
			}
			const text = await res.text();
			if (!res.ok) {
				const detail = text.slice(0, 300).replace(/\s+/g, " ");
				throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${detail}`);
			}
			noteOk(hostOf(url));
			try {
				return JSON.parse(text);
			} catch {
				throw new Error(`Non-JSON response from ${new URL(url).host}: ${text.slice(0, 160)}`);
			}
		} catch (error) {
			if (signal?.aborted) throw new Error("Aborted");
			const err = error instanceof Error ? error : new Error(String(error));
			if (err.name === "TimeoutError" || /timed out|TimeoutError/i.test(err.message)) {
				throw new Error(`${new URL(url).host} timed out after ${Math.round(timeoutMs / 1000)}s`);
			}
			if (/AbortError/.test(err.name)) throw new Error(`${new URL(url).host} was aborted`);
			if (/HTTP \d|Rate limited|Non-JSON/.test(err.message)) throw err;
			lastError = err;
			if (attempt < 2 && /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|ENOTFOUND|EAI_AGAIN/i.test(err.message)) {
				await sleep(800);
				continue;
			}
			throw err;
		}
	}
	throw lastError ?? new Error(`${new URL(url).host} request failed`);
}

/** Outbound scheduling, keyed by host.
 *
 *  One global 3-slot pacer used to serialize every request in the process: a batch of five
 *  unrelated sites waited on each other's latency, and a slow archive.org snapshot held up
 *  every DeepSeek fetch. Politeness is a per-host property, so the budget is per host: each
 *  host starts conservatively, climbs while it answers, and halves the moment it returns 429.
 *  A global ceiling still caps total sockets so a 20-URL batch cannot flood the network. */
const HOST_LIMIT_START = 4;
const HOST_LIMIT_MAX = 8;
const GLOBAL_MAX_INFLIGHT = 12;

interface HostState {
	inflight: number;
	limit: number;
	nextStartAt: number;
	waiters: Array<() => void>;
}

const hostStates = new Map<string, HostState>();
let globalInflight = 0;
const globalWaiters: Array<() => void> = [];

function hostState(host: string): HostState {
	let state = hostStates.get(host);
	if (!state) {
		state = { inflight: 0, limit: HOST_LIMIT_START, nextStartAt: 0, waiters: [] };
		hostStates.set(host, state);
	}
	return state;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host.toLowerCase();
	} catch {
		return "invalid";
	}
}

async function acquire(host: string): Promise<void> {
	if (globalInflight >= GLOBAL_MAX_INFLIGHT) await new Promise<void>((wake) => globalWaiters.push(wake));
	globalInflight++;
	const state = hostState(host);
	// Re-checked in a loop: a wake-up can be consumed by an earlier waiter.
	while (state.inflight >= state.limit) await new Promise<void>((wake) => state.waiters.push(wake));
	state.inflight++;
	// Space starts just enough that a burst does not read as a scan.
	const gap = Math.min(300, Math.max(60, Math.round(fetchGapMs() / 4)));
	const at = Math.max(Date.now(), state.nextStartAt);
	state.nextStartAt = at + gap;
	if (at > Date.now()) await sleep(at - Date.now());
}

function release(host: string): void {
	const state = hostState(host);
	state.inflight = Math.max(0, state.inflight - 1);
	state.waiters.shift()?.();
	globalInflight = Math.max(0, globalInflight - 1);
	globalWaiters.shift()?.();
}

/** A 429 is the host stating its real ceiling — obey it, then climb back one slot at a time. */
function noteRateLimit(host: string): void {
	const state = hostState(host);
	state.limit = Math.max(1, Math.floor(state.limit / 2));
	state.nextStartAt = Date.now() + 800;
}

function noteOk(host: string): void {
	const state = hostState(host);
	if (state.limit < HOST_LIMIT_MAX) state.limit += 1;
}

/** Every outbound request goes through here. */
async function paced<T>(url: string, task: () => Promise<T>): Promise<T> {
	const host = hostOf(url);
	await acquire(host);
	try {
		return await task();
	} finally {
		release(host);
	}
}

/** Run tasks with a concurrency cap while keeping result order stable. */
async function mapLimit<T, R>(items: T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			out[index] = await task(items[index] as T, index);
		}
	});
	await Promise.all(workers);
	return out;
}

// --------------------------------------------------------------- deepseek

interface Hit {
	title: string;
	url: string;
	content: string;
	snippet?: string;
	date?: string;
	siteName?: string;
	authority?: number;
	rerank?: number;
}

function normalizeHits(data: any): Hit[] {
	const list: unknown[] = Array.isArray(data?.results) ? data.results : Array.isArray(data?.data) ? data.data : [];
	const hits: Hit[] = [];
	for (const raw of list) {
		if (!raw || typeof raw !== "object") continue;
		const entry = raw as Record<string, any>;
		const url = str(entry.url) || str(entry.link);
		if (!url) continue;
		const content = str(entry.content) || str(entry.summary) || str(entry.text) || "";
		const snippet = str(entry.snippet);
		hits.push({
			title: str(entry.title) || url,
			url,
			content,
			// DeepSeek returns the same text in `summary` and `snippet`; keeping both doubled
			// every stored search on disk. Keep the snippet only when it adds something.
			snippet: snippet && !content.includes(snippet.slice(0, 80)) ? snippet : undefined,
			date: str(entry.date) || str(entry.publish_date) || str(entry.publishedDate) || undefined,
			siteName: str(entry.site_name) || undefined,
			authority: typeof entry.authority === "number" ? entry.authority : undefined,
			rerank: typeof entry.rerank_score === "number" ? entry.rerank_score : undefined,
		});
	}
	return hits;
}

async function dsSearch(query: string, count: number, signal?: AbortSignal): Promise<Hit[]> {
	const key = deepseekKey();
	if (!key) throw new Error("DeepSeek API key missing (web-search.json: deepseekApiKey, or DEEPSEEK_API_KEY)");
	const data = await requestJson(
		`${DS_BASE}/v1/tools/search`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			// need_content is the whole point: page text, no second crawl.
			body: JSON.stringify({ query, count, need_content: true }),
		},
		DS_SEARCH_TIMEOUT_MS,
		signal,
	);
	return normalizeHits(data);
}

interface Page {
	url: string;
	title: string;
	content: string;
	source: "deepseek" | "anymd" | "pdftotext" | "http" | "jina" | "wayback" | "index" | "cache";
	note?: string;
}

async function dsFetchPage(url: string, signal?: AbortSignal): Promise<Page> {
	const key = deepseekKey();
	if (!key) throw new Error("DeepSeek API key missing (web-search.json: deepseekApiKey, or DEEPSEEK_API_KEY)");
	const data = await requestJson(
		`${DS_BASE}/v1/tools/fetch`,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ url }),
		},
		fetchTimeoutMs(),
		signal,
	);
	const content = str(data?.content);
	if (!content) throw new Error(`DeepSeek returned no content for ${url}`);
	return { url, title: str(data?.title) || url, content, source: "deepseek" };
}

// -------------------------------------------------------------------- exa

async function exaSearch(
	query: string,
	opts: { numResults: number; contentChars: number; domainFilter: string[]; recencyFilter?: string; category?: string },
	signal?: AbortSignal,
): Promise<Hit[]> {
	const key = exaKey();
	if (!key) throw new Error("Exa API key missing (web-search.json: exaApiKey, or EXA_API_KEY)");
	const include = opts.domainFilter.filter((d) => !d.startsWith("-"));
	const exclude = opts.domainFilter.filter((d) => d.startsWith("-")).map((d) => d.slice(1));
	const body: Record<string, unknown> = {
		query,
		numResults: opts.numResults,
		type: "auto",
		contents: { text: { maxCharacters: Math.max(opts.contentChars, 8000) } },
	};
	if (include.length) body.includeDomains = include;
	if (exclude.length) body.excludeDomains = exclude;
	if (opts.category) body.category = opts.category;
	const after = recencyToDate(opts.recencyFilter);
	if (after) body.startPublishedDate = after;
	const data = await requestJson(
		EXA_SEARCH,
		{
			method: "POST",
			headers: { "x-api-key": key, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		45_000,
		signal,
	);
	return normalizeHits(data);
}

// ------------------------------------------------------- query composition

function recencyToDate(filter?: string): string | undefined {
	const days = filter === "day" ? 1 : filter === "week" ? 7 : filter === "month" ? 30 : filter === "year" ? 365 : 0;
	if (!days) return undefined;
	const d = new Date(Date.now() - days * 86_400_000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Translate filters into DeepSeek's supported operators (site:, -site:, after:). */
function composeDeepSeekQuery(query: string, domainFilter: string[], recencyFilter?: string): string {
	const parts = [query.trim()];
	const include = domainFilter.filter((d) => !d.startsWith("-")).slice(0, 2);
	const exclude = domainFilter.filter((d) => d.startsWith("-")).slice(0, 2);
	for (const domain of include) parts.push(`site:${domain.replace(/^site:/, "")}`);
	for (const domain of exclude) parts.push(`-site:${domain.slice(1).replace(/^site:/, "")}`);
	const after = recencyToDate(recencyFilter);
	if (after) parts.push(`after:${after}`);
	return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** DeepSeek rejects a query longer than 128 chars with a 400. Without an Exa key there is
 *  nothing to fall back to, so the query is trimmed here instead of costing the model a
 *  wasted round trip: query words go first, then the least load-bearing operators. */
const TRIM_KEEP_OPERATORS = /^(site:|-site:)/i;

function trimToLimit(composed: string, limit: number): { query: string; dropped: string[] } {
	if (composed.length <= limit) return { query: composed, dropped: [] };
	const tokens = composed.split(" ").filter(Boolean);
	const dropped: string[] = [];
	// 1. shed query words from the end, never a leading operator.
	for (let i = tokens.length - 1; i >= 0 && tokens.join(" ").length > limit; i--) {
		if (TRIM_KEEP_OPERATORS.test(tokens[i] as string)) continue;
		dropped.unshift(tokens[i] as string);
		tokens.splice(i, 1);
	}
	// 2. still too long: date filters are the cheapest thing left to lose.
	for (let i = tokens.length - 1; i > 0 && tokens.join(" ").length > limit; i--) {
		if (!/^(after|before):/i.test(tokens[i] as string)) continue;
		dropped.push(tokens[i] as string);
		tokens.splice(i, 1);
	}
	return { query: tokens.join(" ").slice(0, limit), dropped };
}

type Route = "deepseek" | "exa" | "keyless";

function pickRoute(query: string, provider: string | undefined, hasExa: boolean): { route: Route; reason: string } {
	const forced = (provider ?? "auto").toLowerCase();
	if (forced === "deepseek") return { route: "deepseek", reason: "forced" };
	if (forced === "exa") {
		if (!hasExa) throw new Error("provider=exa needs an Exa key (web-search.json: exaApiKey, or EXA_API_KEY)");
		return { route: "exa", reason: "forced" };
	}
	if (hasExa && BLIND_SPOT.test(query)) return { route: "exa", reason: "domain outside DeepSeek's index" };
	// Without an Exa key these platforms are otherwise unreachable, so do not spend a
	// DeepSeek call on an index that is known to be thin there.
	if (!hasExa && BLIND_SPOT.test(query)) return { route: "keyless", reason: "domain outside DeepSeek's index, no Exa key → keyless fallback" };
	return { route: "deepseek", reason: "default" };
}

// --------------------------------------------------------- keyless fallback
/** Most Pi users only have a DeepSeek key. These endpoints need no key at all and cover
 *  the platforms DeepSeek's index is blind to, plus a general Bing fallback. */
async function sov2exHits(query: string, signal?: AbortSignal): Promise<Hit[]> {
	const url = `https://www.sov2ex.com/api/search?q=${encodeURIComponent(query)}&size=8`;
	const data = await requestJson(url, { headers: { "User-Agent": BROWSER_UA } }, 12_000, signal);
	const list: unknown[] = Array.isArray(data?.hits) ? data.hits : [];
	const hits: Hit[] = [];
	for (const raw of list) {
		const source = (raw as any)?._source;
		const id = String((raw as any)?._id ?? "");
		const content = stripTags(str(source?.content_rendered));
		if (!id || content.length < 80) continue;
		hits.push({
			title: str(source?.title) || `v2ex /t/${id}`,
			url: `https://www.v2ex.com/t/${id}`,
			content,
			date: str(source?.created)?.slice(0, 10) || undefined,
			siteName: "V2EX",
		});
	}
	return hits;
}

/** A search-results page through the reader proxy: one hit whose text is the listing. */
async function readerSearch(label: string, target: string, query: string, signal?: AbortSignal): Promise<Hit[]> {
	const page = await jinaReader(target, signal);
	return [{ title: `${label} · ${query}`, url: target, content: page.content, siteName: label }];
}

/** A blind-spot query without an Exa key: the keyless engine reaches the platform, DeepSeek
 *  still has the surrounding discussion. Run both and merge instead of picking one — the
 *  platform listing is what was asked for, DeepSeek's hits are the context around it. */
async function mergedBlindSpot(
	query: string,
	effective: string,
	numResults: number,
	signal?: AbortSignal,
): Promise<{ label: string; hits: Hit[] }> {
	const [keyless, deepseek] = await Promise.allSettled([keylessSearch(query, signal), dsSearch(effective, numResults, signal)]);
	const keylessResult = keyless.status === "fulfilled" ? keyless.value : undefined;
	const hits: Hit[] = [];
	const seen = new Set<string>();
	let keylessUsed = 0;
	for (const hit of [...(keylessResult?.hits ?? []), ...(deepseek.status === "fulfilled" ? deepseek.value : [])]) {
		const key = urlKey(hit.url);
		if (seen.has(key)) continue;
		// A keyless listing only earns a slot when it actually shows the listing: a login wall
		// or an image dump wastes the budget that DeepSeek's real articles could use.
		if (keylessResult?.hits.includes(hit)) {
			const prose = proseOnly(hit.content ?? "");
			if (looksLikeWall(prose) || prose.length < 600) continue;
			hit.content = prose;
			keylessUsed += 1;
		}
		if ((hit.content?.length ?? 0) < 120) continue;
		seen.add(key);
		hits.push(hit);
	}
	const label = !keylessResult ? "deepseek" : keylessUsed > 0 ? `${keylessResult.label}+deepseek` : `deepseek (${keylessResult.label} listing needed a login)`;
	return { label, hits: hits.slice(0, numResults) };
}

async function keylessSearch(query: string, signal?: AbortSignal): Promise<{ label: string; hits: Hit[] }> {
	const q = encodeURIComponent(query);
	if (/v2ex/i.test(query)) return { label: "sov2ex", hits: await sov2exHits(query, signal) };
	if (/weixin|公众号|微信/i.test(query))
		return { label: "sogou-weixin", hits: await readerSearch("公众号", `https://weixin.sogou.com/weixin?type=2&query=${q}`, query, signal) };
	if (/xiaohongshu|小红书/i.test(query))
		return { label: "xiaohongshu", hits: await readerSearch("小红书", `https://www.xiaohongshu.com/search_result?keyword=${q}`, query, signal) };
	if (/youtube|youtu\.be/i.test(query))
		return { label: "youtube", hits: await readerSearch("YouTube", `https://www.youtube.com/results?search_query=${q}`, query, signal) };
	return { label: "bing", hits: await readerSearch("Bing", `https://www.bing.com/search?q=${q}`, query, signal) };
}

// ------------------------------------------------------------------- cache

interface StoredSearch {
	kind: "search";
	id: string;
	createdAt: string;
	queries: Array<{ query: string; provider: string; note?: string; hits: Hit[] }>;
}

interface StoredFetch {
	kind: "fetch";
	id: string;
	createdAt: string;
	pages: Page[];
}

type Stored = StoredSearch | StoredFetch;

function cacheDir(): string {
	const dir = join(agentDir(), "cache", "web");
	mkdirSync(dir, { recursive: true });
	return dir;
}

let lastPruneAt = 0;
const PRUNE_INTERVAL_MS = 60 * 60_000;

function pruneCache(): void {
	const now = Date.now();
	// Re-walking the cache dir on every save cost a readdir + one stat per file per call;
	// once an hour is plenty for a 200-file / 7-day window.
	if (lastPruneAt && now - lastPruneAt < PRUNE_INTERVAL_MS) return;
	lastPruneAt = now;
	let names: string[];
	try {
		names = readdirSync(cacheDir()).filter((name) => name.endsWith(".json"));
	} catch {
		return;
	}
	const cutoff = Date.now() - CACHE_KEEP_DAYS * 86_400_000;
	const sized = names
		.map((name) => {
			const path = join(cacheDir(), name);
			try {
				const st = statSync(path);
				return { path, mtime: st.mtimeMs, size: st.size };
			} catch {
				return undefined;
			}
		})
		.filter((entry): entry is { path: string; mtime: number; size: number } => Boolean(entry))
		.sort((a, b) => b.mtime - a.mtime);
	let total = 0;
	sized.forEach((entry, index) => {
		total += entry.size;
		if (entry.mtime < cutoff || index >= CACHE_KEEP_FILES || total > CACHE_MAX_BYTES) {
			try {
				unlinkSync(entry.path);
			} catch {
				// best effort
			}
		}
	});
}

function saveStored(stored: Stored): string {
	pruneCache();
	writeFileSync(join(cacheDir(), `${stored.id}.json`), JSON.stringify(stored));
	return stored.id;
}

function loadStored(id: string): Stored | undefined {
	const clean = id.trim().replace(/[^\w-]/g, "");
	if (!clean) return undefined;
	try {
		return JSON.parse(readFileSync(join(cacheDir(), `${clean}.json`), "utf8")) as Stored;
	} catch {
		return undefined;
	}
}

function newId(): string {
	return `wa_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// --------------------------------------------------------------- rendering

function truncate(text: string, limit: number): string {
	const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
	if (clean.length <= limit) return clean;
	return `${clean.slice(0, limit)}\n… [${num(clean.length - limit)} chars truncated — get_search_content 取全文]`;
}

function renderHits(hits: Hit[], contentChars: number, totalBudget: number): { body: string; used: number } {
	const lines: string[] = [];
	let budget = totalBudget;
	let index = 0;
	// Reserve a floor for every result still to come: otherwise one long first hit eats the
	// whole budget and results 3-5 arrive as bare titles, forcing a second call for them.
	const floor = hits.length > 1 ? Math.min(contentChars, Math.max(150, Math.floor(totalBudget / hits.length / 2))) : 0;
	for (const hit of hits) {
		index += 1;
		const remaining = hits.length - index;
		const meta: string[] = [];
		if (hit.authority !== undefined) meta.push(`authority ${hit.authority}/4`);
		if (hit.rerank !== undefined) meta.push(`rerank ${hit.rerank.toFixed(2)}`);
		if (hit.date) meta.push(hit.date.slice(0, 10));
		if (hit.siteName) meta.push(hit.siteName);
		lines.push(`${index}. ${hit.title}\n   ${hit.url}${meta.length ? `\n   ${meta.join(" · ")}` : ""}`);
		const take = Math.max(0, Math.min(contentChars, budget - floor * remaining));
		const text = hit.content || hit.snippet || "";
		if (take > 0 && text) {
			const shown = truncate(text, take);
			lines.push(`   ${shown.split("\n").join("\n   ")}`);
			budget -= Math.min(text.length, take);
		}
	}
	return { body: lines.join("\n"), used: totalBudget - budget };
}

// ------------------------------------------------------------------- tools

const webSearch = defineTool({
	name: "web_search",
	label: "Web Search",
	promptSnippet: "Search the web; each hit returns its page text, not a snippet",
	promptGuidelines: [
		"Never fetch_content a URL you just got from web_search — its text is already in the reply; use get_search_content for the parts that were truncated.",
		"Filters compile into operators; a compiled query over 128 chars is trimmed automatically, so prefer dropping filters over dropping the question.",
	],
	description:
		"Search the web and get the extracted page text of every hit in the same call. Routes 公众号/小红书/YouTube/V2EX to Exa, or to a keyless endpoint when no Exa key is set. Returns a responseId for get_search_content.",
	parameters: Type.Object({
		query: Type.Optional(Type.String({ description: 'Query; operators ok: site:, -site:, "…", lang:zh, after:YYYY-MM-DD.' })),
		queries: Type.Optional(Type.Array(Type.String(), { description: "Up to 3 variants, searched in parallel.", maxItems: 3 })),
		numResults: Type.Optional(Type.Number({ description: "Hits per query (1-10), default 5.", minimum: 1, maximum: MAX_RESULTS })),
		contentChars: Type.Optional(
			Type.Number({ description: "Page text per hit (0-8000), default 1200; 0 = titles only.", minimum: 0, maximum: 8000 }),
		),
		includeContent: Type.Optional(Type.Boolean({ description: "false = titles only." })),
		domainFilter: Type.Optional(
			Type.Array(Type.String(), { description: "Hosts: example.com to include, -example.com to exclude (max 2 each).", maxItems: 4 }),
		),
		recencyFilter: Type.Optional(Type.String({ description: "Publish window: day|week|month|year." })),
		category: Type.Optional(Type.String({ description: "Exa only: news, pdf, github, tweet…" })),
		provider: Type.Optional(Type.String({ description: "Engine: auto|deepseek|exa." })),
	}),
	async execute(_toolCallId, params, signal, onUpdate) {
		const variants = [...new Set([params.query ?? "", ...(params.queries ?? [])].map((q) => q.trim()).filter(Boolean))].slice(
			0,
			3,
		);
		if (variants.length === 0) throw new Error("query or queries is required");
		const numResults = clamp(params.numResults, 5, 1, MAX_RESULTS);
		const contentChars = params.includeContent === false ? 0 : clamp(params.contentChars, SEARCH_CHARS_DEFAULT, 0, 8000);
		const domainFilter = (params.domainFilter ?? []).map((d) => d.trim()).filter(Boolean);
		const hasExa = Boolean(exaKey());
		const id = newId();
		const stored: StoredSearch = { kind: "search", id, createdAt: nowStamp(), queries: [] };
		const blocks: string[] = [];

		// Variants are independent, so run three at a time: a 3-query search drops from ~3 s
		// (sequential) to roughly the slowest variant plus one pacing gap.
		const results = await mapLimit(variants, 3, async (query, index) => {
			if (signal?.aborted) throw new Error("Aborted");
			onUpdate?.({ content: [{ type: "text", text: `Searching ${index + 1}/${variants.length}: ${query}` }] });
			const started = Date.now();
			const picked = pickRoute(query, params.provider, hasExa);
			let route = picked.route;
			let note = picked.reason;
			let hits: Hit[] = [];
			const composed = composeDeepSeekQuery(query, domainFilter, params.recencyFilter);
			try {
				let effective = composed;
				if (route === "deepseek" && composed.length > DS_QUERY_LIMIT) {
					if (hasExa && (params.provider ?? "auto") === "auto") {
						// Exa has no length cap, so the full query survives there.
						route = "exa";
						note = `query+operators = ${composed.length} chars > ${DS_QUERY_LIMIT}, sent to Exa`;
					} else {
						// No Exa: trim instead of failing — a thrown error costs the model a retry loop.
						const trimmed = trimToLimit(composed, DS_QUERY_LIMIT);
						effective = trimmed.query;
						note = `auto-trimmed ${composed.length}→${effective.length} chars (dropped: ${trimmed.dropped.join(" ") || "none"})`;
					}
				}
				if (route === "keyless") {
					const fallback = await mergedBlindSpot(query, effective, numResults, signal);
					hits = fallback.hits;
					note = `${note} → ${fallback.label}`;
					if (hits.length === 0) {
						route = "deepseek";
						note = `${note} returned nothing, retried on DeepSeek`;
						hits = await dsSearch(effective, numResults, signal);
					}
				} else if (route === "deepseek") {
					hits = await dsSearch(effective, numResults, signal);
					if (hits.length === 0 && hasExa && (params.provider ?? "auto") === "auto") {
						route = "exa";
						note = "deepseek returned 0 results, retried with Exa";
						hits = await exaSearch(query, { numResults, contentChars, domainFilter, recencyFilter: params.recencyFilter, category: params.category }, signal);
					} else if (hits.length === 0 && !hasExa && (params.provider ?? "auto") === "auto") {
						// Last resort without an Exa key: a keyless engine still answers something.
						route = "keyless";
						const fallback = await keylessSearch(query, signal);
						hits = fallback.hits;
						note = `deepseek returned 0 results, retried via ${fallback.label} (no Exa key)`;
					}
				} else {
					hits = await exaSearch(query, { numResults, contentChars, domainFilter, recencyFilter: params.recencyFilter, category: params.category }, signal);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (route === "deepseek" && hasExa && (params.provider ?? "auto") === "auto" && !/Aborted/.test(message)) {
					route = "exa";
					note = `deepseek failed (${message.split("\n")[0]?.slice(0, 120)}), retried with Exa`;
					try {
						hits = await exaSearch(query, { numResults, contentChars, domainFilter, recencyFilter: params.recencyFilter, category: params.category }, signal);
					} catch (exaError) {
						const detail = exaError instanceof Error ? exaError.message : String(exaError);
						throw new Error(`Both engines failed for "${query}"\n- deepseek: ${message}\n- exa: ${detail}`);
					}
				} else {
					throw error;
				}
			}
			rememberHits(hits);
			const elapsed = ((Date.now() - started) / 1000).toFixed(2);
			return { entry: { query, provider: route, note, hits }, elapsed };
		});

		for (const { entry, elapsed } of results) {
			stored.queries.push(entry);
			const rendered = renderHits(entry.hits, contentChars, SEARCH_CHARS_TOTAL);
			blocks.push(
				[
					`## ${entry.query}`,
					`${entry.hits.length} 结果 · ${entry.provider} · ${elapsed}s · ${entry.note}`,
					rendered.body || "(no results)",
				].join("\n"),
			);
		}

		saveStored(stored);
		const header = `responseId: ${id} — get_search_content 可翻页/取全文`;
		const footer = `共 ${num(stored.queries.reduce((sum, entry) => sum + entry.hits.length, 0))} 条，正文已截断` ;
		return {
			content: [{ type: "text", text: `${header}\n\n${blocks.join("\n\n")}\n\n${footer}` }],
			details: { responseId: id, queries: stored.queries.map((q) => ({ query: q.query, provider: q.provider, hits: q.hits.length })) },
		};
	},
});

/** Extraction chain: documents go local-first (anymd → pdftotext), pages go DeepSeek-first. */
async function fetchOne(url: string, signal?: AbortSignal): Promise<Page> {
	// A document already on disk: no download, no SSRF check, no network at all.
	const local = localPathOf(url);
	if (local) return localToText(local);
	if (looksLikePath(url)) throw new Error(`No such local file: ${url}`);

	// The model often re-fetches a URL it just saw in web_search results — answer from memory.
	const hot = hotLookup(url);
	if (hot) return { url: hot.url, title: hot.title, content: hot.content, source: "cache", note: "already crawled by web_search in this session, no new request" };

	const parsed = assertFetchable(url);
	const namedPdf = /\.pdf$/i.test(parsed.pathname);
	const namedDoc = DOCUMENT_EXT.test(parsed.pathname);
	// anymd is the primary parser for every document. Only URLs that look like documents
	// (extension, paper host, /pdf/ path) are probed — otherwise the probe is a wasted RTT.
	const likelyDoc = namedDoc || DOC_HOST_HINT.test(parsed.hostname) || DOC_PATH_HINT.test(parsed.pathname);
	const kind = namedDoc ? "document" : likelyDoc ? await peekKind(url, signal) : "page";
	const attempts: Array<[string, () => Promise<Page>]> = [];
	if (kind === "document") {
		// arXiv PDFs are typeset twice; the HTML build is a fraction of the bytes and keeps equations.
		const htmlVersion = arxivHtmlVersion(url);
		if (htmlVersion) attempts.push(["deepseek", () => dsFetchPage(htmlVersion, signal)]);
		attempts.push(["anymd", () => anymdToText(url, signal)]);
		if (namedPdf || !namedDoc) attempts.push(["pdftotext", () => pdfToText(url, signal)]);
		attempts.push(["http", () => httpToText(url, signal)]);
	} else {
		attempts.push(["deepseek", () => dsFetchPage(url, signal)]);
		attempts.push(["http", () => httpToText(url, signal)]);
		// Both live crawls are routinely refused by paywalls and anti-bot walls. Rather than
		// failing, take the same page from a reader proxy, an archive, or DeepSeek's index.
		attempts.push(["unblock", () => unblock(url, signal)]);
	}
	const errors: string[] = [];
	for (const [name, run] of attempts) {
		if (signal?.aborted) throw new Error("Aborted");
		try {
			const page = await run();
			// A 60-char "安全验证" page is a failure that HTTP status cannot express.
			if (kind === "page" && looksLikeWall(page.content)) {
				errors.push(`${name}: only ${num(page.content.length)} chars, looks like a wall or a JS shell`);
				continue;
			}
			return page;
		} catch (error) {
			errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`All extraction paths failed for ${url}\n  ${errors.join("\n  ")}`);
}

// ---------------------------------------------------------------- hot cache

/** web_search already pulls the page text of every hit (4-15 K chars) and writes it to disk;
 *  the model, however, often calls fetch_content on the same URL anyway. Keeping the last
 *  few searches in memory turns that second call into a 0 ms map lookup instead of a crawl. */
const HOT_MAX = 80;
const HOT_TTL_MS = 30 * 60_000;
const HOT_MIN_CHARS = 400;
const hotCache = new Map<string, { url: string; title: string; content: string; at: number }>();

/** Compare URLs the way a reader would: ignore #anchors, www, trailing slashes and tracking params. */
function urlKey(url: string): string {
	try {
		const parsed = new URL(url);
		for (const key of [...parsed.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|spm$|ref$|source$)/i.test(key)) parsed.searchParams.delete(key);
		return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`.toLowerCase();
	} catch {
		return url.trim().toLowerCase();
	}
}

function rememberHits(hits: Hit[]): void {
	const cutoff = Date.now() - HOT_TTL_MS;
	for (const [key, entry] of hotCache) if (entry.at < cutoff) hotCache.delete(key);
	for (const hit of hits) {
		if (!hit.url || hit.content.length < HOT_MIN_CHARS) continue;
		const key = urlKey(hit.url);
		hotCache.delete(key);
		hotCache.set(key, { url: hit.url, title: hit.title, content: hit.content, at: Date.now() });
	}
	while (hotCache.size > HOT_MAX) hotCache.delete(hotCache.keys().next().value as string);
}

function hotLookup(url: string): { url: string; title: string; content: string } | undefined {
	const key = urlKey(url);
	const entry = hotCache.get(key);
	if (!entry) return undefined;
	if (Date.now() - entry.at > HOT_TTL_MS) {
		hotCache.delete(key);
		return undefined;
	}
	// Refresh LRU position without changing the timestamp.
	hotCache.delete(key);
	hotCache.set(key, entry);
	return entry;
}

// ------------------------------------------------------------- local files

/** A document already on disk needs no download and no SSRF check — resolve it directly. */
function localPathOf(input: string): string | undefined {
	const raw = input.trim();
	if (/^file:\/\//i.test(raw)) {
		try {
			const path = fileURLToPath(raw);
			return statSync(path).isFile() ? path : undefined;
		} catch {
			return undefined;
		}
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined; // any other scheme is not a path
	const candidate = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : resolve(raw);
	try {
		return statSync(candidate).isFile() ? candidate : undefined;
	} catch {
		return undefined;
	}
}

/** Looks like a filesystem path rather than a URL — used only to sharpen the error message. */
function looksLikePath(input: string): boolean {
	const raw = input.trim();
	return /^file:\/\//i.test(raw) || (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && (raw.startsWith("/") || raw.startsWith("~") || raw.startsWith("./")));
}

// ------------------------------------------------------------ blocked hosts

/** Markers that mean "this text is a challenge page, not the article". */
const WALL_MARKERS =
	/安全验证|人机验证|环境异常|请开启JavaScript|Just a moment|Enable JavaScript and cookies|Access Denied|Attention Required|Verify you are human|cf-browser-verification|unusual traffic|captcha|登录后查看|登录后继续|扫码登录|请先登录|Log in to continue|Sign in to continue/i;
const MIN_PAGE_CHARS = 120;

function looksLikeWall(text: string): boolean {
	const head = text.replace(/\s+/g, " ").trim();
	return head.length < MIN_PAGE_CHARS || WALL_MARKERS.test(head.slice(0, 400));
}

/** r.jina.ai prefixes every response with Title/URL Source/Markdown Content lines. */
function stripReaderHeader(raw: string): { title: string; text: string } {
	const lines = raw.split("\n");
	let index = 0;
	let title = "";
	for (; index < lines.length; index++) {
		const match = /^(Title|URL Source|Published Time|Markdown Content|Warning):\s*(.*)$/.exec(lines[index] ?? "");
		if (!match) break;
		if (match[1] === "Title") title = match[2]?.trim() ?? "";
	}
	return { title, text: lines.slice(index).join("\n").trim() };
}

/** What a reader-rendered *search listing* leaves behind: link clutter, lazy images, image
 *  OCR dumps. Count only the prose so that "1 useful line + 6 KB of noise" is not a hit. */
function proseOnly(text: string): string {
	return text
		.split("\n")
		.filter((line) => {
			const t = line.trim();
			if (!t) return true;
			if (/^!\[.*\]\(.*\)$/.test(t)) return false;
			if (/^(URL Source|Markdown Content|Warning):/.test(t)) return false;
			if (/^https?:\/\/\S+$/.test(t)) return false;
			return true;
		})
		.join("\n")
		.trim();
}

/** r.jina.ai renders the page server-side and slips past a lot of paywalls (FT, Bloomberg).
 *  Anonymous use is rate limited, so it is only ever a fallback. */
async function jinaReader(url: string, signal?: AbortSignal): Promise<Page> {
	// The reader answers in 2-3 s when it can render the page at all; waiting 12 s only
	// delays the archive and index paths that would have answered meanwhile.
	const timeout = AbortSignal.timeout(8_000);
	const res = await paced(`https://r.jina.ai/${url}`, () =>
		fetch(`https://r.jina.ai/${url}`, {
			headers: { Accept: "text/plain", "User-Agent": BROWSER_UA },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		}),
	);
	if (!res.ok) throw new Error(`reader HTTP ${res.status}`);
	const { title, text } = stripReaderHeader(await res.text());
	// A reader that hands back a few hundred characters is echoing a login/JS wall.
	if (text.length < 400 || looksLikeWall(text)) throw new Error(`reader returned a challenge page (${num(text.length)} chars)`);
	return { url, title: title || url, content: text, source: "jina" };
}

/** The Wayback Machine kept what the site itself now blocks. `/web/2/<url>` redirects to
 *  the closest snapshot, so no availability lookup (and no extra 429-prone request) is needed. */
async function wayback(url: string, signal?: AbortSignal): Promise<Page> {
	const timeout = AbortSignal.timeout(10_000);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let res: Response | undefined;
	for (let attempt = 0; attempt < 2; attempt++) {
		res = await paced("https://web.archive.org", () =>
			fetch(`https://web.archive.org/web/2/${url}`, {
				redirect: "follow",
				headers: { Accept: "text/html", "User-Agent": BROWSER_UA },
				signal: combined,
			}),
		);
		// archive.org rate limits bursts even when the snapshot exists — one paced retry wins it back.
		if (res.status !== 429 || attempt === 1) break;
		await res.body?.cancel();
		await sleep(1500);
	}
	if (!res?.ok) throw new Error(`archive HTTP ${res?.status ?? "error"}`);
	const parsed = htmlToText(await res.text());
	if (looksLikeWall(parsed.text)) throw new Error("archive has no usable snapshot");
	return { url, title: parsed.title || url, content: parsed.text, source: "wayback" };
}

/** Race both unblocking paths and keep whichever answers first with real text. */
async function blockedPass(url: string, signal?: AbortSignal): Promise<Page> {
	const controller = new AbortController();
	const linked = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	const runners: Array<[string, (u: string, s: AbortSignal) => Promise<Page>]> = [
		["jina", jinaReader],
		["wayback", wayback],
	];
	const errors: string[] = [];
	try {
		return await new Promise<Page>((resolve, reject) => {
			let pending = runners.length;
			for (const [name, run] of runners) {
				run(url, linked).then(
					(page) => {
						controller.abort(); // the loser keeps no bandwidth
						resolve(page);
					},
					(error) => {
						errors.push(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
						pending -= 1;
						if (pending === 0) reject(new Error(errors.join("; ")));
					},
				);
			}
		});
	} finally {
		controller.abort();
	}
}

/** One attempt for blocked hosts: the reader/archive race for the real page, the index as a
 *  cheap parallel backup. Running them together turns a 27 s worst case into ~12 s. */
async function unblock(url: string, signal?: AbortSignal): Promise<Page> {
	// Hard budget: a host that refuses everything must not stall the whole batch.
	const budget = AbortSignal.timeout(12_000);
	const scoped = signal ? AbortSignal.any([signal, budget]) : budget;
	const indexed = indexSubstitute(url, scoped).catch(() => undefined);
	try {
		return await blockedPass(url, scoped);
	} catch (error) {
		const substitute = await indexed;
		if (substitute) return substitute;
		throw error;
	}
}

/** Last resort: DeepSeek's index often holds the page the live crawl cannot reach.
 *  Search by host + path slug, prefer an exact URL match, else an obviously related page. */
async function indexSubstitute(url: string, signal?: AbortSignal): Promise<Page> {
	const parsed = new URL(url);
	const slug = decodeURIComponent(parsed.pathname)
		.split(/[/_\-.]+/)
		.filter((word) => word.length > 2 && !/^(index|html?|php|amp|article|news|story|s)$/i.test(word))
		.slice(-6)
		.join(" ");
	if (!slug) throw new Error("nothing to look up in the index");
	const hits = await dsSearch(`${slug} site:${parsed.hostname.replace(/^www\./, "")}`, 6, signal);
	const wanted = urlKey(url);
	const exact = hits.find((hit) => urlKey(hit.url) === wanted);
	// A substitute is only honest when it is the same host and shares a real slug token —
	// otherwise "nearest page" turns into a different story with the same site name.
	const tokens = slug.split(" ").filter((word) => word.length >= 4);
	const related = hits.find(
		(hit) => new URL(hit.url).hostname.replace(/^www\./, "") === parsed.hostname.replace(/^www\./, "") && tokens.some((token) => urlKey(hit.url).includes(token.toLowerCase())),
	);
	const winner = exact ?? related;
	if (!winner || winner.content.length < HOT_MIN_CHARS) throw new Error("no indexed copy of this page");
	return {
		url: winner.url,
		title: winner.title,
		content: winner.content,
		source: "index",
		note: exact
			? `${parsed.hostname} refused the live crawl; text comes from DeepSeek's index of the same URL`
			: `${parsed.hostname} refused the live crawl and has no exact indexed copy; this is the closest indexed page on the same story`,
	};
}

/** arXiv renders every paper since Dec 2023 as HTML at /html/<id>; the PDF is 10-100x heavier.
 *  Older papers were never typeset to HTML, so probing /html/ for them only wastes a round trip. */
function arxivHtmlVersion(url: string): string | undefined {
	const match = /^https?:\/\/arxiv\.org\/(?:abs|pdf)\/(\d{2})(\d{2})\.\d{4,5}(v\d+)?(?:\.pdf)?$/i.exec(url.trim());
	if (!match) return undefined; // old-style ids (hep-th/9901001) and non-paper URLs
	const stamped = Number(match[1]) * 100 + Number(match[2]);
	if (!(stamped >= 2312)) return undefined; // before 2023-12 arXiv had no HTML build
	const id = /arxiv\.org\/(?:abs|pdf)\/([^?#]+?)(?:\.pdf)?$/i.exec(url.trim())?.[1];
	return id ? `https://arxiv.org/html/${id}` : undefined;
}

const fetchContent = defineTool({
	name: "fetch_content",
	label: "Fetch Content",
	promptSnippet: "Fetch URLs or local files; documents convert locally with OCR",
	promptGuidelines: [
		"Pass a URL you already have, or a document already on disk (a plain path is enough) — it bypasses paywalls and anti-bot walls most scrapers fail on.",
	],
	description:
		"Return the extracted text of URLs or local files. Documents (PDF/Office/EPUB/images/audio/subtitles) are converted to Markdown locally with anymd, pdftotext as fallback — nothing is uploaded. Text is stored under a responseId.",
	parameters: Type.Object({
		url: Type.Optional(Type.String({ description: "http(s) URL or local file path." })),
		urls: Type.Optional(Type.Array(Type.String(), { description: `Up to ${MAX_URLS} URLs/paths, in order.`, maxItems: MAX_URLS })),
		maxChars: Type.Optional(
			Type.Number({ description: "Text per item (200-40000), default 4000.", minimum: 200, maximum: 40000 }),
		),
	}),
	async execute(_toolCallId, params, signal, onUpdate) {
		const urls = [...new Set([params.url ?? "", ...(params.urls ?? [])].map((u) => u.trim()).filter(Boolean))].slice(
			0,
			MAX_URLS,
		);
		if (urls.length === 0) throw new Error("url or urls is required");
		const maxChars = clamp(params.maxChars, FETCH_CHARS_DEFAULT, 200, 40000);
		const id = newId();
		const pages: Page[] = [];
		const blocks: string[] = [];
		const failures: string[] = [];
		let budget = 60_000;

		// Six at a time: the per-host scheduler already caps concurrency where it matters, so the
		// batch limit only needs to keep a wide fan-out (20 links) from opening 20 sockets.
		const outcomes = await mapLimit(urls, 6, async (url, index) => {
			if (signal?.aborted) throw new Error("Aborted");
			onUpdate?.({ content: [{ type: "text", text: `Fetching ${index + 1}/${urls.length}: ${url}` }] });
			const started = Date.now();
			try {
				const page = await fetchOne(url, signal);
				return { page, elapsed: (Date.now() - started) / 1000 };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { failure: `[${index + 1}] ${url}\n   ${message}` };
			}
		});

		for (const [index, outcome] of outcomes.entries()) {
			if ("failure" in outcome) {
				failures.push(outcome.failure);
				continue;
			}
			const { page, elapsed } = outcome;
			pages.push(page);
			const take = Math.min(maxChars, Math.max(0, budget));
			const shown = truncate(page.content, take);
			budget -= Math.min(page.content.length, take);
			blocks.push(
				`## [${index + 1}] ${page.title}\n${page.url}\n${num(page.content.length)} 字符 · ${page.source} · ${elapsed.toFixed(2)}s${
					page.note ? `\nnote: ${page.note}` : ""
				}\n\n${shown}`,
			);
		}

		if (pages.length === 0) {
			throw new Error(`All ${urls.length} URL(s) failed:\n${failures.join("\n")}`);
		}
		saveStored({ kind: "fetch", id, createdAt: nowStamp(), pages });
		const parts = [`responseId: ${id} — get_search_content 可翻页/取全文`, ...blocks];
		if (failures.length) parts.push(`## 失败 ${failures.length}/${urls.length}\n${failures.join("\n")}`);
		return {
			content: [{ type: "text", text: parts.join("\n\n") }],
			details: { responseId: id, ok: pages.length, failed: failures.length, pages: pages.map((p) => ({ url: p.url, chars: p.content.length, source: p.source })) },
		};
	},
});

function decodeEntities(input: string): string {
	const named: Record<string, string> = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
		ldquo: "\u201c",
		rdquo: "\u201d",
		mdash: "\u2014",
		ndash: "\u2013",
		hellip: "\u2026",
	};
	return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, group: string) => {
		if (group.startsWith("#")) {
			const code = group[1]?.toLowerCase() === "x" ? Number.parseInt(group.slice(2), 16) : Number.parseInt(group.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return named[group.toLowerCase()] ?? match;
	});
}

/** Blocks that carry navigation, cookie banners and share widgets — never the article itself. */
const CHROME_BLOCK = /<(nav|aside|footer|header|form|button|select|dialog|iframe|figure|figcaption)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** A whole line of site furniture. Anchored, so it cannot eat a sentence that starts with a link. */
const CHROME_LINE =
	/^(?:home|menu|search|share|subscribe|newsletter|sign in|log in|sign up|register|advertisement|skip to (?:main )?content|accept (?:all|cookies)|cookie (?:policy|settings|preferences)|privacy policy|terms of service|all rights reserved|follow us|back to top|read more|related (?:articles|posts|stories)|table of contents|previous|next|we use cookies\b|this (?:site|website) uses cookies\b)/i;

function stripTags(fragment: string): string {
	const body = fragment
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|br)>/gi, "\n")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, " ");
	const lines = decodeEntities(body)
		.replace(/[ \t\u00a0]+/g, " ")
		.replace(/ *\n */g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !(line.length < 60 && CHROME_LINE.test(line)))
		.join("\n");
	return lines.replace(/\n{3,}/g, "\n\n").trim();
}

export function htmlToText(html: string): { title: string; text: string } {
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, "")).trim() : "";
	const withoutChrome = html
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(CHROME_BLOCK, " ");
	// Most sites mark the article up semantically; when they do, the surrounding chrome is
	// irrelevant and skipping it removes 60-80% of the characters with no information loss.
	const scoped = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(withoutChrome)?.[1] ?? /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(withoutChrome)?.[1];
	if (scoped) {
		const text = stripTags(scoped);
		if (text.length >= 500) return { title, text };
	}
	return { title, text: stripTags(withoutChrome) };
}

/** Direct HTTP fallback: DeepSeek's crawler does not reach every host. */
async function httpToText(url: string, signal?: AbortSignal): Promise<Page> {
	const timeout = AbortSignal.timeout(fetchTimeoutMs());
	const res = await paced(url, () =>
		fetch(url, {
			redirect: "follow",
			headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		}),
	);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const type = (res.headers.get("content-type") ?? "").toLowerCase();
	if (!/text\/|application\/(xhtml|xml|json)/.test(type)) {
		throw new Error(`unsupported content-type ${type || "unknown"}`);
	}
	const raw = await res.text();
	if (/json/.test(type)) return { url, title: url, content: raw, source: "http" };
	const parsed = htmlToText(raw);
	if (!parsed.text) throw new Error("no readable text in HTML");
	return { url, title: parsed.title || url, content: parsed.text, source: "http" };
}

const BROWSER_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/** MIME types anymd can convert (PDF / Office / EPUB / CSV / images / audio / video / subtitles). */
const DOCUMENT_MIME =
	/application\/(pdf|epub\+zip|vnd\.openxmlformats|msword|vnd\.ms-|vnd\.oasis|rtf|x-subrip)|image\/|audio\/|video\/|text\/(csv|vtt)/;

/** Cheap probe (2 KB ranged request) for URLs whose path has no document suffix.
 *  arxiv.org/pdf/1706.03762 carries no .pdf extension, so the path alone cannot tell a
 *  paper from a web page — and that is exactly the URL shape most paper links use. */
async function peekKind(url: string, signal?: AbortSignal): Promise<"document" | "page"> {
	try {
		const timeout = AbortSignal.timeout(15_000);
		const res = await paced(url, () =>
			fetch(url, {
				headers: { Range: "bytes=0-2047", "User-Agent": BROWSER_UA },
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			}),
		);
		if (!res.ok && res.status !== 206) {
			await res.body?.cancel();
			return "page";
		}
		const type = (res.headers.get("content-type") ?? "").toLowerCase();
		const head = Buffer.from(await res.arrayBuffer()).subarray(0, 8);
		if (DOCUMENT_MIME.test(type)) return "document";
		const magic = head.toString("latin1");
		if (magic.startsWith("%PDF-") || magic.startsWith("PK\u0003\u0004")) return "document";
		return "page";
	} catch {
		return "page";
	}
}

/** File types anymd converts locally (Markdown w/ OCR, structure, transcripts). */
const DOCUMENT_EXT =
	/\.(pdf|docx|doc|pptx|ppt|xlsx|xls|ods|csv|tsv|epub|rtf|odt|png|jpe?g|webp|gif|bmp|tiff?|mp3|m4a|wav|flac|aac|mp4|mov|mkv|webm|srt|vtt)$/i;
/** Hosts/paths whose URLs are documents even without a file extension. Probing every
 *  extensionless URL with `peekKind` cost one extra round trip per page fetch; ordinary
 *  pages now skip the probe and go straight to DeepSeek. */
const DOC_HOST_HINT =
	/(^|\.)(arxiv\.org|biorxiv\.org|medrxiv\.org|openreview\.net|ncbi\.nlm\.nih\.gov|papers\.nips\.cc|proceedings\.mlr\.press|aclweb\.org|hal\.science|dl\.acm\.org|ieeexplore\.ieee\.org|link\.springer\.com|nature\.com|science\.org|sciencedirect\.com|mdpi\.com|frontiersin\.org|pnas\.org|jamanetwork\.com|nejm\.org|thelancet\.com|bmj\.com|cell\.com|ssrn\.com|researchgate\.net)$/i;
const DOC_PATH_HINT = /\/(pdf|full-?text|download|eprint)(\/|$)/i;
const ANYMD_BIN = process.env.ANYMD_BIN ?? "anymd";

/** anymd spawns `tesseract <image> stdout` with no `-l`, so its OCR was English-only and
 *  Chinese scans came back as garbage Latin. `bin/tesseract` (shipped with this package)
 *  prepends a language (`chi_sim+eng` by default, override with ANYMD_TESS_LANGS) and
 *  forwards everything else. Set ANYMD_SHIM_DIR to point at a different shim directory. */
const ANYMD_SHIM_DIR = (() => {
	if (process.env.ANYMD_SHIM_DIR !== undefined) return process.env.ANYMD_SHIM_DIR;
	let here = "";
	try {
		const url = (import.meta as { url?: string } | undefined)?.url;
		if (typeof url === "string" && url.startsWith("file:")) here = dirname(fileURLToPath(url));
	} catch {
		// import.meta is unavailable under a CJS transform — try __dirname below
	}
	if (!here) {
		try {
			// Pi loads extensions through jiti (CJS), where this file's directory is __dirname.
			here = eval("typeof __dirname === 'string' ? __dirname : ''");
		} catch {
			// leave empty: OCR stays English-only unless ANYMD_SHIM_DIR is set
		}
	}
	return here ? join(here, "..", "bin") : "";
})();
const ANYMD_SHIM = ANYMD_SHIM_DIR ? join(ANYMD_SHIM_DIR, "tesseract") : "";

function anymdEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ANYMD_TESS_LANGS: process.env.ANYMD_TESS_LANGS ?? "chi_sim+eng" };
	if (ANYMD_SHIM && existsSync(ANYMD_SHIM)) env.PATH = `${ANYMD_SHIM_DIR}:${process.env.PATH ?? ""}`;
	return env;
}

/** Download to a temp file. anymd refuses http URLs here (its SSRF guard sees the TUN
 *  fake-IP range 198.18/15), so the extension downloads and anymd only reads local files. */
async function downloadToTemp(url: string, signal?: AbortSignal): Promise<string> {
	const parsed = new URL(url);
	const ext = (parsed.pathname.match(/\.[a-z0-9]{1,5}$/i)?.[0] ?? "").toLowerCase();
	const timeout = AbortSignal.timeout(fetchTimeoutMs());
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const res = await paced(url, () => fetch(url, { signal: combined, redirect: "follow", headers: { "User-Agent": BROWSER_UA } }));
	if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
	const declared = Number(res.headers.get("content-length") ?? 0);
	if (declared && declared > PDF_MAX_BYTES) throw new Error(`file is ${num(declared)} bytes, over the ${num(PDF_MAX_BYTES)}-byte cap`);
	if (!res.body) throw new Error("download failed: empty body");
	const path = join(tmpdir(), `wa-${Date.now().toString(36)}-${counter().toString(36)}${ext || ".bin"}`);
	// Stream to disk instead of buffering: a 30 MB PDF used to sit in the heap (x3 for a batch).
	let bytes = 0;
	await pipeline(
		Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
		async function* (source: AsyncIterable<Uint8Array>) {
			for await (const chunk of source) {
				bytes += chunk.byteLength;
				if (bytes > PDF_MAX_BYTES) throw new Error(`file is over the ${num(PDF_MAX_BYTES)}-byte cap`);
				yield chunk;
			}
		},
		createWriteStream(path),
	);
	return path;
}

/** anymd → clean Markdown: structure, tables, OCR, transcripts. Preferred for documents. */
async function execAnymd(path: string): Promise<string> {
	const text = await new Promise<string>((resolvePromise, reject) => {
		execFile(ANYMD_BIN, [path], { maxBuffer: 32 * 1024 * 1024, timeout: 180_000, env: anymdEnv() }, (error, stdout, stderr) => {
			if (error && !stdout) {
				const message = String(stderr || error.message).trim().split("\n")[0] ?? "";
				const hint = /ENOENT/.test(String(error.message))
					? "anymd not installed — run `npm i -g @sylphx/anymd`"
					: `anymd failed: ${message.slice(0, 200)}`;
				reject(new Error(hint));
				return;
			}
			resolvePromise(stdout);
		});
	});
	const clean = text.replace(/\u0000/g, "").trim();
	if (!clean) throw new Error("anymd produced no text (scanned file? try OCR)");
	// A real PDF yields thousands of characters; a near-empty result means a broken
	// download or an image-only page whose OCR failed, so let pdftotext take over.
	if (clean.length < 400 && readFileSync(path).subarray(0, 5).toString("latin1") === "%PDF-")
		throw new Error(`anymd extracted only ${clean.length} chars from this PDF`);
	return clean;
}

async function anymdToText(url: string, signal?: AbortSignal): Promise<Page> {
	const path = await downloadToTemp(url, signal);
	try {
		return { url, title: basename(new URL(url).pathname) || url, content: await execAnymd(path), source: "anymd" };
	} finally {
		try {
			unlinkSync(path);
		} catch {
			// temp file already gone
		}
	}
}

/** pdftotext: fast plain-text extraction, the fallback when anymd is missing or fails. */
async function execPdftotext(path: string): Promise<string> {
	const text = await new Promise<string>((resolvePromise, reject) => {
		execFile(
			"pdftotext",
			["-layout", "-enc", "UTF-8", path, "-"],
			{ maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
			(error, stdout) => {
				if (error && !stdout) {
					const hint = /ENOENT/.test(String(error.message))
						? "pdftotext not found — run `brew install poppler`"
						: `pdftotext failed: ${error.message}`;
					reject(new Error(hint));
					return;
				}
				resolvePromise(stdout);
			},
		);
	});
	const clean = text.replace(/\u0000/g, "").trim();
	if (!clean) throw new Error("pdftotext produced no text (scanned PDF? try mutool / OCR)");
	return clean;
}

async function pdfToText(url: string, signal?: AbortSignal): Promise<Page> {
	const temp = await downloadToTemp(url, signal);
	try {
		return { url, title: basename(new URL(url).pathname) || url, content: await execPdftotext(temp), source: "pdftotext" };
	} finally {
		try {
			unlinkSync(temp);
		} catch {
			// temp file already gone
		}
	}
}

/** Local document: the same anymd → pdftotext ladder, minus the download. */
async function localToText(path: string): Promise<Page> {
	const title = basename(path);
	const attempts: Array<[string, () => Promise<string>]> = [["anymd", () => execAnymd(path)]];
	if (/\.pdf$/i.test(path)) attempts.push(["pdftotext", () => execPdftotext(path)]);
	const errors: string[] = [];
	for (const [name, run] of attempts) {
		try {
			return { url: path, title, content: await run(), source: name === "anymd" ? "anymd" : "pdftotext", note: "local file, never uploaded" };
		} catch (error) {
			errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`Cannot read local file ${path}\n  ${errors.join("\n  ")}`);
}

const getSearchContent = defineTool({
	name: "get_search_content",
	label: "Get Search Content",
	promptSnippet: "Page or grep the full text stored under a responseId",
	promptGuidelines: ["findText beats paging for long text; ids expire after 7 days."],
	description: "Read the full text stored behind a responseId: pick a query/URL, page with offset/limit, or jump to matches with findText.",
	parameters: Type.Object({
		responseId: Type.String({ description: "responseId from web_search or fetch_content." }),
		query: Type.Optional(Type.String({ description: "Pick a stored query by text." })),
		queryIndex: Type.Optional(Type.Number({ description: "Pick a stored query by index, default 0.", minimum: 0 })),
		url: Type.Optional(Type.String({ description: "Pick a stored block by URL substring." })),
		urlIndex: Type.Optional(Type.Number({ description: "Pick a stored block by index, default 0.", minimum: 0 })),
		offset: Type.Optional(Type.Number({ description: "Char offset, default 0.", minimum: 0 })),
		limit: Type.Optional(Type.Number({ description: "Chars to return (1-30000), default 8000.", minimum: 1, maximum: 30000 })),
		findText: Type.Optional(
			Type.Union([Type.String(), Type.Array(Type.String(), { maxItems: 10 })], { description: "Substring(s) to jump to: returns windows, not a contiguous block." }),
		),
		findMode: Type.Optional(Type.String({ description: "findText mode: exact|case-insensitive|fuzzy." })),
	}),
	async execute(_toolCallId, params) {
		const stored = loadStored(params.responseId);
		if (!stored) throw new Error(`Unknown or expired responseId: ${params.responseId} (cache keeps 7 days)`);

		interface Entry {
			label: string;
			text: string;
			meta: string[];
		}
		const entries: Entry[] = [];
		if (stored.kind === "search") {
			for (const [qIndex, query] of stored.queries.entries()) {
				for (const [hIndex, hit] of query.hits.entries()) {
					entries.push({
						label: `query#${qIndex} "${query.query}" · result ${hIndex + 1}`,
						text: hit.content || hit.snippet || "",
						meta: [hit.title, hit.url, query.provider],
					});
				}
			}
		} else {
			for (const [index, page] of stored.pages.entries()) {
				entries.push({ label: `page ${index + 1}`, text: page.content, meta: [page.title, page.url, page.source] });
			}
		}
		if (entries.length === 0) throw new Error(`${stored.id} has no stored text`);

		if (params.query) {
			const wanted = params.query.toLowerCase();
			const filtered = entries.filter((entry) => entry.label.toLowerCase().includes(wanted));
			if (filtered.length === 0) throw new Error(`No stored query matching "${params.query}" in ${stored.id}`);
			entries.splice(0, entries.length, ...filtered);
		} else if (typeof params.queryIndex === "number" && stored.kind === "search") {
			const filtered = entries.filter((entry) => entry.label.startsWith(`query#${params.queryIndex} `));
			if (filtered.length === 0) throw new Error(`queryIndex ${params.queryIndex} out of range in ${stored.id}`);
			entries.splice(0, entries.length, ...filtered);
		}

		if (params.url) {
			const wanted = params.url.toLowerCase();
			const match = entries.find((entry) => entry.meta.some((m) => m.toLowerCase().includes(wanted)));
			if (!match) throw new Error(`No stored result matching "${params.url}" in ${stored.id}`);
			entries.splice(0, entries.length, match);
		} else if (typeof params.urlIndex === "number") {
			const match = entries[params.urlIndex];
			if (!match) throw new Error(`urlIndex ${params.urlIndex} out of range (0-${entries.length - 1}) in ${stored.id}`);
			entries.splice(0, entries.length, match);
		}

		const limit = clamp(params.limit, 8000, 1, 30000);
		const header = `${stored.id} · ${stored.kind} · ${stored.createdAt} · ${entries.length} stored block(s)`;

		if (params.findText) {
			const needles = (Array.isArray(params.findText) ? params.findText : [params.findText]).filter((n) => n.trim());
			if (needles.length === 0) throw new Error("findText was empty");
			const mode = params.findMode ?? "case-insensitive";
			const sections: string[] = [];
			for (const entry of entries) {
				for (const needle of needles) {
					const flags = mode === "exact" ? "g" : "gi";
					const pattern = mode === "fuzzy" ? needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") : needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					let re: RegExp;
					try {
						re = new RegExp(pattern, flags);
					} catch {
						continue;
					}
					let hits = 0;
					for (const match of entry.text.matchAll(re)) {
						if (hits >= 5) break;
						const at = match.index ?? 0;
						const start = Math.max(0, at - 300);
						const end = Math.min(entry.text.length, at + needle.length + 300);
						sections.push(
							`### ${entry.label}\n${entry.meta.join(" · ")}\n…${entry.text.slice(start, end).trim()}…\n(at char ${num(at)})`,
						);
						hits += 1;
					}
				}
			}
			if (sections.length === 0) throw new Error(`findText "${needles.join(", ")}" not found in ${stored.id}`);
			return {
				content: [{ type: "text", text: `${header}\n\n${sections.slice(0, 10).join("\n\n")}` }],
				details: { responseId: stored.id, matches: sections.length },
			};
		}

		const total = entries.reduce((sum, entry) => sum + entry.text.length, 0);
		let offset = Math.max(0, Math.round(params.offset ?? 0));
		if (offset >= total) throw new Error(`offset ${offset} is past the end (${num(total)} chars) in ${stored.id}`);
		const parts: string[] = [];
		let remaining = limit;
		let cursor = 0;
		let label = "";
		for (const entry of entries) {
			const end = cursor + entry.text.length;
			if (end <= offset) {
				cursor = end;
				continue;
			}
			if (remaining <= 0) break;
			const localStart = Math.max(0, offset - cursor);
			const take = Math.min(remaining, entry.text.length - localStart);
			parts.push(`### ${entry.label}\n${entry.meta.join(" · ")}\n\n${entry.text.slice(localStart, localStart + take)}`);
			remaining -= take;
			cursor = end;
			if (!label) label = entry.label;
		}
		const shownEnd = Math.min(total, offset + limit);
		return {
			content: [
				{
					type: "text",
					text: `${header}\nchars ${num(offset)}–${num(shownEnd)} of ${num(total)}${label ? ` · from ${label}` : ""}\n\n${parts.join("\n\n")}`,
				},
			],
			details: { responseId: stored.id, offset, total, returned: shownEnd - offset },
		};
	},
});

// -------------------------------------------------------------- registration

export default function (pi: ExtensionAPI) {
	pi.registerTool(webSearch);
	pi.registerTool(fetchContent);
	pi.registerTool(getSearchContent);

	pi.registerCommand("web-status", {
		description: "Show pi-deepread routing, keys and cache usage",
		handler: async (_args, ctx) => {
			const ds = deepseekKey() ? "ok" : "missing";
			const exa = exaKey() ? "ok" : "missing";
			let files = 0;
			let bytes = 0;
			try {
				for (const name of readdirSync(cacheDir())) {
					if (!name.endsWith(".json")) continue;
					files += 1;
					bytes += statSync(join(cacheDir(), name)).size;
				}
			} catch {
				// cache dir not created yet
			}
			ctx.ui.notify(
				[
					`engines: deepseek ${ds} · exa ${exa}`,
					"routing: auto → DeepSeek; exa for 公众号/小红书/YouTube/V2EX or on failure / 0 results / >128-char queries",
					`deepseek: search timeout ${DS_SEARCH_TIMEOUT_MS / 1000}s · fetch timeout ${fetchTimeoutMs() / 1000}s · fetch gap ${fetchGapMs()}ms`,
					`ocr shim: ${ANYMD_SHIM && existsSync(ANYMD_SHIM) ? ANYMD_SHIM : "not found (English-only OCR, set ANYMD_SHIM_DIR)"}`,
					`cache: ${files} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB (keep ${CACHE_KEEP_DAYS}d / ${CACHE_KEEP_FILES} files / 64 MB)`,
					`config: ${join(agentDir(), "web-search.json")}`,
				].join("\n"),
				ds === "missing" ? "warning" : "info",
			);
		},
	});
}
