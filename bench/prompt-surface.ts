/** Measure the model-facing prompt surface this extension adds to every Pi request.
 *  Everything here is paid on EVERY turn, so it is the metric the package gets judged on. */
import { loadTools } from "./lib.ts";

const tools = await loadTools();

interface Row {
	tool: string;
	snippet: number;
	description: number;
	guidelines: number;
	parameters: number;
	total: number;
}

const rows: Row[] = [];
for (const tool of tools.values()) {
	const snippet = tool.promptSnippet?.length ?? 0;
	const description = tool.description?.length ?? 0;
	const guidelines = (tool.promptGuidelines ?? []).join("").length;
	const parameters = JSON.stringify(tool.parameters).length;
	rows.push({ tool: tool.name, snippet, description, guidelines, parameters, total: snippet + description + guidelines + parameters });
}

const sum = (pick: (row: Row) => number) => rows.reduce((acc, row) => acc + pick(row), 0);
const grandTotal = sum((row) => row.total);

console.log("model-facing prompt surface (chars / ~tokens at 3.6 chars per token)\n");
for (const row of rows) {
	console.log(
		`${row.tool.padEnd(20)} snippet ${String(row.snippet).padStart(4)} · desc ${String(row.description).padStart(4)} · guides ${String(
			row.guidelines,
		).padStart(4)} · params ${String(row.parameters).padStart(4)} → ${String(row.total).padStart(5)} chars (~${Math.round(row.total / 3.6)} tok)`,
	);
}
console.log(
	`\nTOTAL ${grandTotal} chars (~${Math.round(grandTotal / 3.6)} tokens) across ${rows.length} tools` +
		`\n      snippet ${sum((r) => r.snippet)} · desc ${sum((r) => r.description)} · guides ${sum((r) => r.guidelines)} · params ${sum(
			(r) => r.parameters,
		)}`,
);
