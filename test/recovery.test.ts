import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverStrandedCards } from '../src/recovery.ts';
import { agentRow, fakeOrca, silentLogger, testBoard, testConfig, worktreeRow } from './helpers.ts';
import type { Board } from '../src/board.ts';
import type { Card } from '../src/types.ts';

/** Puts a card in the exact shape a crash leaves behind: In Progress with an open run. */
function strandCard(
	board: Board,
	options: { maxAttempts?: number; worktreePath?: string; worktreeId?: string } = {},
): { card: Card; runId: string } {
	const created = board.createCard({
		title: 'interrupted work',
		state: 'Ready',
		maxAttempts: options.maxAttempts ?? 2,
	});
	const claimed = board.claimCard(created.id, 'dead-worker');
	assert.ok(claimed, 'card should be claimable');

	const run = board.startRun(created.id, 'term_dead');
	board.attachSession(created.id, {
		sessionId: 'term_dead',
		worktreeId: options.worktreeId ?? 'repo::/tmp/fake',
		worktreePath: options.worktreePath ?? '/tmp/fake',
		branch: 'fake',
	});

	return { card: board.getCard(created.id)!, runId: run.id };
}

test('a card whose Orca agent is still working is adopted, not restarted', async () => {
	const { board } = testBoard();
	const { card, runId } = strandCard(board);

	const orca = fakeOrca({ psFrames: [[worktreeRow({ agents: [agentRow('working')] })]] });
	const report = await recoverStrandedCards({ board, orca, config: testConfig(), log: silentLogger });

	assert.equal(report.inspected, 1);
	assert.equal(report.adopted.length, 1, 'the live session is adopted');
	assert.equal(report.requeued.length, 0);
	assert.equal(board.getCard(card.id)?.state, 'In Progress', 'the card keeps running');

	const decision = report.adopted[0]!;
	assert.equal(decision.resume?.runId, runId, 'the original run is resumed so its result file still counts');
	assert.equal(decision.resume?.worktreePath, '/tmp/fake');
	assert.equal(board.openRunsForCard(card.id).length, 1, 'the run stays open');
	board.close();
});

test('a card whose agent already finished is adopted so its result is harvested', async () => {
	const { board } = testBoard();
	const { card } = strandCard(board);

	const orca = fakeOrca({ psFrames: [[worktreeRow({ agents: [agentRow('done')] })]] });
	const report = await recoverStrandedCards({ board, orca, config: testConfig(), log: silentLogger });

	assert.equal(report.adopted.length, 1, 'a finished agent is still worth re-attaching to');
	assert.equal(board.getCard(card.id)?.state, 'In Progress');
	board.close();
});

test('a card whose worktree is gone returns to Ready and its run is marked interrupted', async () => {
	const { board } = testBoard();
	const { card, runId } = strandCard(board, { maxAttempts: 3 });

	const orca = fakeOrca({ psFrames: [[]] });
	const report = await recoverStrandedCards({ board, orca, config: testConfig(), log: silentLogger });

	assert.equal(report.requeued.length, 1);
	const after = board.getCard(card.id)!;
	assert.equal(after.state, 'Ready', 'the card is runnable again');
	assert.equal(after.claimedBy, null, 'the dead worker no longer holds the claim');
	assert.equal(after.lastResult, 'INTERRUPTED');
	assert.match(after.lastError ?? '', /interrupted/i);

	const runs = board.runsForCard(card.id);
	assert.equal(runs.find((r) => r.id === runId)?.status, 'INTERRUPTED', 'the abandoned run is closed out');
	assert.equal(board.openRunsForCard(card.id).length, 0, 'no run is left dangling');
	assert.equal(board.eligibleCards().length, 1, 'it will be picked up again');
	board.close();
});

test('an interrupted agent is not adopted', async () => {
	const { board } = testBoard();
	const { card } = strandCard(board);

	const orca = fakeOrca({ psFrames: [[worktreeRow({ agents: [agentRow('working', { interrupted: true })] })]] });
	const report = await recoverStrandedCards({ board, orca, config: testConfig(), log: silentLogger });

	assert.equal(report.adopted.length, 0, 'an interrupted session cannot be resumed');
	assert.equal(board.getCard(card.id)?.state, 'Ready');
	board.close();
});

test('a stranded card with no retry budget left is blocked, never silently dropped', async () => {
	const { board } = testBoard();
	const { card } = strandCard(board, { maxAttempts: 1 });

	const orca = fakeOrca({ psFrames: [[]] });
	const report = await recoverStrandedCards({ board, orca, config: testConfig(), log: silentLogger });

	assert.equal(report.blocked.length, 1);
	assert.equal(board.getCard(card.id)?.state, 'Blocked');
	assert.match(report.blocked[0]!.reason, /retry budget exhausted/);
	board.close();
});

test('recoveryPolicy=blocked sends stranded cards to Blocked even with retries left', async () => {
	const { board } = testBoard();
	const { card } = strandCard(board, { maxAttempts: 5 });

	const orca = fakeOrca({ psFrames: [[]] });
	const report = await recoverStrandedCards({
		board,
		orca,
		config: testConfig({ recoveryPolicy: 'blocked' }),
		log: silentLogger,
	});

	assert.equal(report.blocked.length, 1);
	assert.equal(board.getCard(card.id)?.state, 'Blocked');
	board.close();
});

test('an unreachable Orca runtime does not strand cards', async () => {
	const { board } = testBoard();
	const { card } = strandCard(board, { maxAttempts: 3 });

	const orca = fakeOrca();
	orca.worktreePs = async () => {
		throw new Error('runtime unreachable');
	};

	const report = await recoverStrandedCards({ board, orca, config: testConfig(), log: silentLogger });

	assert.equal(report.requeued.length, 1, 'cards are recovered even when Orca cannot be queried');
	assert.equal(board.getCard(card.id)?.state, 'Ready');
	board.close();
});

test('recovery clears a scheduler row left claiming to be running', async () => {
	const { board } = testBoard();
	board.patchSchedulerState({ runState: 'running', currentCardId: 'card_ghost', currentRunId: 'run_ghost' });

	await recoverStrandedCards({ board, orca: fakeOrca({ psFrames: [[]] }), config: testConfig(), log: silentLogger });

	const status = board.schedulerStatus();
	assert.equal(status.runState, 'stopped', 'a stale running state would freeze the UI');
	assert.equal(status.currentCardId, null);
	assert.equal(status.currentRunId, null);
	board.close();
});

test('a clean board needs no recovery', async () => {
	const { board } = testBoard();
	board.createCard({ title: 'untouched', state: 'Ready' });

	const report = await recoverStrandedCards({
		board,
		orca: fakeOrca({ psFrames: [[]] }),
		config: testConfig(),
		log: silentLogger,
	});

	assert.equal(report.inspected, 0);
	assert.equal(report.adopted.length + report.requeued.length + report.blocked.length, 0);
	assert.equal(board.getCard(board.listCards()[0]!.id)?.state, 'Ready');
	board.close();
});

test('recovery is recorded in the event log for the UI', async () => {
	const { board } = testBoard();
	strandCard(board, { maxAttempts: 3 });

	await recoverStrandedCards({ board, orca: fakeOrca({ psFrames: [[]] }), config: testConfig(), log: silentLogger });

	assert.ok(
		board.recentEvents(20).some((e) => e['event'] === 'card_recovered'),
		'the state change is explained in the history',
	);
	board.close();
});
