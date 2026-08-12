import { gitCommitAll, type CommitOutcome } from './git.ts';
import type { Card, KanbanConfig } from './types.ts';

/** Why nothing was landed, when nothing was. */
export type LandingOutcome =
	| { committed: true; sha: string; files: number }
	| { committed: false; reason: 'disabled' | 'no-worktree' | 'nothing-to-commit' | 'failed'; error?: string };

/**
 * Commits the work an approved card produced.
 *
 * Agents do not commit by default, so without this a card reaches Done while its
 * changes are still loose files in a worktree — the board says finished and the
 * repository has nothing. Committing happens on the card's own branch; merging into
 * the base branch stays a human decision, because that is the step that can break
 * somebody else's build.
 */
export async function landCardWork(card: Card, config: KanbanConfig): Promise<LandingOutcome> {
	if (config.landOnApprove === 'off') return { committed: false, reason: 'disabled' };
	if (!card.worktreePath) return { committed: false, reason: 'no-worktree' };

	const message = commitMessageFor(card);
	const outcome: CommitOutcome = await gitCommitAll(card.worktreePath, message);

	if (outcome.committed) return { committed: true, sha: outcome.sha, files: outcome.files };
	return outcome.error === undefined
		? { committed: false, reason: outcome.reason }
		: { committed: false, reason: outcome.reason, error: outcome.error };
}

/** A commit message that says which card and why it exists. */
export function commitMessageFor(card: Card): string {
	const title = card.title.trim() || card.id;
	const summary = card.lastAgentSummary?.trim();
	const body = summary ? `\n\n${summary.slice(0, 1500)}\n` : '\n';
	return `${title}\n${body}\nApproved from Kanban ${card.id}.`;
}

/** One line a human can read in a response or the UI. */
export function describeLanding(outcome: LandingOutcome): string {
	if (outcome.committed) {
		return `committed ${outcome.sha.slice(0, 8)} (${outcome.files} file${outcome.files === 1 ? '' : 's'})`;
	}

	switch (outcome.reason) {
		case 'disabled':
			return 'not committed (landOnApprove is off)';
		case 'no-worktree':
			return 'nothing to commit (this card never ran)';
		case 'nothing-to-commit':
			return 'nothing to commit (the worktree was already clean)';
		case 'failed':
			return `commit failed: ${outcome.error ?? 'unknown error'}`;
	}
}
