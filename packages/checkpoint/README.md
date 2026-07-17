# pi-code-checkpoint

Claude Code style checkpoints and `/rewind`, built on a per-session shadow git repo.

## Features

- Snapshot of the whole working tree at the start of each user prompt: untracked files included, project `.gitignore` honored, the project's own git state never touched (`--git-dir`/`--work-tree` into `~/.pi/agent/checkpoints/<session>`)
- Restore is a checkout, not a merge: edits made after the checkpoint are reset and deleted files come back
- Checkpoints persisted in the session file: they survive restarts, resumes, and forks
- `/rewind`: pick a checkpoint, then restore "Code and conversation", "Conversation only", or "Code only"
- `/fork` offers to restore code at the fork point

Remaining difference vs Claude Code: files created after a checkpoint are left in place on restore (nothing is deleted that the checkpoint does not know about).

Started from the pi v0.74.2 `git-checkpoint` example (a stash-based demo), engine rewritten.
