import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type GitSnapshot = {
	branch: string | null;
	head: string | null;
	dirty: boolean;
	changedFiles: string[];
};

function run(cwd: string, args: string[], options: { timeoutMs?: number; allowDiffExit?: boolean } = {}): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile('git', ['-C', cwd, ...args], { timeout: options.timeoutMs ?? 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
		// `git diff` exits 1 when there are differences; for us that is data, not failure.
		const code = (err as { code?: unknown } | null)?.code;
		if (err && !(options.allowDiffExit && code === 1)) return resolve(null);
		resolve(String(stdout ?? '').trim());
	});
	return promise;
}

/** Branch, HEAD sha, and working-tree dirtiness for a worktree. */
export async function gitSnapshot(cwd: string): Promise<GitSnapshot> {
	const [branch, head, status] = await Promise.all([
		run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
		run(cwd, ['rev-parse', 'HEAD']),
		run(cwd, ['status', '--porcelain']),
	]);

	const changedFiles = (status ?? '')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.replace(/^\S+\s+/, ''));

	return {
		branch: branch && branch !== 'HEAD' ? branch : null,
		head: head ?? null,
		dirty: changedFiles.length > 0,
		changedFiles,
	};
}

/**
 * Hides the scheduler's control directory from git without touching a tracked
 * .gitignore, so agent runs never leave the worktree looking dirty.
 */
export async function excludeLocally(cwd: string, pattern: string): Promise<void> {
	const commonDir = await run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
	if (!commonDir) return;

	const excludeFile = path.join(commonDir, 'info', 'exclude');

	try {
		mkdirSync(path.dirname(excludeFile), { recursive: true });
		const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
		if (!current.split('\n').includes(pattern)) {
			appendFileSync(excludeFile, `${current.endsWith('\n') || current === '' ? '' : '\n'}${pattern}\n`);
		}
	} catch {
		// Best effort only — a read-only git dir must not fail a card.
	}
}

export type ReviewDiff = {
	/** What the diff is measured against: a merge-base sha, or null when unknown. */
	base: string | null;
	baseRef: string | null;
	stat: string;
	patch: string;
	/** New files the agent never staged. Invisible to a plain `git diff`. */
	untracked: string[];
	truncated: boolean;
};

/** First ref that actually exists, so detection works on master and main repos alike. */
async function resolveBaseRef(cwd: string, preferred: string | null): Promise<string | null> {
	const candidates = [preferred, 'origin/HEAD', 'main', 'master'].filter((r): r is string => Boolean(r));
	for (const ref of candidates) {
		if (await run(cwd, ['rev-parse', '--verify', '--quiet', ref])) return ref;
	}
	return null;
}

/**
 * The whole of a card's work, as a reviewer needs to see it.
 *
 * Two things a plain `git diff` misses and a review cannot: work the agent
 * committed on its branch (so we diff from the merge-base, not HEAD), and new
 * files it never staged — which is the common case, since agents do not commit
 * by default. Untracked files are rendered as additions via `--no-index`.
 */
export async function gitReviewDiff(
	cwd: string,
	options: { baseRef?: string | null; maxBytes?: number } = {},
): Promise<ReviewDiff> {
	const maxBytes = options.maxBytes ?? 400_000;
	const baseRef = await resolveBaseRef(cwd, options.baseRef ?? null);
	const base = baseRef ? await run(cwd, ['merge-base', 'HEAD', baseRef]) : null;
	const against = base ?? 'HEAD';

	const [stat, tracked, status] = await Promise.all([
		run(cwd, ['diff', '--stat', against], { allowDiffExit: true }),
		run(cwd, ['diff', against], { allowDiffExit: true }),
		run(cwd, ['status', '--porcelain', '--untracked-files=all']),
	]);

	const untracked = (status ?? '')
		.split('\n')
		.filter((line) => line.startsWith('??'))
		.map((line) => line.slice(3).trim())
		.filter(Boolean);

	const additions = await Promise.all(
		untracked.map((file) => run(cwd, ['diff', '--no-index', '--', '/dev/null', file], { allowDiffExit: true })),
	);

	const patch = [tracked ?? '', ...additions.map((a) => a ?? '')].filter(Boolean).join('\n');
	const truncated = patch.length > maxBytes;

	return {
		base,
		baseRef,
		stat: stat ?? '',
		patch: truncated ? `${patch.slice(0, maxBytes)}\n\n… diff truncated at ${maxBytes} bytes …` : patch,
		untracked,
		truncated,
	};
}

export type CommitOutcome =
	| { committed: true; sha: string; files: number }
	| { committed: false; reason: 'nothing-to-commit' | 'failed'; error?: string };

/**
 * Commits everything in a card's worktree, including files the agent never staged.
 *
 * Agents do not commit by default, so approving a card would otherwise leave the
 * work as loose files in a worktree — the card reads Done while the repository has
 * nothing. Committing on the card's own branch preserves the work without touching
 * the base branch, which stays a human decision (merge, PR, or cherry-pick).
 */
export async function gitCommitAll(cwd: string, message: string): Promise<CommitOutcome> {
	const status = await run(cwd, ['status', '--porcelain', '--untracked-files=all']);
	if (status === null) return { committed: false, reason: 'failed', error: 'git status failed' };

	const files = status.split('\n').filter((line) => line.trim() !== '').length;
	if (files === 0) return { committed: false, reason: 'nothing-to-commit' };

	if ((await run(cwd, ['add', '-A'])) === null) {
		return { committed: false, reason: 'failed', error: 'git add failed' };
	}

	// -c keeps this out of the user's global identity if the repo has none set.
	const committed = await run(cwd, [
		'-c',
		'user.name=orca-kanban',
		'-c',
		'user.email=orca-kanban@local',
		'commit',
		'--no-verify',
		'-m',
		message,
	]);
	if (committed === null) return { committed: false, reason: 'failed', error: 'git commit failed' };

	const sha = await run(cwd, ['rev-parse', 'HEAD']);
	return sha ? { committed: true, sha, files } : { committed: false, reason: 'failed', error: 'could not read HEAD' };
}

/**
 * Like `run`, but keeps git's own words. A merge that fails has something to say —
 * which files conflicted, why a branch is not fast-forwardable — and swallowing it
 * into `null` would leave the caller inventing an explanation.
 */
function runDetailed(
	cwd: string,
	args: string[],
	timeoutMs = 60_000,
): Promise<{ ok: boolean; out: string; err: string }> {
	const { promise, resolve } = Promise.withResolvers<{ ok: boolean; out: string; err: string }>();
	execFile('git', ['-C', cwd, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
		resolve({ ok: !err, out: String(stdout ?? '').trim(), err: String(stderr ?? '').trim() });
	});
	return promise;
}

/**
 * The repository's main working tree, found from any of its worktrees.
 *
 * A merge cannot run inside the card's worktree: the base branch is checked out
 * somewhere else, and git refuses to have one branch in two places. So landing
 * always happens in the main tree, which is the one holding the shared branch.
 */
export async function gitMainWorktree(cwd: string): Promise<string | null> {
	const common = await run(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
	if (!common) return null;
	// `<main>/.git` for a normal clone; a bare repo has no working tree to land in.
	return path.basename(common) === '.git' ? path.dirname(common) : null;
}

/** Where a card's branch stands against the branch it would land on. */
export type BranchStanding = {
	/** Commits on the card branch that the base does not have. */
	ahead: number;
	/** Commits the base has that the card branch does not — how stale the work is. */
	behind: number;
	/** Already contained in the base, so there is nothing left to land. */
	merged: boolean;
};

export async function gitBranchStanding(cwd: string, branch: string, base: string): Promise<BranchStanding | null> {
	const counts = await run(cwd, ['rev-list', '--left-right', '--count', `${base}...${branch}`]);
	if (counts === null) return null;
	// `rev-list --left-right --count base...branch` prints "<behind>\t<ahead>".
	const [behind = NaN, ahead = NaN] = counts.split(/\s+/).map(Number);
	if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
	return { ahead, behind, merged: ahead === 0 };
}

export type MergeOutcome =
	| { merged: true; sha: string }
	| { merged: false; reason: 'conflict' | 'failed'; error: string };

/**
 * Merges a card's branch into the base branch, in the main working tree.
 *
 * `--no-ff` on purpose: a card is a unit of work someone approved, and a merge commit
 * is what keeps that boundary visible in the history afterwards. A conflict is undone
 * immediately — leaving a half-merged index behind would hand the repository back in a
 * state the board cannot describe and the next command would trip over.
 */
export async function gitMergeBranch(
	mainWorktree: string,
	options: { branch: string; message: string },
): Promise<MergeOutcome> {
	const merge = await runDetailed(mainWorktree, ['merge', '--no-ff', '--no-verify', '-m', options.message, options.branch]);
	if (!merge.ok) {
		const conflicted = await run(mainWorktree, ['diff', '--name-only', '--diff-filter=U']);
		await runDetailed(mainWorktree, ['merge', '--abort']);
		const files = (conflicted ?? '').split('\n').filter(Boolean);
		return files.length > 0
			? { merged: false, reason: 'conflict', error: `conflicts in ${files.join(', ')}` }
			: { merged: false, reason: 'failed', error: merge.err || merge.out || 'git merge failed' };
	}

	const sha = await run(mainWorktree, ['rev-parse', 'HEAD']);
	return sha ? { merged: true, sha } : { merged: false, reason: 'failed', error: 'could not read HEAD after merging' };
}

/**
 * Deletes a card's branch. `force` is required for a branch the base does not
 * contain, because that is the case where deleting destroys work.
 */
export async function gitDeleteBranch(
	mainWorktree: string,
	branch: string,
	options: { force?: boolean } = {},
): Promise<{ deleted: boolean; error?: string }> {
	const result = await runDetailed(mainWorktree, ['branch', options.force ? '-D' : '-d', branch]);
	return result.ok ? { deleted: true } : { deleted: false, error: result.err || 'git branch delete failed' };
}

/**
 * Whether a branch still exists. Landing checks this instead of trusting the exit code
 * of its own delete: Orca's `worktree rm` can take the branch with the worktree, and a
 * `git branch -d` that then fails does not mean the branch survived.
 */
export async function gitBranchExists(cwd: string, branch: string): Promise<boolean> {
	return (await run(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) !== null;
}

/** The base branch this repository would land on, by name. */
export async function gitBaseBranch(cwd: string, preferred: string | null): Promise<string | null> {
	const ref = await resolveBaseRef(cwd, preferred);
	if (!ref) return null;
	// A landing target has to be a local branch to merge into; origin/HEAD names a remote.
	if (!ref.startsWith('origin/')) return ref;
	const head = await run(cwd, ['rev-parse', '--abbrev-ref', ref]);
	const local = head?.replace(/^origin\//, '') ?? null;
	return local && (await run(cwd, ['rev-parse', '--verify', '--quiet', local])) ? local : null;
}
