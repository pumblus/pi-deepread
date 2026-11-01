/** Bench harness: capture tool registration with a fake API, not Pi’s real loader. */
export interface LoadedTool {
	name: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
	execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: (u: any) => void) => Promise<any>;
}

/** Dynamic import so a scenario can set PI_CODING_AGENT_DIR (config dir) before load. */
export async function loadTools(): Promise<Map<string, LoadedTool>> {
	const ext = (await import("../extensions/web-access.ts")).default;
	const tools = new Map<string, LoadedTool>();
	const fake = {
		registerTool: (tool: LoadedTool) => tools.set(tool.name, tool),
		registerCommand: () => {},
	};
	(ext as any)(fake);
	return tools;
}

export function textOf(result: any): string {
	const content = result?.content ?? [];
	return content
		.filter((part: any) => part?.type === "text")
		.map((part: any) => part.text)
		.join("\n");
}

export async function timeIt<T>(fn: () => Promise<T>): Promise<{ value?: T; ms: number; error?: string }> {
	const started = performance.now();
	try {
		const value = await fn();
		return { value, ms: Math.round(performance.now() - started) };
	} catch (error) {
		return { ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message.split("\n")[0] : String(error) };
	}
}

export function log(label: string, payload: unknown): void {
	console.log(`\n### ${label}`);
	console.log(typeof payload === "string" ? payload : JSON.stringify(payload));
}

export function urlsIn(text: string): string[] {
	return [...text.matchAll(/https?:\/\/[^\s)"']+/g)].map((m) => m[0]);
}
