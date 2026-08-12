import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { Board } from '../src/board.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { Scheduler } from '../src/scheduler.ts';
import type { Card, ExecutionResult } from '../src/types.ts';
import { okResult, silentLogger, testBoard, testConfig } from './helpers.ts';

/**
 * An executor that parks every card until the test releases it, so "how many run at
 * once" is observable instead of a race against real timing.
 */
function gatedExecutor() {
	const started: string[] = [];
	const gates = new Map<string, () => void>();
	let peak = 0;
	let live = 0;

	const executor = async (card: Card): Promise<ExecutionResult> => {
		started.push(card.id);
		live += 1;
		peak = Math.max(peak, live);

		await new Promise<void>((resolve) => gates.set(card.id, resolve));
		live -= 1;
		return okResult('run_gated');
	};

	return {
		executor,
		started,
		get peak() {
			return peak;
		},
		get live() {
			return live;
		},
		waitForStart: async (n: number): Promise<void> => {
			const deadline = Date.now() + 5000;
			while (started.length < n) {
				if (Date.now() > deadline) throw new Error(`only ${started.length} of ${n} cards started`);
				await new Promise((r) => setImmediate(r));
			}
		},
		release: (cardId: string): void => {
			const gate = gates.get(cardId);
			assert.ok(gate, `${cardId} was never started`);
			gate();
			gates.delete(cardId);
		},
		releaseAll: (): void => {
			for (const gate of gates.values()) gate();
			gates.clear();
		},
	};
}

test('the board refuses a claim once the concurrency ceiling is full', () => {
	const { board } = testBoard();
	const a = board.createCard({ title: 'a', state: 'Ready' });
	const b = board.createCard({ title: 'b', state: 'Ready' });

	assert.ok(board.claimCard(a.id, 'w1', { maxConcurrent: 1 }), 'the first card takes the only slot');
	assert.equal(board.claimCard(b.id, 'w2', { maxConcurrent: 1 }), null, 'the second is refused');
	assert.equal(board.inFlightCount(), 1);

	// Freeing the slot lets the queue move again.
	board.moveCard(a.id, 'Done');
	assert.ok(board.claimCard(b.id, 'w2', { maxConcurrent: 1 }), 'the slot is reusable once it frees');
	board.close();
});

test('the ceiling holds against separate Board instances on the same file', () => {
	const { board, dbPath } = testBoard();
	const cards = ['a', 'b', 'c'].map((t) => board.createCard({ title: t, state: 'Ready' }));

	// A second daemon is a second connection, not a second in-memory counter.
	const other = new Board(openDb(dbPath));

	assert.ok(board.claimCard(cards[0]!.id, 'daemon-1', { maxConcurrent: 2 }));
	assert.ok(other.claimCard(cards[1]!.id, 'daemon-2', { maxConcurrent: 2 }));
	assert.equal(other.claimCard(cards[2]!.id, 'daemon-2', { maxConcurrent: 2 }), null, 'the third exceeds the cap');
	assert.equal(board.inFlightCount(), 2);

	other.close();
	board.close();
});

test('a scheduler with three slots runs three cards at once, and never a fourth', async () => {
	const { board } = testBoard();
	for (const t of ['a', 'b', 'c', 'd']) board.createCard({ title: t, state: 'Ready' });

	const gate = gatedExecutor();
	const scheduler = new Scheduler({
		board,
		config: testConfig({ maxConcurrent: 3, pollIntervalMs: 100 }),
		executor: gate.executor,
		log: silentLogger,
	});

	scheduler.start({ autoRun: true });
	await gate.waitForStart(3);

	// Give the loop room to overfill if the cap were only advisory.
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(gate.live, 3, 'exactly the three slots are occupied');
	assert.equal(board.inFlightCount(), 3, 'and the board agrees');
	assert.equal(gate.peak, 3, 'the fourth card never started');

	// Freeing one slot must pull the waiting card in.
	gate.release(gate.started[0]!);
	await gate.waitForStart(4);
	assert.equal(gate.peak, 3, 'still never more than three at once');

	gate.releaseAll();
	await scheduler.stop();
	board.close();
});

test('maxConcurrent 1 keeps execution strictly sequential', async () => {
	const { board } = testBoard();
	for (const t of ['a', 'b']) board.createCard({ title: t, state: 'Ready' });

	const gate = gatedExecutor();
	const scheduler = new Scheduler({
		board,
		config: testConfig({ maxConcurrent: 1, pollIntervalMs: 100 }),
		executor: gate.executor,
		log: silentLogger,
	});

	scheduler.start({ autoRun: true });
	await gate.waitForStart(1);
	await new Promise((r) => setTimeout(r, 80));

	assert.equal(gate.peak, 1, 'the default behaviour is unchanged');
	gate.releaseAll();
	await scheduler.stop();
	board.close();
});

test('stopping one card leaves the other lanes running', async () => {
	const { board } = testBoard();
	const a = board.createCard({ title: 'a', state: 'Ready', priority: 10 });
	board.createCard({ title: 'b', state: 'Ready', priority: 5 });

	const aborted: string[] = [];
	const gates = new Map<string, () => void>();
	const scheduler = new Scheduler({
		board,
		config: testConfig({ maxConcurrent: 2, pollIntervalMs: 100 }),
		executor: async (card, ctx) => {
			ctx.signal.addEventListener('abort', () => {
				aborted.push(card.id);
				gates.get(card.id)?.();
			});
			await new Promise<void>((resolve) => gates.set(card.id, resolve));
			return okResult(ctx.runId, ctx.signal.aborted ? { status: 'FAILED' } : {});
		},
		log: silentLogger,
	});

	scheduler.start({ autoRun: true });
	const deadline = Date.now() + 5000;
	while (gates.size < 2 && Date.now() < deadline) await new Promise((r) => setImmediate(r));
	assert.equal(gates.size, 2, 'both lanes are busy');

	assert.equal(scheduler.stopCurrentCard(a.id), true);
	assert.deepEqual(aborted, [a.id], 'only the named card was interrupted');

	for (const gate of gates.values()) gate();
	await scheduler.stop();
	board.close();
});

test('the scheduler row lists every in-flight card, not only the first', async () => {
	const { board } = testBoard();
	for (const t of ['a', 'b']) board.createCard({ title: t, state: 'Ready' });

	const gate = gatedExecutor();
	const scheduler = new Scheduler({
		board,
		config: testConfig({ maxConcurrent: 2, pollIntervalMs: 100 }),
		executor: gate.executor,
		log: silentLogger,
	});

	scheduler.start({ autoRun: true });
	await gate.waitForStart(2);
	await new Promise((r) => setTimeout(r, 50));

	const status = board.schedulerStatus();
	assert.equal(status.inFlight.length, 2, `two lanes expected, got ${JSON.stringify(status.inFlight)}`);
	assert.ok(status.currentCardId, 'the legacy single-card field still reports the oldest lane');
	assert.equal(status.currentCardId, status.inFlight[0]?.cardId);

	gate.releaseAll();
	await scheduler.stop();
	board.close();
});

test('a scheduler at its ceiling stays idle instead of spinning', async () => {
	const { board, dbPath } = testBoard();
	const a = board.createCard({ title: 'a', state: 'Ready' });
	board.createCard({ title: 'b', state: 'Ready' });

	// Another worker already holds the only slot.
	const other = new Board(openDb(dbPath));
	other.claimCard(a.id, 'someone-else', { maxConcurrent: 1 });

	const gate = gatedExecutor();
	const scheduler = new Scheduler({
		board,
		config: testConfig({ maxConcurrent: 1, pollIntervalMs: 100 }),
		executor: gate.executor,
		log: silentLogger,
	});

	scheduler.start({ autoRun: true });
	await once(scheduler, 'idle');

	assert.equal(gate.started.length, 0, 'it ran nothing while the board was full');
	assert.equal(board.schedulerStatus().runState, 'idle');

	await scheduler.stop();
	other.close();
	board.close();
});

test('the slot ceiling can be raised for one run without editing config', () => {
	// The flag is documented, so it must reach the config the claim guard reads.
	assert.equal(loadConfig({ maxConcurrent: 4 }).maxConcurrent, 4);
	assert.equal(loadConfig({}).maxConcurrent, 1, 'and one slot stays the default');

	// A nonsense value is refused rather than silently clamped: 0 slots would
	// deadlock the board with no explanation.
	assert.throws(() => loadConfig({ maxConcurrent: 0 }), /must be >= 1/);
	assert.throws(() => loadConfig({ maxConcurrent: 2.5 }), /whole number of slots/);
});
