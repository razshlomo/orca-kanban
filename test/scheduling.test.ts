import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRelative, parseDueAt, parseDuration } from '../src/text.ts';
import { okResult, silentLogger, testBoard, testConfig } from './helpers.ts';
import { Scheduler } from '../src/scheduler.ts';
import { schedulerLiveness } from '../src/board.ts';
import type { Card } from '../src/types.ts';

const HOUR = 3_600_000;
const DAY = 86_400_000;

test('durations parse the shapes a human types, and reject the rest', () => {
	assert.equal(parseDuration('30m'), 1_800_000);
	assert.equal(parseDuration('2h'), 2 * HOUR);
	assert.equal(parseDuration('7d'), 7 * DAY);
	assert.equal(parseDuration('1w'), 7 * DAY);
	assert.equal(parseDuration('1w2d'), 9 * DAY, 'compound durations add up');
	assert.equal(parseDuration('90'), 90 * 60_000, 'a bare number means minutes');

	for (const bad of ['', '   ', 'soon', '7', '7x', '1w2', 'd7', '-3d', '0d']) {
		if (bad === '7') continue; // covered above as minutes
		assert.equal(parseDuration(bad), null, `${JSON.stringify(bad)} must not parse`);
	}
});

test('a due time can be a duration from now or an absolute date', () => {
	const now = Date.UTC(2026, 7, 12, 12, 0, 0);
	assert.equal(parseDueAt('7d', now), now + 7 * DAY);
	assert.equal(parseDueAt('2026-08-19T00:00:00Z', now), Date.UTC(2026, 7, 19));
	assert.equal(parseDueAt('nonsense', now), null);
});

test('relative times read the way a board needs them to', () => {
	const now = 1_000_000_000_000;
	assert.equal(formatRelative(now + 6 * DAY, now), 'in 6d');
	assert.equal(formatRelative(now + 2 * HOUR, now), 'in 2h');
	assert.equal(formatRelative(now - 30 * 60_000, now), '30m ago');
});

test('a card held for later is Ready but not eligible until it is due', () => {
	const { board } = testBoard();
	const later = board.createCard({ title: 'check Y', state: 'Ready', notBefore: Date.now() + DAY });
	const now = board.createCard({ title: 'runnable', state: 'Ready' });

	const eligible = board.eligibleCards().map((c) => c.id);
	assert.deepEqual(eligible, [now.id], 'only the due card is offered');
	assert.equal(board.getCard(later.id)?.state, 'Ready', 'it stays on the board, visibly waiting');

	// Time passing is all it takes — the query decides, not a timer.
	const afterwards = board.eligibleCards(Date.now() + 2 * DAY).map((c) => c.id);
	assert.ok(afterwards.includes(later.id), 'once due, it is picked up');
	board.close();
});

test('a deferred card cannot be claimed early even by a direct claim', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'later', state: 'Ready', notBefore: Date.now() + DAY });

	assert.equal(board.claimCard(card.id, 'w1'), null, 'the claim guard enforces the schedule too');
	board.close();
});

test('snoozing parks a card in Ready with a due time and clears any claim', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Review' });
	board.claimCard(card.id, 'w1');

	const dueAt = Date.now() + 3 * DAY;
	const snoozed = board.snoozeCard(card.id, dueAt);

	assert.equal(snoozed?.state, 'Ready');
	assert.equal(snoozed?.notBefore, dueAt);
	assert.equal(snoozed?.claimedBy, null);
	assert.equal(board.eligibleCards().length, 0, 'not runnable yet');
	board.close();
});

test('nextWakeAt reports the soonest deferred card so the loop can sleep', () => {
	const { board } = testBoard();
	assert.equal(board.nextWakeAt(), null, 'nothing waiting');

	const soon = Date.now() + HOUR;
	board.createCard({ title: 'far', state: 'Ready', notBefore: Date.now() + 5 * DAY });
	board.createCard({ title: 'soon', state: 'Ready', notBefore: soon });
	board.createCard({ title: 'now', state: 'Ready' });

	assert.equal(board.nextWakeAt(), soon, 'the earliest deadline wins');
	board.close();
});

test('a recurring card re-arms itself when it reaches Done instead of finishing', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'weekly check', state: 'Review', repeatEveryMs: 7 * DAY });

	const after = board.moveCard(card.id, 'Done');

	assert.equal(after?.state, 'Ready', 'it goes back into play');
	assert.ok(after?.notBefore, 'with a future due time');
	assert.ok(after.notBefore > Date.now() + 6 * DAY, `expected ~7d out, got ${after.notBefore - Date.now()}ms`);
	assert.equal(after?.attemptCount, 0, 'and a fresh retry budget');
	assert.equal(board.eligibleCards().length, 0, 'but not runnable until next week');
	board.close();
});

test('approving a recurring card schedules the next occurrence and keeps the trail', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'weekly', state: 'Review', repeatEveryMs: 7 * DAY });

	const after = board.approveCard(card.id, { comment: 'all good' });

	assert.equal(after?.state, 'Ready', 'approval re-arms rather than ends it');
	assert.equal(board.commentsForCard(card.id).at(-1)?.kind, 'approved', 'the verdict is still recorded');
	board.close();
});

test('a non-recurring card just stays Done', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'one-off', state: 'Review' });

	assert.equal(board.moveCard(card.id, 'Done')?.state, 'Done');
	board.close();
});

test('recurrence survives an unattended finish and accumulates run history', async () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'nightly', state: 'Ready', repeatEveryMs: DAY });

	const scheduler = new Scheduler({
		board,
		config: testConfig({ successState: 'Done', pollIntervalMs: 100 }),
		executor: async (_card, ctx) => okResult(ctx.runId),
		log: silentLogger,
	});

	// First occurrence runs to completion with successState Done.
	const outcome = await scheduler.runOnce();
	assert.equal(outcome?.result.status, 'DONE');

	const after = board.getCard(card.id);
	assert.equal(after?.state, 'Ready', 're-armed without a human touching it');
	assert.ok((after?.notBefore ?? 0) > Date.now() + 23 * HOUR, 'due about a day later');
	assert.equal(board.runsForCard(card.id).length, 1, 'the history stays on the one card');

	await scheduler.stop();
	board.close();
});

test('a due recurring card runs again and adds a second run to the same card', async () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'nightly', state: 'Ready', repeatEveryMs: DAY });

	const scheduler = new Scheduler({
		board,
		config: testConfig({ successState: 'Done', pollIntervalMs: 100 }),
		executor: async (_card, ctx) => okResult(ctx.runId),
		log: silentLogger,
	});

	await scheduler.runOnce();
	// Pretend a day passed rather than waiting for one.
	board.updateCard(card.id, { notBefore: Date.now() - 1000 });
	await scheduler.runOnce();

	assert.equal(board.runsForCard(card.id).length, 2, 'two occurrences, one card, one history');
	await scheduler.stop();
	board.close();
});

test('a still Ready card explains itself, so a held card is not mistaken for a stuck one', () => {
	const { board } = testBoard();
	const now = Date.now();

	const runnable = board.createCard({ title: 'runnable', state: 'Ready' });
	assert.equal(board.whyNotRunnable(runnable), null, 'a runnable card has nothing to explain');

	const held = board.createCard({ title: 'held', state: 'Ready', notBefore: now + 7 * 86_400_000 });
	assert.match(board.whyNotRunnable(held) ?? '', /^due in 7d$/);

	const spent = board.createCard({ title: 'spent', state: 'Ready', maxAttempts: 1 });
	board.claimCard(spent.id, 'w');
	board.moveCard(spent.id, 'Ready');
	assert.equal(board.whyNotRunnable(board.getCard(spent.id) as Card), 'no retries left');

	const blocker = board.createCard({ title: 'blocker', state: 'Backlog' });
	const waiting = board.createCard({ title: 'waiting', state: 'Ready', dependencies: [blocker.id] });
	assert.equal(board.whyNotRunnable(waiting), `waiting on ${blocker.id}`);
	board.moveCard(blocker.id, 'Done');
	assert.equal(board.whyNotRunnable(board.getCard(waiting.id) as Card), null, 'and clears when the dep lands');

	const claimed = board.createCard({ title: 'claimed', state: 'Ready' });
	board.claimCard(claimed.id, 'w');
	// Claiming moves it to In Progress, whose column already explains the stillness.
	assert.equal(board.whyNotRunnable(board.getCard(claimed.id) as Card), null);

	board.close();
});

test('a Backlog card is never eligible, however due it is', () => {
	const { board } = testBoard();
	// The whole point of Backlog: parking a card there means it cannot start, and a
	// date in the past must not change that.
	const parked = board.createCard({ title: 'parked', state: 'Backlog', notBefore: Date.now() - 60_000 });

	assert.equal(board.getNextEligibleCard(), null, 'nothing runs out of Backlog');
	assert.equal(board.eligibleCards().length, 0);
	assert.equal(board.nextWakeAt(), null, 'and it does not even schedule a wakeup');

	board.moveCard(parked.id, 'Ready');
	assert.equal(board.getNextEligibleCard()?.id, parked.id, 'moving it to Ready is what arms it');
	board.close();
});

test('a card held in Ready wakes on its own, with no move needed', () => {
	const { board } = testBoard();
	const soon = Date.now() + 40;
	const card = board.createCard({ title: 'wakes', state: 'Ready', notBefore: soon });

	assert.equal(board.getNextEligibleCard(soon - 10), null, 'not yet');
	assert.equal(board.nextWakeAt(soon - 10), soon, 'and the loop knows exactly when to look again');
	assert.equal(board.getNextEligibleCard(soon + 1)?.id, card.id, 'due, with no human touching the column');
	board.close();
});

test('a scheduler row that outlived its process is reported as not running', () => {
	const { board } = testBoard();
	const base = board.schedulerStatus();

	assert.equal(schedulerLiveness(base, 2000).alive, false, 'a board nobody has run yet');
	assert.match(schedulerLiveness(base, 2000).reason, /has ever run/);

	// The exact trap: a finished `run` leaves autoRun on and the state looking healthy.
	const stale = { ...base, autoRun: true, runState: 'idle' as const, ownerPid: 999_999, heartbeatAt: Date.now() };
	assert.equal(schedulerLiveness(stale, 2000).alive, false, 'a dead pid is not idle, it is absent');
	assert.match(schedulerLiveness(stale, 2000).reason, /999999 is gone/);

	// A live pid with an old heartbeat: recycled pid, or a wedged loop.
	const wedged = { ...base, ownerPid: process.pid, heartbeatAt: Date.now() - 60_000 };
	assert.equal(schedulerLiveness(wedged, 2000).alive, false);
	assert.match(schedulerLiveness(wedged, 2000).reason, /no heartbeat/);

	const healthy = { ...base, ownerPid: process.pid, heartbeatAt: Date.now() };
	assert.equal(schedulerLiveness(healthy, 2000).alive, true);
	board.close();
});

test('a slow poll interval does not make a healthy scheduler look dead', () => {
	const { board } = testBoard();
	const slow = 30_000;
	const status = { ...board.schedulerStatus(), ownerPid: process.pid, heartbeatAt: Date.now() - 45_000 };

	// One missed beat at a 30s interval is still within tolerance (3 intervals).
	assert.equal(schedulerLiveness(status, slow).alive, true, 'tolerance scales with the configured interval');
	assert.equal(
		schedulerLiveness({ ...status, heartbeatAt: Date.now() - 95_000 }, slow).alive,
		false,
		'but a long silence is still a death',
	);
	board.close();
});

test('the loop keeps the pid current, so a takeover is visible', async () => {
	const { board } = testBoard();
	const scheduler = new Scheduler({
		board,
		config: testConfig({ pollIntervalMs: 100 }),
		executor: async (_card, ctx) => okResult(ctx.runId),
		log: silentLogger,
	});

	// A crashed predecessor left its pid behind.
	board.patchSchedulerState({ ownerPid: 999_999, heartbeatAt: Date.now() - 600_000 });
	assert.equal(schedulerLiveness(board.schedulerStatus(), 100).alive, false);

	scheduler.start({ autoRun: false });
	try {
		await new Promise((r) => setTimeout(r, 250));
		const live = schedulerLiveness(board.schedulerStatus(), 100);
		assert.equal(live.alive, true, 'the running loop claimed the row');
		assert.equal(board.schedulerStatus().ownerPid, process.pid);
	} finally {
		await scheduler.stop();
		board.close();
	}
});
