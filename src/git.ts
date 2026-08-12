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
