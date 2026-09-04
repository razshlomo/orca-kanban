import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	assertBoardWritable,
	CardWorkerGuardError,
	detectCardWorktree,
	isMutatingCommand,
} from '../src/guard.ts';

const CLI = path.join(import.meta.dirname, '..', 'src', 'cli.ts');

/** Builds a directory tree that looks like a card's worktree mid-run. */
function cardWorktree(marker: Record<string, unknown> = {}): string {
	const root = mkdtempSync(path.join(tmpdir(), 'guard-wt-'));
	mkdirSync(path.join(root, '.orca-kanban'), { recursive: true });
	writeFileSync(
		path.join(root, '.orca-kanban', 'card.json'),
		JSON.stringify({ cardId: 'card_abc123', runId: 'run_xyz789', title: 'Add a helper', startedAt: 1, ...marker }),
		'utf8',
	);
	mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
	return root;
}

function runCli(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
	execFile(
		process.execPath,
		[CLI, ...args],
		{ cwd, timeout: 30_000, env: { ...process.env, ORCA_KANBAN_HOME: mkdtempSync(path.join(tmpdir(), 'guard-home-')) } },
		(err, stdout, stderr) => {
			const code = err && typeof (err as { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) });
		},
	);
	return promise;
}

test('a card worktree is detected from its root and from any subdirectory', () => {
	const root = cardWorktree();

	const atRoot = detectCardWorktree(root);
	assert.equal(atRoot?.cardId, 'card_abc123');
	assert.equal(atRoot?.runId, 'run_xyz789');
	assert.equal(atRoot?.worktreePath, root);

	const nested = detectCardWorktree(path.join(root, 'src', 'deep'));
	assert.equal(nested?.cardId, 'card_abc123', 'the marker is found by walking up');
});

test('an ordinary directory is not a card worktree', () => {
	assert.equal(detectCardWorktree(mkdtempSync(path.join(tmpdir(), 'plain-'))), null);
});

test('a corrupt or incomplete marker is ignored rather than blocking everything', () => {
	const partial = mkdtempSync(path.join(tmpdir(), 'guard-bad-'));
	mkdirSync(path.join(partial, '.orca-kanban'), { recursive: true });

	writeFileSync(path.join(partial, '.orca-kanban', 'card.json'), '{not json', 'utf8');
	assert.equal(detectCardWorktree(partial), null, 'unparseable marker');

	writeFileSync(path.join(partial, '.orca-kanban', 'card.json'), JSON.stringify({ title: 'no ids' }), 'utf8');
	assert.equal(detectCardWorktree(partial), null, 'marker without cardId/runId');
});

test('mutating commands are classified correctly', () => {
	for (const cmd of ['card add', 'card update', 'card move', 'card rm', 'card retry', 'serve', 'run', 'recover']) {
		assert.ok(isMutatingCommand(cmd), `${cmd} changes the board`);
	}
	for (const cmd of ['card list', 'card show', 'status', 'doctor', 'help']) {
		assert.ok(!isMutatingCommand(cmd), `${cmd} is read-only`);
	}
});

test('board writes are refused inside a card worktree, reads are allowed', () => {
	const root = cardWorktree();

	assert.throws(
		() => assertBoardWritable('card add', { cwd: root }),
		(err: unknown) => {
			assert.ok(err instanceof CardWorkerGuardError);
			assert.match(err.message, /card_abc123/);
			assert.match(err.message, /work only on itself/);
			return true;
		},
		'a card agent must not add cards',
	);

	assert.throws(
		() => assertBoardWritable('card update', { cwd: root }),
		CardWorkerGuardError,
		'nor edit them — follow-up work belongs in its result file',
	);

	assert.doesNotThrow(() => assertBoardWritable('card list', { cwd: root }), 'reads stay available');
	assert.doesNotThrow(() => assertBoardWritable('status', { cwd: root }));
});

test('--force lets a human override the guard deliberately', () => {
	const root = cardWorktree();
	assert.doesNotThrow(() => assertBoardWritable('card add', { cwd: root, force: true }));
});

test('outside a card worktree every command is permitted', () => {
	const plain = mkdtempSync(path.join(tmpdir(), 'plain-'));
	for (const cmd of ['card add', 'serve', 'run', 'recover']) {
		assert.doesNotThrow(() => assertBoardWritable(cmd, { cwd: plain }));
	}
});

test('the CLI itself refuses a card add from inside a card worktree', async () => {
	const root = cardWorktree();
	const res = await runCli(root, ['card', 'add', 'sneaky card', '--state', 'Ready']);

	assert.equal(res.code, 3, 'the guard uses a distinct exit code');
	assert.match(res.stderr, /Refusing to run "card add"/);
	assert.match(res.stderr, /card_abc123/);
	assert.doesNotMatch(res.stdout, /card_/, 'no card id was printed, so nothing was created');
});

test('the CLI allows a read-only command from inside a card worktree', async () => {
	const root = cardWorktree();
	const res = await runCli(root, ['card', 'list']);

	assert.equal(res.code, 0);
	assert.match(res.stdout, /no cards/, 'the empty board was read successfully');
});

test('the CLI honours --force from inside a card worktree', async () => {
	const root = cardWorktree();
	const res = await runCli(root, ['card', 'add', 'deliberate card', '--force']);

	assert.equal(res.code, 0);
	assert.match(res.stdout, /card_/, 'the card was created');
});
