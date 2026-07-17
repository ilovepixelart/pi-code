/**
 * Status Line Extension
 *
 * Adds a Claude Code style status segment to pi's footer: turn state plus
 * running session cost. Cost is summed from per-message usage on the current
 * branch, so it stays correct across /tree navigation and forks.
 *
 * pi's built-in footer already shows path, branch, context, and model;
 * this extension only adds what is missing instead of replacing the footer.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface UsageEntry {
	type: string;
	message?: { usage?: { cost?: { total?: number } } };
}

function sessionCost(ctx: ExtensionContext): number {
	let total = 0;
	for (const entry of ctx.sessionManager.getBranch() as UsageEntry[]) {
		total += entry.message?.usage?.cost?.total ?? 0;
	}
	return total;
}

function formatCost(cost: number): string {
	return cost >= 0.01 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

export default function statusLine(pi: ExtensionAPI) {
	let turnCount = 0;

	function showIdle(ctx: ExtensionContext, symbol: string): void {
		const theme = ctx.ui.theme;
		const cost = sessionCost(ctx);
		const costText = cost > 0 ? theme.fg("muted", ` ${formatCost(cost)}`) : "";
		const turnText = turnCount > 0 ? theme.fg("dim", ` turn ${turnCount}`) : theme.fg("dim", " ready");
		ctx.ui.setStatus("pi-code-status", symbol + turnText + costText);
	}

	pi.on("session_start", async (_event, ctx) => {
		showIdle(ctx, ctx.ui.theme.fg("dim", "○"));
	});

	pi.on("turn_start", async (_event, ctx) => {
		turnCount++;
		const theme = ctx.ui.theme;
		ctx.ui.setStatus("pi-code-status", theme.fg("accent", "●") + theme.fg("dim", ` turn ${turnCount}...`));
	});

	pi.on("turn_end", async (_event, ctx) => {
		showIdle(ctx, ctx.ui.theme.fg("success", "✓"));
	});

	pi.on("agent_end", async (_event, ctx) => {
		showIdle(ctx, ctx.ui.theme.fg("success", "✓"));
	});
}
