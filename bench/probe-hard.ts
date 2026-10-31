/** Throwaway probe: which URL classes does each extraction path actually fail on? */
import { loadTools, timeIt, textOf } from "./lib.ts";

if (process.env.WEB_BENCH_LIVE !== "1") {
	console.error("Set WEB_BENCH_LIVE=1 to enable live requests that may incur API charges.");
	process.exit(2);
}

const tools = await loadTools();
const fetchContent = tools.get("fetch_content")!;

const candidates = [
	"https://www.ft.com/technology",
	"https://www.reuters.com/technology/",
	"https://www.wsj.com/tech",
	"https://www.zhihu.com/question/19550225",
	"https://zhuanlan.zhihu.com/p/670569812",
	"https://www.nature.com/articles/s41586-023-06221-2",
	"https://www.science.org/doi/10.1126/science.abm8952",
	"https://mp.weixin.qq.com/s/2mXHrWlbLHOsMWBQNgaqvA",
];

for (const url of candidates) {
	const { value, ms, error } = await timeIt(() => fetchContent.execute("p", { url, maxChars: 400 }, undefined, () => {}));
	if (error) {
		process.exitCode = 1;
		console.log(`FAIL ${String(ms).padStart(5)}ms ${url}\n     ${error}`);
		continue;
	}
	const text = textOf(value);
	const meta = /(\S+) 字符 · (\S+) · (?:(?:full|partial|summary|unknown|extracted) · )?([0-9.]+)s/.exec(text);
	console.log(`OBS  ${String(ms).padStart(5)}ms ${url} → ${meta ? `${meta[1]} chars via ${meta[2]}` : "?"}`);
}
