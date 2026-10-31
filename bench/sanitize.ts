/** Deterministic HTML fixture check. No network or API keys required. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { htmlToText } from "../extensions/web-access.ts";
const html = readFileSync(new URL("./fixtures/article.html", import.meta.url), "utf8");
const { title, text } = htmlToText(html);
assert.equal(title, "Deep Read fixture");
for (const fact of ["ORCHID-73", "兰花七十三", "27.4 units"]) assert.ok(text.includes(fact), `Lost article fact: ${fact}`);
for (const noise of ["secret_noise_token", "Search documentation", "Footer tracking notice"]) assert.ok(!text.includes(noise), `Retained page noise: ${noise}`);
console.log("PASS fixed HTML: title, Chinese body and final fact retained; navigation/script/footer removed");
