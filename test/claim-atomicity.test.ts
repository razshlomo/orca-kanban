import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Board } from '../src/board.ts';
import { testBoard } from './helpers.ts';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claim-worker.ts');

function claimInChildProcess(dbPath: string, cardId: string, workerId: string): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	execFile(
		process.execPath,
		[WORKER, dbPath, cardId, workerId],
		{ timeout: 30_000, env: process.env },
		(err, stdout, stderr) => {
			resolve(err ? `ERROR ${workerId} ${String(stderr || err.message).trim()}` : String(stdout).trim());
		},
	);
	return promise;
}

test('exactly one of many competing processes can claim a card', async () => {
	const { board, dbPath } = testBoard();
	const card = board.createCard({ title: 'contested', state: 'Ready', maxAttempts: 99 });
	board.close();

	// Eight real processes, all racing for the same Ready card.
	const results = await Promise.all(
		Array.from({ length: 8 }, (_, i) => claimInChildProcess(dbPath, card.id, `worker-${i}`)),
	);

	const winners = results.filter((r) => r.startsWith('WON'));
	const losers = results.filter((r) => r.startsWith('LOST'));

	assert.equal(winners.length, 1, `expected exactly one winner, got: ${results.join(' | ')}`);
	assert.equal(losers.length, 7, `every other process must lose cleanly, got: ${results.join(' | ')}`);

	const verify = new Board(dbPath);
	const after = verify.getCard(card.id);
	assert.equal(after?.state, 'In Progress');
	assert.equal(after?.attemptCount, 1, 'only the winning claim consumed an attempt');
	assert.ok(after?.claimedBy?.startsWith('worker-'));
	assert.equal(`WON ${after?.claimedBy}`, winners[0], 'the recorded owner is the process that reported winning');
	verify.close();
});

test('two cards under contention are each claimed exactly once', async () => {
	const { board, dbPath } = testBoard();
	const first = board.createCard({ title: 'first', state: 'Ready', priority: 5, maxAttempts: 99 });
	const second = board.createCard({ title: 'second', state: 'Ready', priority: 5, maxAttempts: 99 });
	board.close();

	const attempts = [
		...Array.from({ length: 4 }, (_, i) => claimInChildProcess(dbPath, first.id, `a-${i}`)),
		...Array.from({ length: 4 }, (_, i) => claimInChildProcess(dbPath, second.id, `b-${i}`)),
	];
	const results = await Promise.all(attempts);

	const wonFirst = results.filter((r) => r.startsWith('WON a-'));
	const wonSecond = results.filter((r) => r.startsWith('WON b-'));

	assert.equal(wonFirst.length, 1, `first card claimed once, got: ${results.join(' | ')}`);
	assert.equal(wonSecond.length, 1, `second card claimed once, got: ${results.join(' | ')}`);
});

test('a claim is rejected once the card leaves Ready, even across processes', async () => {
	const { board, dbPath } = testBoard();
	const card = board.createCard({ title: 'already moved', state: 'Backlog' });
	board.close();

	const result = await claimInChildProcess(dbPath, card.id, 'late-worker');
	assert.ok(result.startsWith('LOST'), `a Backlog card must not be claimable, got: ${result}`);
});
