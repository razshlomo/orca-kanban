import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type GitSnapshot = {
	branch: string | null;
	head: string | null;
	dirty: boolean;
	changedFiles: string[];
};

function run(cwd: string, args: string[], timeoutMs = 15_000): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile('git', ['-C', cwd, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
		resolve(err ? null : String(stdout ?? '').trim());
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
