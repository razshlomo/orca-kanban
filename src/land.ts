import { execFile } from 'node:child_process';
import {
	gitBaseBranch,
	gitBranchExists,
	gitBranchStanding,
	gitCommitAll,
	gitDeleteBranch,
	gitMainWorktree,
	gitMergeBranch,
	gitSnapshot,
	type BranchStanding,
	type CommitOutcome,
} from './git.ts';
import type { Card, KanbanConfig } from './types.ts';

/** Why nothing was landed, when nothing was. */
export type CommitCardOutcome =
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
export async function commitCardWork(card: Card, config: KanbanConfig): Promise<CommitCardOutcome> {
	if (config.landOnApprove === 'off') return { committed: false, reason: 'disabled' };
	if (!card.worktreePath) return { committed: false, reason: 'no-worktree' };

	const message = commitMessageFor(card);
	const outcome: CommitOutcome = await gitCommitAll(card.worktreePath, message);

	if (outcome.committed) return { committed: true, sha: outcome.sha, files: outcome.files };
	return outcome.error === undefined
		? { committed: false, reason: outcome.reason }
		: { committed: false, reason: outcome.reason, error: outcome.error };
}

/**
 * Why a card cannot be landed, in the order the checks run.
 *
 * Each one is a separate refusal because each has a different answer: `base-dirty`
 * means commit your own work first, `stale` means rebase, `verify-failed` means fix
 * the code. Collapsing them into "cannot land" would leave the reader guessing.
 */
export type LandRefusal =
	| 'not-done'
	| 'held-by-you'
	| 'no-branch'
	| 'nothing-committed'
	| 'worktree-dirty'
	| 'already-landed'
	| 'no-main-worktree'
	| 'no-base-branch'
	| 'base-not-checked-out'
	| 'base-dirty'
	| 'nothing-to-merge'
	| 'verify-failed'
	| 'conflict'
	| 'failed';

export type LandPlan = {
	/** The main working tree the merge would run in. */
	mainWorktree: string;
	branch: string;
	base: string;
	standing: BranchStanding;
};

export type LandOutcome =
	| { landed: true; sha: string; plan: LandPlan; disposed: boolean; verified: boolean }
	| { landed: false; reason: LandRefusal; detail?: string; plan?: LandPlan };

/**
 * Everything that must be true before a card's branch may touch the base branch,
 * checked without changing anything.
 *
 * Split out from `landCard` so the same answer can be shown as a disabled button
 * with a reason, rather than discovered by attempting the merge. The order matters:
 * cheap facts about the card first, then the repository, then the branch.
 */
export async function planLanding(card: Card, config: KanbanConfig): Promise<LandOutcome> {
	if (card.state !== 'Done') return { landed: false, reason: 'not-done' };
	if (card.manualSince !== null) return { landed: false, reason: 'held-by-you' };
	if (!card.worktreePath || !card.branch) return { landed: false, reason: 'no-branch' };
	if (!card.commitSha) return { landed: false, reason: 'nothing-committed' };
	if (card.landedSha) return { landed: false, reason: 'already-landed', detail: card.landedSha };

	// Loose files in the card's worktree are work the merge would silently leave behind.
	const worktree = await gitSnapshot(card.worktreePath);
	if (worktree.dirty) {
		return { landed: false, reason: 'worktree-dirty', detail: worktree.changedFiles.slice(0, 5).join(', ') };
	}

	const mainWorktree = await gitMainWorktree(card.worktreePath);
	if (!mainWorktree) return { landed: false, reason: 'no-main-worktree' };

	const base = await gitBaseBranch(mainWorktree, config.baseBranch);
	if (!base) return { landed: false, reason: 'no-base-branch' };

	// Never switch branches under someone. If the main tree is on a feature branch,
	// that is where they are working, and moving it is not this command's business.
	const main = await gitSnapshot(mainWorktree);
	if (main.branch !== base) return { landed: false, reason: 'base-not-checked-out', detail: main.branch ?? 'a detached HEAD' };
	if (main.dirty) return { landed: false, reason: 'base-dirty', detail: main.changedFiles.slice(0, 5).join(', ') };

	const standing = await gitBranchStanding(mainWorktree, card.branch, base);
	if (!standing) return { landed: false, reason: 'failed', detail: 'could not compare the branch with the base' };

	const plan: LandPlan = { mainWorktree, branch: card.branch, base, standing };
	if (standing.merged) return { landed: false, reason: 'nothing-to-merge', plan };
	return { landed: true, sha: '', plan, disposed: false, verified: false };
}

/**
 * Merges an approved card's branch into the base branch.
 *
 * This is the one board action that changes something other people read, so it is
 * never automatic and never inferred from a card reaching Done. Approving commits on
 * the card's own branch; this is the separate, deliberate step that publishes it.
 *
 * On success the worktree and branch are disposed of by default: the work is in the
 * base branch now, and leaving them behind is how a repository accumulates dozens of
 * stale kanban branches.
 */
export async function landCard(
	card: Card,
	config: KanbanConfig,
	deps: { removeWorktree: (path: string) => Promise<void> },
	options: { keepBranch?: boolean } = {},
): Promise<LandOutcome> {
	const plan = await planLanding(card, config);
	if (!plan.landed) return plan;

	if (config.verifyCommand) {
		const verify = await runVerify(config.verifyCommand, card.worktreePath as string);
		if (!verify.ok) return { landed: false, reason: 'verify-failed', detail: verify.detail, plan: plan.plan };
	}

	const merge = await gitMergeBranch(plan.plan.mainWorktree, {
		branch: plan.plan.branch,
		message: mergeMessageFor(card, plan.plan.base),
	});
	if (!merge.merged) return { landed: false, reason: merge.reason, detail: merge.error, plan: plan.plan };

	let disposed = false;
	if (!options.keepBranch) {
		// The worktree goes first: git refuses to delete a branch that one has checked out.
		// Both steps are best-effort because Orca's own `worktree rm` may already have taken
		// the branch with it, which makes the follow-up `git branch -d` fail on a branch that
		// is genuinely gone.
		try {
			await deps.removeWorktree(card.worktreePath as string);
		} catch {
			// Fall through: the check below is what decides, not who managed to do it.
		}
		await gitDeleteBranch(plan.plan.mainWorktree, plan.plan.branch);

		// Report what is actually true. Trusting the exit codes claimed "branch kept" for a
		// branch that no longer existed, which then told the reader to go and drop it.
		disposed = !(await gitBranchExists(plan.plan.mainWorktree, plan.plan.branch));
	}

	return { landed: true, sha: merge.sha, plan: plan.plan, disposed, verified: Boolean(config.verifyCommand) };
}

/** Runs the configured gate in the card's worktree, keeping the tail of its output. */
function runVerify(command: string, cwd: string): Promise<{ ok: boolean; detail: string }> {
	const { promise, resolve } = Promise.withResolvers<{ ok: boolean; detail: string }>();
	execFile(
		process.env.SHELL || '/bin/sh',
		['-c', command],
		{ cwd, timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 },
		(err, stdout, stderr) => {
			const output = `${String(stdout ?? '')}${String(stderr ?? '')}`.trim();
			resolve({ ok: !err, detail: output.split('\n').slice(-12).join('\n') });
		},
	);
	return promise;
}

/** A merge commit that says which card this was and what it claimed to do. */
export function mergeMessageFor(card: Card, base: string): string {
	const title = card.title.trim() || card.id;
	const summary = card.lastAgentSummary?.trim();
	return `Land ${title} into ${base}\n\n${summary ? `${summary.slice(0, 1500)}\n\n` : ''}Landed from Kanban ${card.id}.`;
}

/** One line a human can read, for every way landing can end. */
export function describeLanding(outcome: LandOutcome): string {
	if (outcome.landed) {
		const kept = outcome.disposed ? 'branch and worktree removed' : 'branch kept';
		return `merged ${outcome.sha.slice(0, 8)} into ${outcome.plan.base} (${kept})`;
	}

	const detail = outcome.detail ? `: ${outcome.detail}` : '';
	switch (outcome.reason) {
		case 'not-done':
			return 'only a Done card can be landed — approve it first';
		case 'held-by-you':
			return 'you are holding this card by hand; take it back before landing it';
		case 'no-branch':
			return 'this card has no branch (it never ran)';
		case 'nothing-committed':
			return 'nothing was committed on this card, so there is nothing to land';
		case 'worktree-dirty':
			return `the card worktree has uncommitted changes${detail}`;
		case 'already-landed':
			return `already landed as ${(outcome.detail ?? '').slice(0, 8)}`;
		case 'no-main-worktree':
			return 'could not find the repository main working tree to merge in';
		case 'no-base-branch':
			return 'could not work out which branch to land on — set baseBranch';
		case 'base-not-checked-out':
			return `the repository is on ${outcome.detail ?? 'another branch'}; check out the base branch first`;
		case 'base-dirty':
			return `the base branch has uncommitted changes${detail}`;
		case 'nothing-to-merge':
			return 'the base branch already contains this work';
		case 'verify-failed':
			return `the verify command failed${detail ? `:\n${outcome.detail}` : ''}`;
		case 'conflict':
			return `merge conflict, nothing changed${detail}`;
		case 'failed':
			return `landing failed${detail}`;
	}
}

export type DropOutcome =
	| { dropped: true; branch: string | null; worktree: string | null; unlandedCommits: number }
	| { dropped: false; reason: 'nothing-to-drop' | 'unlanded' | 'failed'; detail?: string; unlandedCommits?: number };

/**
 * Throws away a card's branch and worktree, keeping the card, its summary and its trail.
 *
 * Most cards are questions, not code: "confirm the alert self-silenced" produces notes
 * in a worktree and an answer on the board. The answer is the deliverable and it is
 * already saved, so the branch is litter. This is how such a card ends — landing it
 * would push scratch notes into the repository.
 *
 * Work the base branch does not contain is refused unless `force`, because that is the
 * case where dropping destroys something.
 */
export async function dropCardBranch(
	card: Card,
	config: KanbanConfig,
	deps: { removeWorktree: (path: string) => Promise<void> },
	options: { force?: boolean } = {},
): Promise<DropOutcome> {
	if (!card.worktreePath && !card.branch) return { dropped: false, reason: 'nothing-to-drop' };

	let unlanded = 0;
	let mainWorktree: string | null = null;
	if (card.worktreePath && card.branch) {
		mainWorktree = await gitMainWorktree(card.worktreePath);
		const base = mainWorktree ? await gitBaseBranch(mainWorktree, config.baseBranch) : null;
		const standing = mainWorktree && base ? await gitBranchStanding(mainWorktree, card.branch, base) : null;
		unlanded = standing?.ahead ?? 0;
		if (unlanded > 0 && !options.force) {
			return { dropped: false, reason: 'unlanded', unlandedCommits: unlanded };
		}
	}

	if (card.worktreePath) {
		try {
			await deps.removeWorktree(card.worktreePath);
		} catch (err) {
			return { dropped: false, reason: 'failed', detail: (err as Error).message };
		}
	}

	if (card.branch && mainWorktree) {
		const deleted = await gitDeleteBranch(mainWorktree, card.branch, { force: unlanded > 0 });
		if (!deleted.deleted) return { dropped: false, reason: 'failed', detail: deleted.error };
	}

	return { dropped: true, branch: card.branch, worktree: card.worktreePath, unlandedCommits: unlanded };
}

/** One line a human can read, for every way dropping can end. */
export function describeDrop(outcome: DropOutcome): string {
	if (outcome.dropped) {
		const lost = outcome.unlandedCommits > 0 ? `, discarding ${outcome.unlandedCommits} unlanded commit${outcome.unlandedCommits === 1 ? '' : 's'}` : '';
		return `dropped ${outcome.branch ?? 'the worktree'}${lost}`;
	}

	switch (outcome.reason) {
		case 'nothing-to-drop':
			return 'this card has no branch or worktree to drop';
		case 'unlanded':
			return `the branch has ${outcome.unlandedCommits} commit${outcome.unlandedCommits === 1 ? '' : 's'} the base branch does not — drop with force to discard them`;
		case 'failed':
			return `drop failed: ${outcome.detail ?? 'unknown error'}`;
	}
}

/** A commit message that says which card and why it exists. */
export function commitMessageFor(card: Card): string {
	const title = card.title.trim() || card.id;
	const summary = card.lastAgentSummary?.trim();
	const body = summary ? `\n\n${summary.slice(0, 1500)}\n` : '\n';
	return `${title}\n${body}\nApproved from Kanban ${card.id}.`;
}

/** One line a human can read in a response or the UI. */
export function describeCommit(outcome: CommitCardOutcome): string {
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
