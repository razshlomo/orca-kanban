import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import type { Board } from '../src/board.ts';
import { Scheduler } from '../src/scheduler.ts';
import { okResult, recordingExecutor, silentLogger, testBoard, testConfig } from './helpers.ts';
import type { Card, SchedulerStatus } from '../src/types.ts';

/** Runs the loop until it reports it has nothing left to do. */
async function drain(scheduler: Scheduler): Promise<void> {
	const idle = once(scheduler, 'idle');
	scheduler.start({ autoRun: true });
	await idle;
	await scheduler.stop();
}

/** Awaits the first scheduler `event` matching a predicate. */
function nextEvent(scheduler: Scheduler, match: (event: Record<string, unknown>) => boolean): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const listener = (payload: Record<string, unknown>): void => {
		if (!match(payload)) return;
		scheduler.off('event', listener);
		resolve();
	};
	scheduler.on('event', listener);
	return promise;
}

/** Awaits the scheduler reaching a run state, without guessing a duration. */
function waitForRunState(board: Board, runState: SchedulerStatus['runState']): Promise<void> {
	if (board.schedulerStatus().runState === runState) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const listener = (status: SchedulerStatus): void => {
		if (status.runState !== runState) return;
		board.off('scheduler_state', listener);
		resolve();
	};
	board.on('scheduler_state', listener);
	return promise;
}

test('A(10) then B(1); C(20) inserted while A runs executes A -> C -> B', async () => {
	const { board } = testBoard();
	const config = testConfig();
	const executed: string[] = [];

	board.createCard({ title: 'A', state: 'Ready', priority: 10 });
	board.createCard({ title: 'B', state: 'Ready', priority: 1 });

	// C is created *during* A's execution, which is the whole point: a scheduler
	// working from a precomputed queue would run A -> B -> C.
	const executor = recordingExecutor(executed, (card) => {
		if (card.title === 'A') board.createCard({ title: 'C', state: 'Ready', priority: 20 });
	});

	const scheduler = new Scheduler({ board, config, executor, log: silentLogger });
	await drain(scheduler);

	assert.deepEqual(executed, ['A', 'C', 'B'], 'the newly inserted higher-priority card is picked before older B');
	board.close();
});

test('a card blocked while another runs is never executed', async () => {
	const { board } = testBoard();
	const executed: string[] = [];

	board.createCard({ title: 'A', state: 'Ready', priority: 10 });
	const b = board.createCard({ title: 'B', state: 'Ready', priority: 5 });

	const executor = recordingExecutor(executed, (card) => {
		if (card.title === 'A') board.moveCard(b.id, 'Blocked');
	});

	const scheduler = new Scheduler({ board, config: testConfig(), executor, log: silentLogger });
	await drain(scheduler);

	assert.deepEqual(executed, ['A'], 'B was blocked mid-flight, so the next fresh read skipped it');
	assert.equal(board.getCard(b.id)?.state, 'Blocked');
	board.close();
});

test('a card deleted while another runs is never executed', async () => {
	const { board } = testBoard();
	const executed: string[] = [];

	board.createCard({ title: 'A', state: 'Ready', priority: 10 });
	const doomed = board.createCard({ title: 'B', state: 'Ready', priority: 5 });

	const executor = recordingExecutor(executed, (card) => {
		if (card.title === 'A') board.deleteCard(doomed.id);
	});

	const scheduler = new Scheduler({ board, config: testConfig(), executor, log: silentLogger });
	await drain(scheduler);

	assert.deepEqual(executed, ['A'], 'no stale in-memory snapshot resurrected the deleted card');
	board.close();
});

test('a card reprioritised while another runs is picked in the new order', async () => {
	const { board } = testBoard();
	const executed: string[] = [];

	board.createCard({ title: 'A', state: 'Ready', priority: 10 });
	board.createCard({ title: 'B', state: 'Ready', priority: 5 });
	const c = board.createCard({ title: 'C', state: 'Ready', priority: 1 });

	const executor = recordingExecutor(executed, (card) => {
		// Promote the lowest-priority card while A is still running.
		if (card.title === 'A') board.updateCard(c.id, { priority: 100 });
	});

	const scheduler = new Scheduler({ board, config: testConfig(), executor, log: silentLogger });
	await drain(scheduler);

	assert.deepEqual(executed, ['A', 'C', 'B'], 'reprioritisation mid-run changes the next selection');
	board.close();
});

test('the board is re-read from storage after every completed card', async () => {
	const { board } = testBoard();
	const executed: string[] = [];

	board.createCard({ title: 'A', state: 'Ready', priority: 3 });
	board.createCard({ title: 'B', state: 'Ready', priority: 2 });

	// Count selections instead of trusting the loop's shape.
	let selections = 0;
	const original = board.getNextEligibleCard.bind(board);
	board.getNextEligibleCard = (): Card | null => {
		selections += 1;
		return original();
	};

	const scheduler = new Scheduler({
		board,
		config: testConfig(),
		executor: recordingExecutor(executed),
		log: silentLogger,
	});
	await drain(scheduler);

	assert.deepEqual(executed, ['A', 'B']);
	assert.ok(selections >= 3, `expected a fresh selection per card plus the final empty read, got ${selections}`);
	board.close();
});

test('dependencies are honoured across iterations, not just at start', async () => {
	const { board } = testBoard();
	const executed: string[] = [];

	const first = board.createCard({ title: 'first', state: 'Ready', priority: 1 });
	board.createCard({ title: 'second', state: 'Ready', priority: 99, dependencies: [first.id] });

	const scheduler = new Scheduler({
		board,
		config: testConfig({ successState: 'Done' }),
		executor: recordingExecutor(executed),
		log: silentLogger,
	});
	await drain(scheduler);

	assert.deepEqual(executed, ['first', 'second'], 'the gated card only became eligible once its dependency was Done');
	board.close();
});

test('a dependency that ends in Review keeps the dependent card waiting', async () => {
	const { board } = testBoard();
	const executed: string[] = [];

	const first = board.createCard({ title: 'first', state: 'Ready' });
	board.createCard({ title: 'gated', state: 'Ready', dependencies: [first.id] });

	// successState=Review means the dependency never reaches Done on its own.
	const scheduler = new Scheduler({
		board,
		config: testConfig({ successState: 'Review' }),
		executor: recordingExecutor(executed),
		log: silentLogger,
	});
	await drain(scheduler);

	assert.deepEqual(executed, ['first'], 'Review is not Done, so the dependent card stays put');
	board.close();
});

test('only one card runs at a time', async () => {
	const { board } = testBoard();
	let concurrent = 0;
	let maxConcurrent = 0;

	for (let i = 0; i < 4; i += 1) board.createCard({ title: `card-${i}`, state: 'Ready', priority: i });

	const scheduler = new Scheduler({
		board,
		config: testConfig(),
		log: silentLogger,
		executor: async (_card, ctx) => {
			concurrent += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			// Yield repeatedly: a parallel scheduler would interleave here.
			for (let i = 0; i < 8; i += 1) await Promise.resolve();
			concurrent -= 1;
			return okResult(ctx.runId);
		},
	});
	await drain(scheduler);

	assert.equal(maxConcurrent, 1, 'execution is strictly sequential');
	board.close();
});

test('the scheduler stays idle instead of exiting, and picks up a card added later', async () => {
	const { board } = testBoard();
	const executed: string[] = [];
	const scheduler = new Scheduler({
		board,
		config: testConfig(),
		executor: recordingExecutor(executed),
		log: silentLogger,
	});

	const firstIdle = once(scheduler, 'idle');
	scheduler.start({ autoRun: true });
	await firstIdle;

	assert.deepEqual(executed, [], 'nothing to do yet');
	assert.ok(scheduler.isRunning, 'the loop is still alive after going idle');

	const ranLater = once(scheduler, 'card_finished');
	board.createCard({ title: 'late arrival', state: 'Ready' });
	await ranLater;

	assert.deepEqual(executed, ['late arrival'], 'a card added while idle is picked up');
	await scheduler.stop();
	board.close();
});

test('pause stops new pickups but leaves the loop alive', async () => {
	const { board } = testBoard();
	const executed: string[] = [];
	const scheduler = new Scheduler({
		board,
		config: testConfig(),
		executor: recordingExecutor(executed),
		log: silentLogger,
	});

	const paused = waitForRunState(board, 'paused');
	scheduler.start({ autoRun: false });
	await paused;

	board.createCard({ title: 'ignored while paused', state: 'Ready' });
	// The loop is provably parked in its paused branch, so nothing can pick this up.
	assert.deepEqual(executed, [], 'auto-run off means no pickups');
	assert.equal(board.schedulerStatus().autoRun, false);

	const ran = once(scheduler, 'card_finished');
	scheduler.setAutoRun(true);
	await ran;

	assert.deepEqual(executed, ['ignored while paused'], 'resuming picks the card up');
	await scheduler.stop();
	board.close();
});

test('stopAfterCurrent finishes the running card then disables auto-run', async () => {
	const { board } = testBoard();
	const executed: string[] = [];

	board.createCard({ title: 'current', state: 'Ready', priority: 10 });
	const next = board.createCard({ title: 'next', state: 'Ready', priority: 5 });

	const scheduler = new Scheduler({
		board,
		config: testConfig(),
		log: silentLogger,
		executor: recordingExecutor(executed, (card) => {
			if (card.title === 'current') scheduler.stopAfterCurrent();
		}),
	});

	// The loop announces the stop itself; no need to time-box the assertion.
	const stopped = nextEvent(
		scheduler,
		(e) => e['event'] === 'scheduler_idle' && e['reason'] === 'stop_after_current',
	);
	scheduler.start({ autoRun: true });
	await stopped;

	assert.deepEqual(executed, ['current'], 'the second card was not started');
	assert.equal(board.schedulerStatus().autoRun, false, 'auto-run is off');
	assert.ok(scheduler.isRunning, 'the loop itself is still alive and resumable');
	assert.equal(board.getCard(next.id)?.state, 'Ready', 'the queued card is untouched');

	await scheduler.stop();
	board.close();
});

test('stopCurrentCard aborts the in-flight card via its abort signal', async () => {
	const { board } = testBoard();
	board.createCard({ title: 'long runner', state: 'Ready', maxAttempts: 1 });

	let sawAbort = false;
	const scheduler = new Scheduler({
		board,
		config: testConfig(),
		log: silentLogger,
		executor: async (_card, ctx) => {
			// Wait for the operator's abort rather than a fixed sleep.
			await new Promise<void>((resolve) => {
				if (ctx.signal.aborted) return resolve();
				ctx.signal.addEventListener('abort', () => resolve(), { once: true });
			});
			sawAbort = ctx.signal.aborted;
			return okResult(ctx.runId, { status: 'FAILED', completionReason: 'stopped', error: 'stopped by operator' });
		},
	});

	scheduler.start({ autoRun: true });
	await once(scheduler, 'card_started');
	assert.equal(scheduler.stopCurrentCard(), true, 'there was a card to stop');
	await once(scheduler, 'card_finished');

	assert.ok(sawAbort, 'the executor observed the abort signal');
	await scheduler.stop();
	board.close();
});

test('a failing card is retried until its budget is gone, then blocked', async () => {
	const { board } = testBoard();
	const executed: string[] = [];

	board.createCard({ title: 'always fails', state: 'Ready', maxAttempts: 3 });

	const scheduler = new Scheduler({
		board,
		config: testConfig(),
		log: silentLogger,
		executor: recordingExecutor(executed, undefined, (_card, runId) =>
			okResult(runId, { status: 'FAILED', error: 'nope' }),
		),
	});
	await drain(scheduler);

	assert.equal(executed.length, 3, 'exactly maxAttempts attempts were made');
	const card = board.listCards()[0]!;
	assert.equal(card.state, 'Blocked');
	assert.equal(card.attemptCount, 3);
	assert.equal(board.runsForCard(card.id).length, 3, 'every attempt is in the history');
	board.close();
});

test('scheduler emits the documented lifecycle events with correlation ids', async () => {
	const { board } = testBoard();
	const seen: string[] = [];
	board.createCard({ title: 'observable', state: 'Ready' });

	const scheduler = new Scheduler({
		board,
		config: testConfig(),
		executor: recordingExecutor([]),
		log: silentLogger,
	});
	scheduler.on('event', (e: { event: string; cardId?: string }) => {
		seen.push(e.event);
		if (e.event !== 'scheduler_idle') assert.ok(e.cardId, `${e.event} carries a cardId`);
	});

	await drain(scheduler);

	for (const expected of ['card_selected', 'card_claimed', 'card_completed', 'scheduler_idle']) {
		assert.ok(seen.includes(expected), `expected a ${expected} event, saw ${seen.join(', ')}`);
	}

	const logged = board.recentEvents(50).map((e) => e['event']);
	assert.ok(logged.includes('card_claimed'), 'events are persisted for the UI history');
	board.close();
});

test('card state is mirrored onto Orca board columns as the card progresses', async () => {
	const { board } = testBoard();
	board.createCard({ title: 'mirrored', state: 'Ready' });

	const mirrored: string[] = [];
	const scheduler = new Scheduler({
		board,
		config: testConfig(),
		executor: recordingExecutor([]),
		log: silentLogger,
		mirror: async (_card, state) => {
			mirrored.push(state);
		},
	});
	await drain(scheduler);

	assert.deepEqual(mirrored, ['In Progress', 'Review'], 'mirrored when the card starts and when it settles');
	board.close();
});

test('losing a claim between selection and claim just re-reads the board', async () => {
	const { board } = testBoard();
	const executed: string[] = [];
	const card = board.createCard({ title: 'stolen', state: 'Ready' });

	// Steal the card in the window between selection and claim.
	const originalSelect = board.getNextEligibleCard.bind(board);
	let stolen = false;
	board.getNextEligibleCard = (): Card | null => {
		const picked = originalSelect();
		if (picked && !stolen) {
			stolen = true;
			board.claimCard(card.id, 'someone-else');
		}
		return picked;
	};

	const scheduler = new Scheduler({
		board,
		config: testConfig(),
		executor: recordingExecutor(executed),
		log: silentLogger,
	});
	await drain(scheduler);

	assert.deepEqual(executed, [], 'the scheduler did not execute a card it failed to claim');
	assert.equal(board.getCard(card.id)?.claimedBy, 'someone-else');
	board.close();
});
