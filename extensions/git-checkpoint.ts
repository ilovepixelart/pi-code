/**
 * Git Checkpoint Extension
 *
 * Claude Code style /rewind built on git stash checkpoints.
 *
 * Each user prompt gets one checkpoint: `git stash create` runs at the
 * start of the turn, and {entryId, ref, prompt, createdAt} is persisted
 * in the session file, so checkpoints survive restarts and resumes.
 * /rewind picks a checkpoint, then restores "Code and conversation",
 * "Conversation only", or "Code only". Forking still offers to restore
 * code at the fork point.
 *
 * Limitations: `git stash create` snapshots tracked files only, and
 * `git stash apply` merges the snapshot into the working tree (it does
 * not undo changes made after the checkpoint). A clean tree produces no
 * stash ref, so that checkpoint can only restore the conversation.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CUSTOM_TYPE = "git-checkpoint";
const PROMPT_SNIPPET_LENGTH = 60;
const RESTORE_MODES = ["Code and conversation", "Conversation only", "Code only"];

interface Checkpoint {
	entryId: string;
	ref: string;
	prompt: string;
	createdAt: string;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ");
}

function promptSnippet(content: unknown): string {
	const text = extractText(content).replace(/\s+/g, " ").trim();
	if (text.length <= PROMPT_SNIPPET_LENGTH) return text;
	return `${text.slice(0, PROMPT_SNIPPET_LENGTH)}…`;
}

function findLastUserMessage(ctx: ExtensionContext): { entryId: string; prompt: string } | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "message" && entry.message.role === "user") {
			return { entryId: entry.id, prompt: promptSnippet(entry.message.content) };
		}
	}
	return undefined;
}

function checkpointLabel(checkpoint: Checkpoint, index: number): string {
	const time = new Date(checkpoint.createdAt).toLocaleTimeString();
	const marker = checkpoint.ref ? "" : " [no code snapshot]";
	return `${index + 1}. ${time}  ${checkpoint.prompt || "(empty prompt)"}${marker}`;
}

async function restoreCode(pi: ExtensionAPI, ctx: ExtensionCommandContext, checkpoint: Checkpoint): Promise<boolean> {
	if (!checkpoint.ref) {
		ctx.ui.notify("Checkpoint has no code snapshot (tree was clean); code left untouched", "warning");
		return true;
	}
	const result = await pi.exec("git", ["stash", "apply", checkpoint.ref]);
	if (result.code !== 0) {
		ctx.ui.notify(`Code restore failed (stash ref may have been garbage collected): ${result.stderr.trim()}`, "warning");
		return false;
	}
	return true;
}

async function restoreConversation(ctx: ExtensionCommandContext, entryId: string): Promise<boolean> {
	try {
		const result = await ctx.navigateTree(entryId, { summarize: false });
		if (result.cancelled) return false;
		if (typeof result.editorText === "string") ctx.ui.setEditorText(result.editorText);
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Conversation restore failed: ${message}`, "error");
		return false;
	}
}

async function runRestoreMode(pi: ExtensionAPI, ctx: ExtensionCommandContext, checkpoint: Checkpoint): Promise<void> {
	const mode = await ctx.ui.select("Restore mode:", [...RESTORE_MODES]);
	if (!mode) return;
	if (mode !== "Conversation only" && !(await restoreCode(pi, ctx, checkpoint))) return;
	if (mode !== "Code only" && !(await restoreConversation(ctx, checkpoint.entryId))) return;
	ctx.ui.notify("Rewind complete", "info");
}

export default function (pi: ExtensionAPI) {
	const checkpoints = new Map<string, Checkpoint>();
	let pending: { ref: string; createdAt: string } | undefined;

	// Rebuild the checkpoint list from persisted custom entries on every
	// session (re)start, so /rewind works across restarts, resumes, and forks.
	pi.on("session_start", async (_event, ctx) => {
		checkpoints.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
			const checkpoint = entry.data as Checkpoint | undefined;
			if (checkpoint?.entryId) checkpoints.set(checkpoint.entryId, checkpoint);
		}
	});

	// Snapshot code state before the LLM acts in this turn. The user message
	// that started the turn is not persisted yet at turn_start (it lands on
	// message_end), so the checkpoint is only keyed and saved at turn_end.
	pi.on("turn_start", async () => {
		const result = await pi.exec("git", ["stash", "create"]);
		pending = result.code === 0
			? { ref: result.stdout.trim(), createdAt: new Date().toISOString() }
			: undefined;
	});

	// One checkpoint per user prompt: attach the pending snapshot to the last
	// user message on the branch, unless that prompt is already checkpointed.
	pi.on("turn_end", async (_event, ctx) => {
		const snapshot = pending;
		pending = undefined;
		if (!snapshot) return;

		const target = findLastUserMessage(ctx);
		if (!target || checkpoints.has(target.entryId)) return;

		const checkpoint: Checkpoint = {
			entryId: target.entryId,
			ref: snapshot.ref,
			prompt: target.prompt,
			createdAt: snapshot.createdAt,
		};
		checkpoints.set(checkpoint.entryId, checkpoint);
		pi.appendEntry(CUSTOM_TYPE, checkpoint);
	});

	pi.registerCommand("rewind", {
		description: "Rewind code and/or conversation to a previous checkpoint",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const ordered = [...checkpoints.values()].reverse();
			if (ordered.length === 0) {
				ctx.ui.notify("No checkpoints recorded yet", "info");
				return;
			}
			const labels = ordered.map(checkpointLabel);
			const choice = await ctx.ui.select("Rewind to checkpoint:", labels);
			if (!choice) return;
			const checkpoint = ordered[labels.indexOf(choice)];
			if (checkpoint) await runRestoreMode(pi, ctx, checkpoint);
		},
	});

	pi.on("session_before_fork", async (event, ctx) => {
		const ref = checkpoints.get(event.entryId)?.ref;
		if (!ref) return;

		if (!ctx.hasUI) {
			// In non-interactive mode, don't restore automatically
			return;
		}

		const choice = await ctx.ui.select("Restore code state?", [
			"Yes, restore code to that point",
			"No, keep current code",
		]);

		if (choice?.startsWith("Yes")) {
			await pi.exec("git", ["stash", "apply", ref]);
			ctx.ui.notify("Code restored to checkpoint", "info");
		}
	});
}
