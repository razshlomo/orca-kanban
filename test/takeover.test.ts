import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOrcaExecutor } from '../src/executor.ts';
import { Scheduler } from '../src/scheduler.ts';
import type { Card } from '../src/types.ts';
import {
	agentRow,
	fakeOrca,
	fakeOrchestration,
	okResult,
	silentLogger,
	testBoard,
	testConfig,
	testEnv,
	worktreeRow,
} from './helpers.ts';

function card(over: Partial<Card> = {}): Card {
	const now = Date.now();
	return {
		id: 'card_test',
		title: 'Add a helper',
		description: '',
		acceptanceCriteria: '',
		state: 'In Progress',
		priority: 0,
		order: 1,
		dependencies: [],
		repo: '/tmp/repo',
		agent: null,
		createdAt: now,
		updatedAt: now,
		stateChangedAt: now,
		notBefore: null,
		manualSince: null,
		repeatEveryMs: null,
		claimedAt: now,
		claimedBy: 'test-worker',
		sessionId: null,
		branch: null,
		worktreePath: null,
		worktreeId: null,
		orcaTaskId: null,
		orcaDispatchId: null,
		commitSha: null,
		landedSha: null,
		landedAt: null,
		attemptCount: 1,
		maxAttempts: 2,
		lastResult: null,
		lastError: null,
		lastAgentSummary: null,
		...over,
	};
}

function fakeWorktree(): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'orca-kanban-takeover-'));
	mkdirSync(path.join(dir, '.orca-kanban'), { recursive: true });
	return dir;
}

function ctxFor(runId: string) {
	return { runId, signal: new AbortController().signal, log: silentLogger };
}

// --------------------------------------------------------------- the board rule

test('taking over marks the card without moving it', () => {
	const { board } = testBoard();
	const c = board.createCard({ title: 'live one' });
	board.moveCard(c.id, 'In Progress');

	const taken = board.handToHuman(c.id, 'took it');
	assert.ok(taken);
	assert.equal(taken.state, 'In Progress', 'nothing was judged, so the card must not move');
	assert.ok(taken.manualSince && taken.manualSince > 0);
	board.close();
});

test('a card that is not running has no session to take', () => {
	const { board } = testBoard();
	const c = board.createCard({ title: 'not started', state: 'Ready' });
	assert.throws(() => board.handToHuman(c.id, 'nope'), /only a running card/i);
	board.close();
});

test('taking over twice keeps the first timestamp, so Esc and a click cannot race', async () => {
	const { board } = testBoard();
	const c = board.createCard({ title: 'live one' });
	board.moveCard(c.id, 'In Progress');

	const first = board.handToHuman(c.id, 'esc in the terminal');
	await new Promise((r) => setTimeout(r, 5));
	const second = board.handToHuman(c.id, 'take over button');

	assert.equal(second?.manualSince, first?.manualSince);
	board.close();
});

test('a held card still refuses every destructive action, because its agent is live', () => {
	const { board } = testBoard();
	const c = board.createCard({ title: 'live one' });
	board.moveCard(c.id, 'In Progress');
	board.handToHuman(c.id, 'mine now');

	// Guards that already existed. The point is that holding a card by hand does not
	// quietly unlock them — the agent and its worktree are still there.
	assert.throws(() => board.deleteCard(c.id), /while it is running/i);
	assert.throws(() => board.retryCard(c.id), /while it is running/i);
	assert.throws(() => board.snoozeCard(c.id, Date.now() + 1000), /while it is running/i);
	board.close();
});

test('a held card keeps its slot: the lane is occupied by you', () => {
	const { board } = testBoard();
	const c = board.createCard({ title: 'live one' });
	board.moveCard(c.id, 'In Progress');
	board.handToHuman(c.id, 'mine now');

	assert.equal(board.inFlightCount(), 1, 'a hand-held card must still count against maxConcurrent');
	board.close();
});

test('a held card is never selected for execution', () => {
	const { board } = testBoard();
	const c = board.createCard({ title: 'live one' });
	board.moveCard(c.id, 'In Progress');
	board.handToHuman(c.id, 'mine now');

	assert.equal(board.getNextEligibleCard(), null);
	assert.ok(!board.eligibleCards().some((e) => e.id === c.id));
	board.close();
});

test('taking back refuses when the board is already watching', () => {
	const { board } = testBoard();
	const c = board.createCard({ title: 'live one' });
	board.moveCard(c.id, 'In Progress');
	assert.throws(() => board.takeBack(c.id), /already watching/i);
	board.close();
});

test('the hand-over and the hand-back are both written to the card trail', () => {
	const { board } = testBoard();
	const c = board.createCard({ title: 'live one' });
	board.moveCard(c.id, 'In Progress');
	board.handToHuman(c.id, 'Session taken over by hand.');
	board.takeBack(c.id);

	const trail = board.commentsForCard(c.id);
	assert.equal(trail.length, 2);
	assert.deepEqual(
		trail.map((t) => t.author),
		['board', 'board'],
	);
	assert.match(trail[1]?.body ?? '', /handed back/i);
	board.close();
});

test('manualCards reports exactly what a person is holding', () => {
	const { board } = testBoard();
	const a = board.createCard({ title: 'held' });
	const b = board.createCard({ title: 'running' });
	board.moveCard(a.id, 'In Progress');
	board.moveCard(b.id, 'In Progress');
	board.handToHuman(a.id, 'mine');

	assert.deepEqual(
		board.manualCards().map((c) => c.id),
		[a.id],
	);
	board.close();
});

// ----------------------------------------------------------------- the executor

test('a Take over click is seen even when the agent finishes in the same tick', async () => {
	testEnv();
	const worktree = fakeWorktree();
	const runId = 'run_race';

	// Worst case for the ordering: the result file exists AND Orca says the agent is
	// done, so the card would settle and the terminal would close on this very tick.
	writeFileSync(
		path.join(worktree, '.orca-kanban', `result-${runId}.json`),
		JSON.stringify({ status: 'DONE', summary: 'all finished' }),
		'utf8',
	);
	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [[worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('done')] })]],
	});

	const held = card({ manualSince: Date.now() });
	const execute = createOrcaExecutor({
		orca,
		// Armed on purpose: the point is that the guard stops the close, not the config.
		config: testConfig({ closeSessionWhenDone: true }),
		orchestration: fakeOrchestration,
		lookupCard: () => held,
	});

	const result = await execute(card(), ctxFor(runId));
	assert.equal(result.status, 'HANDED_OVER', 'the marker is checked above the result file for exactly this case');
	assert.ok(
		!orca.calls.some((c) => c.startsWith('terminalClose:')),
		'the session must survive a hand-over that raced a completion',
	);
});

test('a handed-over card cannot be persisted as a result', () => {
	const { board } = testBoard();
	const c = board.createCard({ title: 'live one' });
	board.moveCard(c.id, 'In Progress');

	const handed = okResult('run_1', { status: 'HANDED_OVER', completionReason: 'handed-over' });
	assert.throws(() => board.persistResult(c, handed, { successState: 'Review' }), /handToHuman/);
	board.close();
});

// ---------------------------------------------------------------- the scheduler

test('the scheduler routes a hand-over to the board instead of judging the card', async () => {
	const { board } = testBoard();
	const c = board.createCard({ title: 'steer me', state: 'Ready' });

	const scheduler = new Scheduler({
		board,
		config: testConfig({ successState: 'Done' }),
		executor: async (_card, ctx) =>
			okResult(ctx.runId, { status: 'HANDED_OVER', completionReason: 'handed-over', sessionId: 'term_x' }),
		log: silentLogger,
	});

	const outcome = await scheduler.runOnce();
	assert.equal(outcome?.result.status, 'HANDED_OVER');

	const after = board.getCard(c.id);
	assert.equal(after?.state, 'In Progress', 'a hand-over is not an outcome, so the card must not move');
	assert.ok(after?.manualSince, 'the card is now held by hand');
	assert.equal(after?.lastResult, null, 'nothing was judged, so no result may be recorded');
	assert.equal(board.openRunsForCard(c.id).length, 1, 'the run stays open — a person is driving it');
	board.close();
});

test('taking a card back re-watches the original run, so its result file is still found', async () => {
	const { board } = testBoard();
	const c = board.createCard({ title: 'steer me', state: 'Ready' });

	let phase: 'hand-over' | 'take-back' = 'hand-over';
	let seenResume: { runId: string; sessionId: string | null } | null = null;

	const scheduler = new Scheduler({
		board,
		config: testConfig({ successState: 'Done' }),
		executor: async (_card, ctx) => {
			if (phase === 'hand-over') {
				return okResult(ctx.runId, {
					status: 'HANDED_OVER',
					completionReason: 'handed-over',
					sessionId: 'term_x',
					worktreePath: '/tmp/wt',
					worktreeId: 'repo::/tmp/wt',
				});
			}
			seenResume = ctx.resume ? { runId: ctx.resume.runId, sessionId: ctx.resume.sessionId } : null;
			return okResult(ctx.runId, { status: 'DONE' });
		},
		log: silentLogger,
	});

	await scheduler.runOnce();
	board.attachSession(c.id, {
		sessionId: 'term_x',
		worktreeId: 'repo::/tmp/wt',
		worktreePath: '/tmp/wt',
		branch: 'wt',
	});
	const openRun = board.openRunsForCard(c.id)[0];
	assert.ok(openRun);

	phase = 'take-back';
	const { settled } = await scheduler.takeBack(c.id);
	await settled;

	// The agent was told to write result-<originalRunId>.json. A fresh run id would wait
	// for a file that will never appear.
	assert.deepEqual(seenResume, { runId: openRun.id, sessionId: 'term_x' });

	const after = board.getCard(c.id);
	assert.equal(after?.manualSince, null, 'the board is watching again');
	assert.equal(after?.state, 'Done');
	board.close();
});

test('taking back a card nobody is holding is refused', async () => {
	const { board } = testBoard();
	const c = board.createCard({ title: 'idle', state: 'Ready' });
	const scheduler = new Scheduler({
		board,
		config: testConfig(),
		executor: async (_card, ctx) => okResult(ctx.runId),
		log: silentLogger,
	});
	await assert.rejects(() => scheduler.takeBack(c.id), /not being held/i);
	board.close();
});

test('taking back a still-interrupted session does not bounce the card straight back', async () => {
	testEnv();
	const worktree = fakeWorktree();
	const runId = 'run_stale';

	// Exactly the state a take-back re-attaches to: Orca still reports the interrupt that
	// handed the card over in the first place. Then the person types, and it works again.
	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [
			[
				worktreeRow({
					worktreeId: `repo::${worktree}`,
					path: worktree,
					agents: [agentRow('working', { interrupted: true })],
				}),
			],
			[worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('working')] })],
			[worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('done')] })],
		],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig({ doneConfirmations: 1, resultGraceMs: 0, agentPollIntervalMs: 1 }),
		orchestration: fakeOrchestration,
		lookupCard: () => card(),
	});

	const result = await execute(card(), {
		...ctxFor(runId),
		resume: {
			worktreeId: `repo::${worktree}`,
			worktreePath: worktree,
			branch: 'wt',
			sessionId: 'term_x',
			runId,
		},
	});

	// A stale interrupt must not read as a new request for the keys.
	assert.notEqual(result.status, 'HANDED_OVER', 'the card bounced straight back to its owner');
	assert.equal(result.completionReason, 'agent-done');
});

test('a fresh interrupt after a take-back does hand the card over again', async () => {
	testEnv();
	const worktree = fakeWorktree();
	const runId = 'run_fresh_int';

	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [
			// Stale interrupt, then real work, then the person presses Esc again.
			[
				worktreeRow({
					worktreeId: `repo::${worktree}`,
					path: worktree,
					agents: [agentRow('working', { interrupted: true })],
				}),
			],
			[worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('working')] })],
			[
				worktreeRow({
					worktreeId: `repo::${worktree}`,
					path: worktree,
					agents: [agentRow('working', { interrupted: true })],
				}),
			],
		],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig({ agentPollIntervalMs: 1 }),
		orchestration: fakeOrchestration,
		lookupCard: () => card(),
	});

	const result = await execute(card(), {
		...ctxFor(runId),
		resume: {
			worktreeId: `repo::${worktree}`,
			worktreePath: worktree,
			branch: 'wt',
			sessionId: 'term_x',
			runId,
		},
	});

	assert.equal(result.status, 'HANDED_OVER', 'an interrupt seen after real work is a genuine request');
});
