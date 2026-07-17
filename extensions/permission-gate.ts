/**
 * Permission Gate Extension
 *
 * Claude Code style permissions for bash, write, and edit tool calls:
 * - Wildcard rules (allow/ask/deny) from ~/.pi/agent/permissions.json and .pi/permissions.json,
 *   evaluated last-match-wins; project rules load after global so they win ties.
 * - Chained bash commands are split into units; the most restrictive verdict wins.
 * - Shell wrappers (sudo, sh -c, eval, env, xargs) can never ride an allow: floored to ask.
 * - Prompt offers once / session-allow / always-allow (persisted to project config) / block.
 * - Fail closed: a crash inside the gate blocks the call; non-interactive ask blocks.
 *
 * Rule engine modeled on @gotgenes/pi-permission-system, trimmed to a single file.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Action = "allow" | "ask" | "deny";
type Surface = "bash" | "write" | "edit";
type RuleMap = Partial<Record<Surface, Record<string, Action>>>;

const GLOBAL_CONFIG = path.join(os.homedir(), ".pi", "agent", "permissions.json");
const PROJECT_CONFIG_REL = path.join(".pi", "permissions.json");

// Built-in floor: commands that always at least ask, regardless of allow rules
const DANGEROUS = [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/, /\bgit\s+reset\s+--hard/, /\bgit\s+clean\s+-[a-z]*f/, /\bfind\b.*-delete/, /\b(dd|mkfs|shred)\b/];
const WRAPPERS = /^\s*(sudo|sh\s+-c|bash\s+-c|zsh\s+-c|eval|env|xargs|nohup|time)\b/;
// Commands whose first two words form a meaningful prefix for pattern suggestions
const TWO_WORD_PREFIX = new Set(["git", "npm", "pnpm", "yarn", "bun", "cargo", "docker", "kubectl", "gh", "uv", "pi", "brew"]);

function compileWildcard(pattern: string): RegExp {
	const expanded = pattern.replace(/^~(?=\/|$)/, os.homedir()).replace(/\$HOME\b/, os.homedir());
	let source = "";
	for (const ch of expanded) {
		if (ch === "*") source += ".*";
		else if (ch === "?") source += ".";
		else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	// A pattern ending in " *" also matches the bare command without arguments
	if (source.endsWith(" .*")) source = `${source.slice(0, -3)}( .*)?`;
	return new RegExp(`^${source}$`, "s");
}

function readRules(file: string): RuleMap {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as RuleMap;
	} catch {
		return {};
	}
}

function evaluate(rules: Array<[string, Action]>, value: string): Action | undefined {
	let verdict: Action | undefined;
	for (const [pattern, action] of rules) {
		if (compileWildcard(pattern).test(value)) verdict = action;
	}
	return verdict;
}

function splitUnits(command: string): string[] {
	return command
		.split(/&&|\|\||;|\|/)
		.map((unit) => unit.trim())
		.filter(Boolean);
}

function suggestPattern(command: string): string {
	const words = splitUnits(command)[0]?.split(/\s+/) ?? [];
	if (words.length === 0) return command;
	const prefixLength = TWO_WORD_PREFIX.has(words[0]) && words.length > 1 ? 2 : 1;
	return `${words.slice(0, prefixLength).join(" ")} *`;
}

function mostRestrictive(a: Action, b: Action): Action {
	const rank: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };
	return rank[a] >= rank[b] ? a : b;
}

export default function permissionGate(pi: ExtensionAPI) {
	let rules: Partial<Record<Surface, Array<[string, Action]>>> = {};
	let projectConfigPath = PROJECT_CONFIG_REL;
	const sessionAllows: Array<[Surface, string]> = [];

	function loadRules(cwd: string): void {
		projectConfigPath = path.join(cwd, PROJECT_CONFIG_REL);
		const merged: RuleMap[] = [readRules(GLOBAL_CONFIG), readRules(projectConfigPath)];
		rules = {};
		for (const map of merged) {
			for (const surface of ["bash", "write", "edit"] as Surface[]) {
				const entries = Object.entries(map[surface] ?? {}) as Array<[string, Action]>;
				if (entries.length > 0) rules[surface] = [...(rules[surface] ?? []), ...entries];
			}
		}
	}

	function persistAlways(surface: Surface, pattern: string): void {
		const config = readRules(projectConfigPath);
		config[surface] = { ...config[surface], [pattern]: "allow" };
		fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
		const tmp = `${projectConfigPath}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
		fs.renameSync(tmp, projectConfigPath);
		rules[surface] = [...(rules[surface] ?? []), [pattern, "allow"]];
	}

	function verdictForBash(command: string): Action {
		let verdict: Action = "allow";
		for (const unit of splitUnits(command)) {
			let unitVerdict = evaluate(rules.bash ?? [], unit) ?? "allow";
			if (DANGEROUS.some((p) => p.test(unit))) unitVerdict = mostRestrictive(unitVerdict, "ask");
			if (WRAPPERS.test(unit) && unitVerdict === "allow") unitVerdict = "ask";
			verdict = mostRestrictive(verdict, unitVerdict);
		}
		return verdict;
	}

	function verdictForPath(surface: Surface, filePath: string): Action {
		return evaluate(rules[surface] ?? [], filePath) ?? "allow";
	}

	function isSessionAllowed(surface: Surface, value: string): boolean {
		return sessionAllows.some(([s, pattern]) => s === surface && compileWildcard(pattern).test(value));
	}

	pi.on("session_start", async (_event, ctx) => {
		loadRules(ctx.cwd);
	});

	pi.on("tool_call", async (event, ctx) => {
		try {
			const surface = event.toolName as Surface;
			if (surface !== "bash" && surface !== "write" && surface !== "edit") return undefined;

			const value =
				surface === "bash"
					? (event.input.command as string)
					: ((event.input.path ?? event.input.file_path) as string);
			if (!value) return undefined;

			if (isSessionAllowed(surface, value)) return undefined;

			const verdict = surface === "bash" ? verdictForBash(value) : verdictForPath(surface, value);
			if (verdict === "allow") return undefined;
			if (verdict === "deny") return { block: true, reason: `Denied by permission rule (${surface}).` };

			if (!ctx.hasUI) {
				return { block: true, reason: `Permission required for ${surface} (no UI to ask). Add an allow rule to ${PROJECT_CONFIG_REL}.` };
			}

			const pattern = surface === "bash" ? suggestPattern(value) : value;
			const choice = await ctx.ui.select(`⚠️ Permission required (${surface}):\n\n  ${value}\n\nAllow?`, [
				"Yes (once)",
				`Yes, allow "${pattern}" for this session`,
				`Yes, always allow "${pattern}" (saved to project)`,
				"No (block)",
			]);

			if (choice === "Yes (once)") return undefined;
			if (choice?.startsWith("Yes, allow")) {
				sessionAllows.push([surface, pattern]);
				return undefined;
			}
			if (choice?.startsWith("Yes, always")) {
				persistAlways(surface, pattern);
				ctx.ui.notify(`Allowed "${pattern}" via ${PROJECT_CONFIG_REL}`, "info");
				return undefined;
			}
			return { block: true, reason: "Blocked by user." };
		} catch (error) {
			return { block: true, reason: `Permission gate error, failing closed: ${String(error)}` };
		}
	});

	pi.registerCommand("permissions", {
		description: "Show active permission rules",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			for (const surface of ["bash", "write", "edit"] as Surface[]) {
				for (const [pattern, action] of rules[surface] ?? []) lines.push(`${surface}: ${pattern} -> ${action}`);
			}
			for (const [surface, pattern] of sessionAllows) lines.push(`${surface}: ${pattern} -> allow (session)`);
			ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No rules configured. Dangerous commands still ask.", "info");
		},
	});
}
