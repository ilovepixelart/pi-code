/**
 * Claude Rules Extension
 *
 * Replicates Claude Code's rules loading:
 * - Global rules (~/.claude/rules/*.md) are inlined in full into the system prompt.
 * - Project rules (.claude/rules/*.md) are listed as pointers the agent can read on demand.
 *
 * Adapted from the pi v0.74.2 claude-rules example.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Recursively find all .md files in a directory
 */
function findMarkdownFiles(dir: string, basePath: string = ""): string[] {
	const results: string[] = [];

	if (!fs.existsSync(dir)) {
		return results;
	}

	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

		if (entry.isDirectory()) {
			results.push(...findMarkdownFiles(path.join(dir, entry.name), relativePath));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			results.push(relativePath);
		}
	}

	return results;
}

function readGlobalRules(globalRulesDir: string): string {
	const files = findMarkdownFiles(globalRulesDir);

	return files
		.map((f) => fs.readFileSync(path.join(globalRulesDir, f), "utf-8").trim())
		.filter((content) => content.length > 0)
		.join("\n\n");
}

export default function claudeRulesExtension(pi: ExtensionAPI) {
	const globalRulesDir = path.join(os.homedir(), ".claude", "rules");
	let globalRules = "";
	let projectRuleFiles: string[] = [];

	pi.on("session_start", async (_event, ctx) => {
		globalRules = readGlobalRules(globalRulesDir);
		projectRuleFiles = findMarkdownFiles(path.join(ctx.cwd, ".claude", "rules"));

		if (globalRules.length > 0 || projectRuleFiles.length > 0) {
			ctx.ui.notify(
				`Rules loaded: global ${globalRules.length > 0 ? "yes" : "no"}, project ${projectRuleFiles.length}`,
				"info",
			);
		}
	});

	pi.on("before_agent_start", async (event) => {
		let addition = "";

		if (globalRules.length > 0) {
			addition += `\n\n## Global Rules\n\nThese rules always apply:\n\n${globalRules}`;
		}

		if (projectRuleFiles.length > 0) {
			const rulesList = projectRuleFiles.map((f) => `- .claude/rules/${f}`).join("\n");
			addition += `\n\n## Project Rules\n\nThe following project rules are available in .claude/rules/:\n\n${rulesList}\n\nWhen working on tasks related to these rules, use the read tool to load the relevant rule files for guidance.`;
		}

		if (addition.length === 0) {
			return;
		}

		return { systemPrompt: event.systemPrompt + addition };
	});
}
