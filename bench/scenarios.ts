/** Optional live observations, not a replacement for the offline npm test gate.
 * WEB_BENCH_LIVE=1 node bench/scenarios.ts p0|p1|p2|noexa|all
 * Calls may incur API charges. The fake registration harness is not Pi's loader.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools, textOf, timeIt } from "./lib.ts";

const group = process.argv[2] ?? "all";
if (!["p0", "p1", "p2", "noexa", "all"].includes(group)) throw new Error(`Unknown group: ${group}`);
if (process.env.WEB_BENCH_LIVE !== "1") {
	console.error("Live bench disabled. Run npm test for offline checks. Set WEB_BENCH_LIVE=1 to allow requests that may incur API charges.");
	process.exit(2);
}

// Configuration is cached on import: isolate before loading the extension. Never copy
// auth.json or config key commands, which could silently reintroduce Exa credentials.
let isolatedDir: string | undefined;
if (group === "noexa" || group === "p2") {
	if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error("noexa requires DEEPSEEK_API_KEY; no existing config/auth files are read");
	isolatedDir = mkdtempSync(join(tmpdir(), "pi-deepread-noexa-"));
	process.env.PI_CODING_AGENT_DIR = isolatedDir;
	delete process.env.EXA_API_KEY;
}

const tools = await loadTools();
const search = tools.get("web_search")!;
const fetchTool = tools.get("fetch_content")!;
type Status = "pass" | "fail" | "skip" | "observation";
type Row = { group: string; metric: string; status: Status; [key: string]: unknown };
const rows: Row[] = [];
const add = (g: string, metric: string, status: Status, details: Record<string, unknown> = {}) => rows.push({ group: g, metric, status, ...details });
const want = (g: string) => group === "all" || group === g;
const call = (tool: typeof fetchTool, params: any) => tool.execute("bench", params, undefined, () => {});
const fetchUrls = (urls: string[], maxChars = 400) => call(fetchTool, { urls, maxChars });
const meta = (text: string) => {
	const m = /([\d,]+) 字符 · (\S+) · (?:(?:full|partial|summary|unknown|extracted) · )?([\d.]+)s/.exec(text);
	return m ? { chars: Number(m[1].replace(/,/g, "")), source: m[2], secs: Number(m[3]) } : undefined;
};
const failure = (r: Awaited<ReturnType<typeof timeIt>>) => r.error || (r.value as any)?.isError || ((r.value as any)?.details?.failed ?? 0) > 0;

try {
	if (want("p0")) {
		// This URL has not been searched in this process. Do not label a search-warmed fetch cold.
		const coldUrl = process.env.WEB_BENCH_COLD_URL;
		if (!coldUrl) add("p0", "empty-session fetch → repeat", "skip", { reason: "Set WEB_BENCH_COLD_URL to a fixed article. Offline tests assert request counts." });
		else {
			const cold = await timeIt(() => call(fetchTool, { url: coldUrl, maxChars: 500 }));
			const repeat = await timeIt(() => call(fetchTool, { url: coldUrl, maxChars: 500 }));
			add("p0", "empty-session fetch → repeat", failure(cold) || failure(repeat) ? "fail" : "observation", {
				url: coldUrl, firstMs: cold.ms, repeatMs: repeat.ms,
				first: meta(textOf(cold.value)), repeat: meta(textOf(repeat.value)), errors: [cold.error, repeat.error],
				note: "Timing alone does not prove a cache hit or content correctness.",
			});
		}
		const s = await timeIt(() => call(search, { query: "DeepSeek V3.2 发布 官方公告", numResults: 3, contentChars: 300 }));
		const urls = [...textOf(s.value).matchAll(/^\s{3}(https?:\/\/\S+)/gm)].map((m) => m[1]!).slice(0, 2);
		if (failure(s) || !urls.length) add("p0", "search → fetch", "fail", { error: s.error ?? "No result URLs" });
		else {
			const fetched = await timeIt(() => fetchUrls(urls));
			add("p0", "search → fetch (possibly pre-warmed)", failure(fetched) ? "fail" : "observation", {
				urls, searchMs: s.ms, fetchMs: fetched.ms, error: fetched.error,
				note: "Partial search text may correctly require an extra fetch; this is not a cold-start test.",
			});
		}
		const localPdf = process.env.WEB_BENCH_LOCAL_PDF;
		const expected = process.env.WEB_BENCH_LOCAL_EXPECT;
		if (!localPdf || !existsSync(localPdf) || !expected) add("p0", "local document known fact", "skip", { reason: "Set WEB_BENCH_LOCAL_PDF and WEB_BENCH_LOCAL_EXPECT. Byte count is not a correctness check." });
		else {
			const r = await timeIt(() => call(fetchTool, { url: localPdf, maxChars: 12000 }));
			add("p0", "local document known fact", !failure(r) && textOf(r.value).includes(expected) ? "pass" : "fail", { ms: r.ms, error: r.error, note: "Offline tests separately assert zero network calls." });
		}
	}

	if (want("p1")) {
		const spread = ["https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)", "https://github.com/deepseek-ai/DeepSeek-V3", "https://react.dev/learn", "https://docs.python.org/3/library/asyncio.html", "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API", "https://news.ycombinator.com/item?id=1"];
		const r = await timeIt(() => fetchUrls(spread, 300));
		add("p1", "six-host latency", failure(r) ? "fail" : "observation", { ms: r.ms, successfulExtractions: r.value?.details?.ok, error: r.error, note: "Extraction count is not verified article accuracy." });
		for (const url of ["https://arxiv.org/abs/2405.04434", "https://arxiv.org/abs/1706.03762"]) {
			const r = await timeIt(() => call(fetchTool, { url, maxChars: 400 }));
			add("p1", `arxiv ${url.split("/").pop()}`, failure(r) ? "fail" : "observation", { ms: r.ms, ...meta(textOf(r.value)), error: r.error });
		}
	}

	if (want("p2") || group === "noexa") {
		if (!isolatedDir) add("p2", "isolated no-Exa", "skip", { reason: "Run the noexa group separately to isolate configuration before import." });
		else {
			for (const query of ["分析中文长问题是否完整保留核心意思".repeat(12), "小红书 露营装备 避坑"]) {
				const r = await timeIt(() => call(search, { query, numResults: 3, contentChars: 200 }));
				const providers = r.value?.details?.queries?.map((q: any) => q.provider) ?? [];
				add("p2", query.length > 128 ? "unspaced Chinese query" : "blind spot without Exa", failure(r) || providers.includes("exa") ? "fail" : "observation", { ms: r.ms, providers, error: r.error, note: "Offline request assertions check retained query meaning and limits." });
			}
		}
	}

	// A reviewed corpus supplies expected facts, including one near a long article's tail.
	// Do not invent fixed truths for mutable section pages or count a login wall as success.
	const manifest = process.env.WEB_BENCH_MANIFEST;
	if (!manifest) add("corpus", "reviewed article facts", "skip", { reason: "Set WEB_BENCH_MANIFEST; see docs/TESTING.md." });
	else {
		const cases = JSON.parse(readFileSync(manifest, "utf8"));
		if (!Array.isArray(cases) || !cases.length) throw new Error("Manifest must be a nonempty array");
		for (const item of cases) {
			if (typeof item.url !== "string" || !Array.isArray(item.mustInclude) || !item.mustInclude.length || item.mustInclude.some((s: unknown) => typeof s !== "string" || !s)) throw new Error("Each corpus case needs url and nonempty mustInclude strings");
			const r = await timeIt(() => call(fetchTool, { url: item.url, maxChars: 12000 }));
			let content = "";
			let readError: string | undefined;
			const responseId = r.value?.details?.responseId;
			if (!failure(r) && responseId) {
				const read = tools.get("get_search_content")!;
				let offset = 0;
				for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
					const page = await timeIt(() => call(read, { responseId, offset, limit: 30000 }));
					if (failure(page)) { readError = page.error ?? "Stored content read failed"; break; }
					content += "\n" + textOf(page.value);
					const returned = page.value?.details?.returned ?? 0;
					const total = page.value?.details?.total ?? 0;
					offset += returned;
					if (offset >= total) break;
					if (returned <= 0 || pageNumber === 99) { readError = "Stored content pagination did not finish"; break; }
				}
			} else readError = "No stored extraction to verify";
			const missing = item.mustInclude.filter((fact: string) => !content.includes(fact));
			const forbidden = (item.mustNotInclude ?? []).filter((fact: string) => content.includes(fact));
			add("corpus", item.url, !failure(r) && !readError && !missing.length && !forbidden.length ? "pass" : "fail", { ms: r.ms, missing, forbidden, error: r.error ?? readError });
		}
	}
} finally {
	if (isolatedDir) rmSync(isolatedDir, { recursive: true, force: true });
	console.log(JSON.stringify({ rows, summary: Object.fromEntries(["pass", "fail", "skip", "observation"].map((status) => [status, rows.filter((row) => row.status === status).length])) }, null, 2));
	if (rows.some((row) => row.status === "fail")) process.exitCode = 1;
}
