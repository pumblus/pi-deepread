/** Bench scenarios, grouped by optimisation phase. Run: `node bench/scenarios.ts p0|p1|p2|all`.
 *  Everything goes through the real tool execute() path with real API calls. */
import { loadTools, textOf, timeIt } from "./lib.ts";

const group = process.argv[2] ?? "all";
const NOEXA_DIR = "/tmp/pi-deepread-bench/agent-noexa";
const LOCAL_PDF = "/tmp/pi-deepread-bench/sample.pdf";

const tools = await loadTools();
const search = tools.get("web_search")!;
const fetchTool = tools.get("fetch_content")!;

type Row = Record<string, unknown>;
const rows: Array<Row & { group: string }> = [];
const add = (g: string, row: Row) => rows.push({ group: g, ...row });
const want = (g: string) => group === "all" || group === g;

const call = (tool: typeof fetchTool, params: any) => tool.execute("bench", params, undefined, () => {});
const fetchUrls = (urls: string[], maxChars = 400) => call(fetchTool, { urls, maxChars });
const meta = (text: string) => {
	const m = /([\d,]+) 字符 · (\S+) · ([\d.]+)s/.exec(text);
	return m ? { chars: Number(m[1].replace(/,/g, "")), source: m[2], secs: Number(m[3]) } : undefined;
};

// ------------------------------------------------------------------ P0
if (want("p0")) {
	// 1. search → fetch the same URLs again: pure waste unless the text is already in hand.
	const s1 = await timeIt(() => call(search, { query: "DeepSeek V3.2 发布 官方公告", numResults: 3, contentChars: 300 }));
	const urls = [...textOf(s1.value!).matchAll(/^\s{3}(https?:\/\/\S+)/gm)].map((m) => m[1]!).slice(0, 2);
	const cold = await timeIt(() => fetchUrls(urls));
	const warm = await timeIt(() => fetchUrls(urls));
	add("p0", {
		metric: "search→fetch same URL",
		urls: urls.length,
		coldMs: cold.ms,
		warmMs: warm.ms,
		coldChars: meta(textOf(cold.value!))?.chars,
		warmSource: meta(textOf(warm.value!))?.source,
		coldErr: cold.error,
	});

	// 2. anti-bot / paywall hosts: how many return usable text at all?
	const hard = [
		"https://www.ft.com/technology",
		"https://www.wsj.com/tech",
		"https://www.zhihu.com/question/19550225",
		"https://www.science.org/doi/10.1126/science.abm8952",
		"https://www.reuters.com/technology/",
		"https://mp.weixin.qq.com/s/2mXHrWlbLHOsMWBQNgaqvA",
	];
	let ok = 0;
	const detail: string[] = [];
	for (const url of hard) {
		const r = await timeIt(() => call(fetchTool, { url, maxChars: 400 }));
		const info = r.value ? meta(textOf(r.value)) : undefined;
		const usable = Boolean(info && info.chars >= 400);
		if (usable) ok += 1;
		detail.push(`${new URL(url).hostname}:${r.error ? "FAIL" : `${info?.chars ?? 0}c/${info?.source}/${info?.secs}s`}${usable ? "" : "(unusable)"}`);
	}
	add("p0", { metric: "blocked hosts usable", usable: `${ok}/${hard.length}`, detail });

	// 3. a document already on disk must not need a network round trip.
	const local = await timeIt(() => call(fetchTool, { url: LOCAL_PDF, maxChars: 400 }));
	add("p0", {
		metric: "local file path",
		ok: !local.error && (meta(textOf(local.value!))?.chars ?? 0) > 1000,
		ms: local.ms,
		source: local.value ? meta(textOf(local.value))?.source : undefined,
		err: local.error?.slice(0, 90),
	});
}

// ------------------------------------------------------------------ P1
if (want("p1")) {
	// 1. six independent hosts: global pacing makes this slower than its slowest member.
	const spread = [
		"https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)",
		"https://github.com/deepseek-ai/DeepSeek-V3",
		"https://react.dev/learn",
		"https://docs.python.org/3/library/asyncio.html",
		"https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
		"https://news.ycombinator.com/item?id=1",
	];
	const wide = await timeIt(() => fetchUrls(spread, 300));
	const wideText = textOf(wide.value ?? { content: [] });
	add("p1", {
		metric: "6 distinct hosts",
		ms: wide.ms,
		ok: (wide.value?.details?.ok ?? 0) + "/6",
		sumSecs: Number(([...wideText.matchAll(/· ([\d.]+)s/g)].reduce((a, m) => a + Number(m[1]), 0)).toFixed(2)),
		err: wide.error,
	});

	// 2. arXiv: HTML full text (~1 s) beats downloading the PDF.
	for (const url of ["https://arxiv.org/abs/2405.04434", "https://arxiv.org/abs/1706.03762"]) {
		const r = await timeIt(() => call(fetchTool, { url, maxChars: 400 }));
		const info = r.value ? meta(textOf(r.value)) : undefined;
		add("p1", { metric: `arxiv ${url.split("/").pop()}`, ms: r.ms, chars: info?.chars, source: info?.source, secs: info?.secs, err: r.error?.slice(0, 80) });
	}

	// 3. SPA / docs pages: how much nav boilerplate survives into the output.
	const boiler = ["Skip to content", "On this page", "Menu", "Search documentation", "Documentation", "Navigation", "Table of contents"];
	for (const url of ["https://react.dev/learn", "https://docs.python.org/3/library/asyncio.html"]) {
		const r = await timeIt(() => call(fetchTool, { url, maxChars: 2000 }));
		const text = r.value ? textOf(r.value) : "";
		const head = text.slice(0, 1500);
		add("p1", {
			metric: `noise ${new URL(url).hostname}`,
			junkHits: boiler.filter((word) => head.toLowerCase().includes(word.toLowerCase())).length,
			firstPara: head.split("\n").filter((line) => line.trim().length > 60)[0]?.trim().slice(0, 70) ?? "",
			chars: meta(text)?.chars,
			source: meta(text)?.source,
		});
	}

	// 4. Boilerplate stripping, measured offline so the crawl path cannot flatter it:
	//    the same HTML through a naive tag strip versus the article-scoped extractor.
	const { htmlToText } = await import("../extensions/web-access.ts");
	const NAVY = [
		"https://www.theverge.com/",
		"https://docs.python.org/3/library/asyncio.html",
		"https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)",
	];
	for (const url of NAVY) {
		const started = Date.now();
		try {
			const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh) Chrome/131.0" } });
			const html = await res.text();
			const naive = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
			const scoped = htmlToText(html).text;
			add("p1", {
				metric: `sanitize ${new URL(url).hostname}`,
				ms: Date.now() - started,
				naiveChars: naive.length,
				scopedChars: scoped.length,
				keptPct: Number(((scoped.length / naive.length) * 100).toFixed(1)),
				naiveJunk: boiler.filter((word) => naive.toLowerCase().includes(word.toLowerCase())).length,
				scopedJunk: boiler.filter((word) => scoped.toLowerCase().includes(word.toLowerCase())).length,
				scopedFirst: scoped.split("\n").find((line) => line.length > 60)?.slice(0, 60) ?? "",
			});
		} catch (error) {
			add("p1", { metric: `sanitize ${new URL(url).hostname}`, err: error instanceof Error ? error.message.slice(0, 60) : String(error) });
		}
	}
}

// ------------------------------------------------------------------ P2
if (want("p2") || group === "noexa") {
	// Run with a config dir that has no Exa key: exits code 3 = "needs noexa env".
	const cfg = process.env.PI_CODING_AGENT_DIR ?? "";
	if (!cfg.startsWith(NOEXA_DIR)) {
		add("p2", { metric: "no-exa scenarios", note: `re-run with PI_CODING_AGENT_DIR=${NOEXA_DIR}` });
	} else {
		// 1. a query whose compiled form exceeds DeepSeek's hard 128-char cap
		const long = await timeIt(() =>
			call(search, {
				query: "2024 年开源大模型推理框架 vLLM SGLang TensorRT-LLM llama.cpp MLX 的性能对比与显存占用差异分析报告",
				domainFilter: ["zhihu.com", "juejin.cn", "-mp.weixin.qq.com", "-xiaohongshu.com"],
				recencyFilter: "year",
				numResults: 3,
				contentChars: 200,
			}),
		);
		add("p2", { metric: "query >128 chars, no exa", ok: !long.error, ms: long.ms, err: long.error?.slice(0, 140) });

		// 2. blind-spot host with no Exa key: does the model get told the truth?
		const blind = await timeIt(() => call(search, { query: "小红书 露营装备 避坑", numResults: 3, contentChars: 200 }));
		const blindText = textOf(blind.value ?? { content: [] });
		add("p2", {
			metric: "blind spot, no exa",
			ok: !blind.error,
			hits: Number(/^(\d+) 结果/m.exec(blindText)?.[1] ?? 0),
			warns: /可能不完整|outside DeepSeek|incomplete|Exa/i.test(blindText),
			err: blind.error?.slice(0, 120),
		});

		// 3. contentChars 6000 across 5 hits: how many hits get body text?
		const budget = await timeIt(() => call(search, { query: "site:arxiv.org transformer attention mechanism survey", numResults: 5, contentChars: 6000 }));
		const budgetText = textOf(budget.value ?? { content: [] });
		add("p2", {
			metric: "budget spread (5 hits)",
			withBody: budgetText.split(/\n(?=\d+\. )/).slice(1).filter((block) => block.split("\n").length > 3).length,
			chars: budgetText.length,
			err: budget.error?.slice(0, 120),
		});
	}
}

console.log(JSON.stringify(rows, null, 1));
