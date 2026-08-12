import assert from 'node:assert/strict';
import test from 'node:test';
import { testBoard, testConfig, okResult } from './helpers.ts';

test('eligibility requires Ready, unclaimed, deps Done, and retry budget', async (t) => {
	const { board } = testBoard();

	const backlog = board.createCard({ title: 'backlog', state: 'Backlog' });
	const ready = board.createCard({ title: 'ready', state: 'Ready' });
	const blocked = board.createCard({ title: 'blocked', state: 'Blocked' });
	const review = board.createCard({ title: 'review', state: 'Review' });

	const eligible = board.eligibleCards().map((c) => c.id);
	assert.deepEqual(eligible, [ready.id], 'only the Ready card is runnable');
	assert.ok(!eligible.includes(backlog.id));
	assert.ok(!eligible.includes(blocked.id));
	assert.ok(!eligible.includes(review.id));

	await t.test('a claimed card stops being eligible', () => {
		assert.ok(board.claimCard(ready.id, 'w1'));
		assert.deepEqual(board.eligibleCards(), []);
	});

	await t.test('a card out of retry budget stops being eligible', () => {
		const exhausted = board.createCard({ title: 'exhausted', state: 'Ready', maxAttempts: 1 });
		assert.ok(board.claimCard(exhausted.id, 'w1'), 'first attempt allowed');
		board.releaseClaim(exhausted.id, 'Ready');
		assert.equal(board.getCard(exhausted.id)?.attemptCount, 1);
		assert.equal(
			board.eligibleCards().find((c) => c.id === exhausted.id),
			undefined,
			'attemptCount === maxAttempts blocks another attempt',
		);
	});

	board.close();
});

test('prioritization is priority, then board order, then creation time', () => {
	const { board } = testBoard();

	const low = board.createCard({ title: 'low', state: 'Ready', priority: 1, order: 1 });
	const high = board.createCard({ title: 'high', state: 'Ready', priority: 10, order: 9 });
	const mid1 = board.createCard({ title: 'mid-order-2', state: 'Ready', priority: 5, order: 2 });
	const mid2 = board.createCard({ title: 'mid-order-1', state: 'Ready', priority: 5, order: 1 });

	assert.deepEqual(
		board.eligibleCards().map((c) => c.id),
		[high.id, mid2.id, mid1.id, low.id],
		'higher priority first; ties broken by ascending board order',
	);

	board.close();
});

test('dependencies gate a card until every dependency is Done', () => {
	const { board } = testBoard();

	const dep = board.createCard({ title: 'dep', state: 'Ready' });
	const gated = board.createCard({ title: 'gated', state: 'Ready', priority: 100, dependencies: [dep.id] });

	assert.deepEqual(board.eligibleCards().map((c) => c.id), [dep.id], 'gated card waits despite higher priority');

	board.moveCard(dep.id, 'Review');
	assert.deepEqual(board.eligibleCards().map((c) => c.id), [], 'Review is not Done');

	board.moveCard(dep.id, 'Done');
	assert.deepEqual(board.eligibleCards().map((c) => c.id), [gated.id], 'dependency Done unblocks the card');

	board.close();
});

test('a dependency id that is not on the board keeps the card ineligible', () => {
	const { board } = testBoard();
	board.createCard({ title: 'typo dep', state: 'Ready', priority: 50, dependencies: ['card_does_not_exist'] });
	assert.deepEqual(board.eligibleCards(), [], 'an unknown dependency blocks rather than silently passing');
	board.close();
});

test('claimCard is a guarded transition: only one caller wins', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'contested', state: 'Ready', maxAttempts: 5 });

	const first = board.claimCard(card.id, 'worker-1');
	const second = board.claimCard(card.id, 'worker-2');

	assert.ok(first, 'first claim wins');
	assert.equal(first?.state, 'In Progress');
	assert.equal(first?.claimedBy, 'worker-1');
	assert.equal(first?.attemptCount, 1, 'claiming consumes one attempt');
	assert.equal(second, null, 'second claim is rejected');
	assert.equal(board.getCard(card.id)?.claimedBy, 'worker-1', 'the winner keeps the claim');

	board.close();
});

test('claimNext skips cards it cannot claim and still makes progress', () => {
	const { board } = testBoard();
	const first = board.createCard({ title: 'first', state: 'Ready', priority: 10 });
	const second = board.createCard({ title: 'second', state: 'Ready', priority: 5 });

	board.claimCard(first.id, 'other-worker');
	const claimed = board.claimNext('me');

	assert.equal(claimed?.id, second.id, 'falls through to the next candidate');
	board.close();
});

test('moveCard out of In Progress clears the claim', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'stuck', state: 'Ready' });
	board.claimCard(card.id, 'w1');

	const moved = board.moveCard(card.id, 'Ready');
	assert.equal(moved?.claimedBy, null, 'dragging a card out of In Progress releases it');
	board.close();
});

test('persistResult maps agent status onto the next board state', async (t) => {
	const config = testConfig();

	await t.test('DONE lands on the configured success state', () => {
		const { board } = testBoard();
		const card = board.createCard({ title: 'ok', state: 'Ready' });
		const claimed = board.claimCard(card.id, 'w')!;
		const run = board.startRun(card.id, null);
		const after = board.persistResult(claimed, okResult(run.id), { successState: 'Review' });
		assert.equal(after.state, 'Review');
		assert.equal(after.claimedBy, null, 'claim is released');
		assert.equal(after.lastResult, 'DONE');
		board.close();
	});

	await t.test('successState=Done sends completed cards straight to Done', () => {
		const { board } = testBoard();
		const card = board.createCard({ title: 'ok', state: 'Ready' });
		const claimed = board.claimCard(card.id, 'w')!;
		const run = board.startRun(card.id, null);
		assert.equal(board.persistResult(claimed, okResult(run.id), { successState: 'Done' }).state, 'Done');
		board.close();
	});

	await t.test('BLOCKED goes to Blocked regardless of retries', () => {
		const { board } = testBoard();
		const card = board.createCard({ title: 'blocked', state: 'Ready', maxAttempts: 5 });
		const claimed = board.claimCard(card.id, 'w')!;
		const run = board.startRun(card.id, null);
		const after = board.persistResult(
			claimed,
			okResult(run.id, { status: 'BLOCKED', error: 'needs credentials' }),
			{ successState: config.successState },
		);
		assert.equal(after.state, 'Blocked');
		assert.equal(after.lastError, 'needs credentials');
		board.close();
	});

	await t.test('FAILED returns to Ready while retries remain, then Blocked', () => {
		const { board } = testBoard();
		const card = board.createCard({ title: 'flaky', state: 'Ready', maxAttempts: 2 });

		const firstClaim = board.claimCard(card.id, 'w')!;
		const firstRun = board.startRun(card.id, null);
		const afterFirst = board.persistResult(firstClaim, okResult(firstRun.id, { status: 'FAILED', error: 'boom' }), {
			successState: 'Review',
		});
		assert.equal(afterFirst.state, 'Ready', 'retry budget remains after attempt 1 of 2');

		const secondClaim = board.claimCard(card.id, 'w')!;
		const secondRun = board.startRun(card.id, null);
		const afterSecond = board.persistResult(secondClaim, okResult(secondRun.id, { status: 'FAILED', error: 'boom' }), {
			successState: 'Review',
		});
		assert.equal(afterSecond.state, 'Blocked', 'exhausted retries land on Blocked');
		assert.equal(afterSecond.attemptCount, 2);
		board.close();
	});

	await t.test('NEEDS_REVIEW always lands on Review', () => {
		const { board } = testBoard();
		const card = board.createCard({ title: 'review me', state: 'Ready' });
		const claimed = board.claimCard(card.id, 'w')!;
		const run = board.startRun(card.id, null);
		assert.equal(
			board.persistResult(claimed, okResult(run.id, { status: 'NEEDS_REVIEW' }), { successState: 'Done' }).state,
			'Review',
		);
		board.close();
	});
});

test('run history is append-only and keeps every attempt', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'twice', state: 'Ready', maxAttempts: 3 });

	for (const status of ['FAILED', 'DONE'] as const) {
		const claimed = board.claimCard(card.id, 'w')!;
		const run = board.startRun(card.id, null);
		board.persistResult(claimed, okResult(run.id, { status }), { successState: 'Done' });
	}

	const runs = board.runsForCard(card.id);
	assert.equal(runs.length, 2, 'both attempts are retained');
	assert.deepEqual(runs.map((r) => r.status).sort(), ['DONE', 'FAILED']);
	assert.ok(runs.every((r) => r.finishedAt !== null));
	board.close();
});

test('retryCard restores retry budget and returns the card to Ready', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'retry me', state: 'Ready', maxAttempts: 1 });
	const claimed = board.claimCard(card.id, 'w')!;
	const run = board.startRun(card.id, null);
	board.persistResult(claimed, okResult(run.id, { status: 'FAILED', error: 'nope' }), { successState: 'Review' });
	assert.equal(board.getCard(card.id)?.state, 'Blocked');

	const retried = board.retryCard(card.id);
	assert.equal(retried?.state, 'Ready');
	assert.equal(retried?.attemptCount, 0);
	assert.equal(retried?.lastError, null);
	assert.equal(board.eligibleCards().length, 1, 'the card is runnable again');
	board.close();
});

test('reorderCards rewrites board order for drag and drop', () => {
	const { board } = testBoard();
	const a = board.createCard({ title: 'a', state: 'Ready', priority: 0 });
	const b = board.createCard({ title: 'b', state: 'Ready', priority: 0 });

	board.reorderCards([b.id, a.id]);
	assert.deepEqual(board.eligibleCards().map((c) => c.id), [b.id, a.id], 'explicit ordering wins at equal priority');
	board.close();
});

test('board revision advances on every mutation so watchers can wake', () => {
	const { board } = testBoard();
	const before = board.boardRevision();
	board.createCard({ title: 'x' });
	assert.ok(board.boardRevision() > before, 'creating a card bumps the revision');
	board.close();
});
