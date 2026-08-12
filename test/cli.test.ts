import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Board } from '../src/board.ts';
import { openDb } from '../src/db.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

/**
 * A board with enough cards that the CLI is still writing when the reader leaves.
 * A short listing can finish before the pipe closes, which would make the test
 * pass for the wrong reason.
 */
function crowdedBoard(): string {
	const home = mkdtempSync(path.join(tmpdir(), 'cli-epipe-'));
	const board = new Board(openDb(path.join(home, 'board.sqlite')));
	for (let i = 0; i < 400; i += 1) board.createCard({ title: `card number ${i} with a title long enough to fill the pipe buffer` });
	board.close();
	return home;
}

/** Runs a shell pipeline so the CLI's own exit status survives, via pipefail. */
function pipeline(home: string, command: string): Promise<{ code: number; stderr: string }> {
	const { promise, resolve } = Promise.withResolvers<{ code: number; stderr: string }>();
	execFile(
		'/bin/bash',
		['-c', `set -o pipefail; ${command}`],
		{ cwd: path.join(import.meta.dirname, '..'), timeout: 30_000, env: { ...process.env, ORCA_KANBAN_HOME: home } },
		(err, _stdout, stderr) => {
			const code = err && typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : 0;
			resolve({ code, stderr: String(stderr) });
		},
	);
	return promise;
}

test('piping a long listing into head is a clean exit, not an EPIPE crash', async () => {
	const home = crowdedBoard();
	const res = await pipeline(home, `${process.execPath} ${CLI} card list | head -1`);

	assert.equal(res.code, 0, `the pipeline must succeed, stderr was: ${res.stderr}`);
	assert.doesNotMatch(res.stderr, /EPIPE/, 'a closed pipe must not surface as an error');
	assert.doesNotMatch(res.stderr, /Unhandled|throw er/, 'a closed pipe must not crash the process');
});

test('a full listing still reaches a reader that stays', async () => {
	const home = crowdedBoard();
	const res = await pipeline(home, `${process.execPath} ${CLI} card list | wc -l`);

	assert.equal(res.code, 0, res.stderr);
});
