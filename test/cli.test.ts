import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

/**
 * A home whose omp agent reads its catalog from a file, so these tests never depend
 * on a real agent binary or on which models happen to exist today.
 */
function boardWithModels(): { home: string } {
	const home = mkdtempSync(path.join(tmpdir(), 'cli-model-'));
	const catalog = path.join(home, 'catalog.json');
	writeFileSync(
		catalog,
		JSON.stringify({
			models: [
				{ provider: 'anthropic', id: 'claude-opus-4-8', selector: 'anthropic/claude-opus-4-8' },
				{ provider: 'anthropic', id: 'claude-opus-5', selector: 'anthropic/claude-opus-5' },
				{ provider: 'anthropic', id: 'claude-haiku-4-5', selector: 'anthropic/claude-haiku-4-5' },
			],
		}),
		'utf8',
	);
	writeFileSync(
		path.join(home, 'config.json'),
		JSON.stringify({ agents: { omp: { modelsCommand: `cat ${catalog}`, modelsFormat: 'json', modelsRefreshCommand: null } } }),
		'utf8',
	);
	return { home };
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

test('a new card records the default model, and "none" leaves it to the agent', async () => {
	const { home } = boardWithModels();

	const created = await kanban(home, ['card', 'add', 'with the default model', '--repo', '/tmp/one']);
	assert.equal(created.code, 0, created.stderr);
	const id = created.stdout.trim().split(/\s+/)[0] as string;
	assert.equal(reread(home, id).model, 'opus', 'the default is written onto the card, not left in config');
	assert.match(created.stderr, /model opus → anthropic\/claude-opus-5/, 'and it says which model that is today');

	const bare = await kanban(home, ['card', 'add', 'no model at all', '--repo', '/tmp/one', '--model', 'none']);
	assert.equal(bare.code, 0, bare.stderr);
	assert.equal(reread(home, bare.stdout.trim().split(/\s+/)[0] as string).model, null);

	// A claude card cannot be told its model, so it must not silently get the default.
	const claude = await kanban(home, ['card', 'add', 'claude work', '--repo', '/tmp/one', '--agent', 'claude']);
	assert.equal(claude.code, 0, claude.stderr);
	assert.equal(reread(home, claude.stdout.trim().split(/\s+/)[0] as string).model, null);
});

test('a model the agent cannot run is refused with exit code 4, and no card is created', async () => {
	const { home } = boardWithModels();

	const unreleased = await kanban(home, ['card', 'add', 'on astra', '--repo', '/tmp/one', '--model', 'astra']);
	assert.equal(unreleased.code, 4, unreleased.stderr);
	assert.match(unreleased.stderr, /may not be released yet/);

	const nonsense = await kanban(home, ['card', 'add', 'on nonsense', '--repo', '/tmp/one', '--model', 'gpt-9']);
	assert.equal(nonsense.code, 4, nonsense.stderr);
	assert.match(nonsense.stderr, /not in the model menu/);

	const withClaude = await kanban(home, [
		'card', 'add', 'claude on opus', '--repo', '/tmp/one', '--agent', 'claude', '--model', 'opus',
	]);
	assert.equal(withClaude.code, 4, withClaude.stderr);
	assert.match(withClaude.stderr, /cannot be told which model/);

	const listing = await kanban(home, ['card', 'list']);
	assert.match(listing.stdout, /no cards/, 'a refused model leaves nothing behind');
});

test('card update changes the model, and clears it on "none"', async () => {
	const { home } = boardWithModels();
	const created = await kanban(home, ['card', 'add', 'switchable', '--repo', '/tmp/one']);
	const id = created.stdout.trim().split(/\s+/)[0] as string;

	const changed = await kanban(home, ['card', 'update', id, '--model', 'haiku']);
	assert.equal(changed.code, 0, changed.stderr);
	assert.match(changed.stdout, /model: opus → haiku/);
	assert.equal(reread(home, id).model, 'haiku');

	const cleared = await kanban(home, ['card', 'update', id, '--model', 'none']);
	assert.equal(cleared.code, 0, cleared.stderr);
	assert.equal(reread(home, id).model, null);

	const refused = await kanban(home, ['card', 'update', id, '--model', 'astra']);
	assert.equal(refused.code, 4, refused.stderr);
	assert.equal(reread(home, id).model, null, 'a refused model does not half-apply');
});

test('kanban models says what every name means today, and which one cannot be used', async () => {
	const { home } = boardWithModels();
	const res = await kanban(home, ['models']);

	assert.match(res.stdout, /agent: omp/);
	assert.match(res.stdout, /opus\s+Opus\s+\*\s+anthropic\/claude-opus-5 \(newest of 2\)/, 'newest wins, and the default is marked');
	assert.match(res.stdout, /haiku\s+Haiku\s+anthropic\/claude-haiku-4-5/);
	assert.match(res.stdout, /astra\s+Astra \(codex\)\s+unavailable/);
	// Nothing at all resolving is a failure worth an exit code; this catalog resolves
	// three of the six, so the command succeeds.
	assert.equal(res.code, 0, res.stderr);
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
