import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Board } from '../src/board.ts';
import { openDb } from '../src/db.ts';
import type { Card, CardState } from '../src/types.ts';

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

/** A board with one card, plus a runner that reports the CLI's own exit code. */
function boardWithCard(state: CardState = 'Backlog'): { home: string; id: string } {
	const home = mkdtempSync(path.join(tmpdir(), 'cli-update-'));
	const board = new Board(openDb(path.join(home, 'board.sqlite')));
	const card = board.createCard({ title: 'editable', state, repo: '/tmp/one', priority: 3 });
	if (state === 'In Progress') board.claimCard(card.id, 'worker-1');
	board.close();
	return { home, id: card.id };
}

function kanban(home: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
	execFile(
		process.execPath,
		[CLI, ...argv],
		{ cwd: path.join(import.meta.dirname, '..'), timeout: 30_000, env: { ...process.env, ORCA_KANBAN_HOME: home } },
		(err, stdout, stderr) => {
			const code = err !== null && typeof err.code === 'number' ? err.code : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) });
		},
	);
	return promise;
}

/** Reads the card back the way another process would, not from a cached handle. */
function reread(home: string, id: string): Card {
	const board = new Board(openDb(path.join(home, 'board.sqlite')));
	const card = board.getCard(id);
	board.close();
	assert.ok(card, `card ${id} vanished from ${home}`);
	return card;
}

test('card update writes the fields it is given and reports what moved', async () => {
	const { home, id } = boardWithCard();
	const res = await kanban(home, [
		'card', 'update', id,
		'--title', 'renamed',
		'--description', 'why it exists',
		'--acceptance', 'must exit 0',
		'--priority', '10',
		'--max-attempts', '3',
		'--agent', 'codex',
		'--every', '1w',
	]);

	assert.equal(res.code, 0, res.stderr);
	assert.match(res.stdout, /priority: 3 → 10/);
	assert.match(res.stdout, /every: \(none\) → 1w/);

	const card = reread(home, id);
	assert.equal(card.title, 'renamed');
	assert.equal(card.description, 'why it exists');
	assert.equal(card.acceptanceCriteria, 'must exit 0');
	assert.equal(card.priority, 10);
	assert.equal(card.maxAttempts, 3);
	assert.equal(card.agent, 'codex');
	assert.equal(card.repeatEveryMs, 604_800_000);
	assert.equal(card.state, 'Backlog', 'an edit is not a move');
});

test('"none" clears a nullable field, and re-passing a value reports no change', async () => {
	const { home, id } = boardWithCard();
	await kanban(home, ['card', 'update', id, '--not-before', '7d']);
	assert.ok(reread(home, id).notBefore, 'the hold was set');

	const cleared = await kanban(home, ['card', 'update', id, '--repo', 'none', '--not-before', 'none']);
	assert.equal(cleared.code, 0, cleared.stderr);
	assert.equal(reread(home, id).repo, null);
	assert.equal(reread(home, id).notBefore, null);

	const same = await kanban(home, ['card', 'update', id, '--priority', '3']);
	assert.match(same.stdout, /no changes/, 'restating a value is not an edit');
});

test('card update refuses what it must not do, and changes nothing when it does', async () => {
	const { home, id } = boardWithCard();
	const cases: { argv: string[]; code: number; error: RegExp }[] = [
		{ argv: ['--state', 'Ready'], code: 1, error: /use: kanban card move/ },
		{ argv: ['--deps', 'card_nope'], code: 1, error: /would park/ },
		{ argv: ['--deps', id], code: 1, error: /cannot depend on itself/ },
		{ argv: ['--priority', 'high'], code: 1, error: /whole number/ },
		{ argv: ['--max-attempts', '0'], code: 1, error: /at least 1/ },
		{ argv: ['--title'], code: 1, error: /needs a value/ },
		{ argv: [], code: 1, error: /nothing to update/ },
	];

	for (const c of cases) {
		const res = await kanban(home, ['card', 'update', id, ...c.argv]);
		assert.equal(res.code, c.code, `${c.argv.join(' ') || '(no flags)'} must be refused: ${res.stdout}${res.stderr}`);
		assert.match(res.stderr, c.error);
	}

	const card = reread(home, id);
	assert.equal(card.state, 'Backlog');
	assert.deepEqual(card.dependencies, []);
	assert.equal(card.priority, 3);
	assert.equal(card.maxAttempts, 2);
});

test('a running card refuses an edit its agent depends on, with exit code 4', async () => {
	const { home, id } = boardWithCard('In Progress');

	const refused = await kanban(home, ['card', 'update', id, '--repo', '/tmp/two']);
	assert.equal(refused.code, 4, `a board rule is exit 4, got ${refused.code}: ${refused.stderr}`);
	assert.match(refused.stderr, /while it is running/);
	assert.equal(reread(home, id).repo, '/tmp/one');

	// Text is not what the run is built on, so renaming a running card still works.
	const renamed = await kanban(home, ['card', 'update', id, '--title', 'renamed mid-run']);
	assert.equal(renamed.code, 0, renamed.stderr);
	assert.equal(reread(home, id).title, 'renamed mid-run');

	const forced = await kanban(home, ['card', 'update', id, '--repo', '/tmp/two', '--force']);
	assert.equal(forced.code, 0, forced.stderr);
	assert.equal(reread(home, id).repo, '/tmp/two');
});

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
