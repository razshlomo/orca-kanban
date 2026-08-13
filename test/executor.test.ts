import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOrcaExecutor, readResultFile, statusFromText } from '../src/executor.ts';
import { agentRow, fakeOrca, fakeOrchestration, silentLogger, testConfig, testEnv, worktreeRow } from './helpers.ts';
import type { Card, ExecutionResult } from '../src/types.ts';

function card(over: Partial<Card> = {}): Card {
	const now = Date.now();
	return {
		id: 'card_test',
		title: 'Add a helper',
		description: 'Create helper.js',
		acceptanceCriteria: 'helper.js exists',
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
		attemptCount: 1,
		maxAttempts: 2,
		lastResult: null,
		lastError: null,
		lastAgentSummary: null,
		...over,
	};
}

/** A writable stand-in for the worktree Orca would have created. */
function fakeWorktree(): string {
	const dir = mkdtempSync(path.join(tmpdir(), 'orca-kanban-wt-'));
	mkdirSync(path.join(dir, '.orca-kanban'), { recursive: true });
	return dir;
}

function writeResult(worktree: string, runId: string, body: unknown): void {
	writeFileSync(path.join(worktree, '.orca-kanban', `result-${runId}.json`), JSON.stringify(body), 'utf8');
}

function ctx(runId: string, signal = new AbortController().signal) {
	const sessions: Array<Record<string, unknown>> = [];
	return {
		sessions,
		value: {
			runId,
			signal,
			log: silentLogger,
			onSession: (info: Record<string, unknown>) => sessions.push(info),
		},
	};
}

test('the card is launched agent-first: one Orca call creates worktree, session, and prompt', async () => {
	testEnv();
	const worktree = fakeWorktree();
	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [[worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('done')] })]],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig(),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	const c = ctx('run_1');
	writeResult(worktree, 'run_1', { status: 'DONE', summary: 'built it', filesChanged: ['helper.js'] });
	const result = await execute(card(), c.value);

	const createCall = orca.calls.find((call) => call.startsWith('worktreeCreate:'));
	assert.ok(createCall, 'a worktree was created');
	assert.match(createCall, /agent=omp/, 'Orca launches the agent itself');
	assert.match(createCall, /prompt=yes/, 'Orca delivers the prompt at launch');
	assert.equal(
		orca.calls.find((call) => call.startsWith('terminalCreate:')),
		undefined,
		'no separate terminal is opened — that is the documented anti-pattern',
	);

	assert.equal(result.status, 'DONE');
	assert.equal(result.sessionId, 'term_fake');
	assert.equal(result.worktreeId, `repo::${worktree}`);
	assert.equal(result.branch, 'fake');
	assert.deepEqual(result.filesChanged, ['helper.js']);
	assert.equal(c.sessions.length, 1, 'the session was reported once so the board can persist it');
});

test('completion is taken from Orca native agent state, not terminal output', async () => {
	testEnv();
	const worktree = fakeWorktree();
	const row = (state: string | null) =>
		worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: state ? [agentRow(state)] : [] });

	// Frame 1: Orca has not registered the agent yet (observed live).
	// Frame 2: working. Frame 3: done + final message.
	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [
			[row(null)],
			[row('working')],
			[
				worktreeRow({
					worktreeId: `repo::${worktree}`,
					path: worktree,
					agents: [agentRow('done', { lastAssistantMessage: 'All finished.\n\nDONE' })],
				}),
			],
		],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig({ startupGraceMs: 0, doneConfirmations: 1, resultGraceMs: 40 }),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	const result = await execute(card(), ctx('run_native').value);

	assert.equal(result.completionReason, 'agent-done', 'settled on Orca reporting state=done');
	assert.ok(orca.psCallCount >= 3, `polled Orca until the agent finished, got ${orca.psCallCount} samples`);
	assert.equal(result.agentResponse, 'All finished.\n\nDONE', "Orca's lastAssistantMessage is the final response");
	assert.equal(result.status, 'DONE', 'status recovered from the final message when no result file exists');
});

test('an early "done" sample is not trusted while still inside the startup grace', async () => {
	testEnv();
	const worktree = fakeWorktree();
	const row = (state: string | null, msg?: string) =>
		worktreeRow({
			worktreeId: `repo::${worktree}`,
			path: worktree,
			agents: state ? [agentRow(state, msg === undefined ? {} : { lastAssistantMessage: msg })] : [],
		});

	// The first frame has no agent at all: a naive check would settle immediately.
	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [[row(null)], [row(null)], [row('working')], [row('done', 'NEEDS_REVIEW')]],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig({ startupGraceMs: 0, doneConfirmations: 1, resultGraceMs: 40 }),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	const result = await execute(card(), ctx('run_grace').value);

	assert.equal(result.completionReason, 'agent-done');
	assert.equal(result.status, 'NEEDS_REVIEW', 'the real outcome, not a premature settle');
	assert.ok(orca.psCallCount >= 4, 'kept polling through the frames with no agent');
});

test('doneConfirmations requires repeated done samples before settling', async () => {
	testEnv();
	const worktree = fakeWorktree();
	const done = worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('done')] });

	const orca = fakeOrca({ worktreePath: worktree, psFrames: [[done]] });
	const execute = createOrcaExecutor({
		orca,
		config: testConfig({ startupGraceMs: 0, doneConfirmations: 3 }),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	await execute(card(), ctx('run_conf').value);
	assert.ok(orca.psCallCount >= 3, `expected at least 3 confirming samples, got ${orca.psCallCount}`);
});

test('a parsed result file short-circuits the wait and wins over the tail', async () => {
	testEnv();
	const worktree = fakeWorktree();
	writeResult(worktree, 'run_file', {
		status: 'BLOCKED',
		summary: 'needs an API key',
		testsRun: ['npm test -> skipped'],
		concerns: 'blocked on secrets',
	});

	const orca = fakeOrca({
		worktreePath: worktree,
		// Still "working" — only the file says otherwise.
		psFrames: [[worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('working')] })]],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig(),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	const result = await execute(card(), ctx('run_file').value);

	assert.equal(result.completionReason, 'result-file');
	assert.equal(result.status, 'BLOCKED');
	assert.equal(result.summary, 'needs an API key');
	assert.deepEqual(result.testsRun, ['npm test -> skipped']);
	assert.match(result.concerns ?? '', /blocked on secrets/);
});

test('an interrupted agent is reported as FAILED', async () => {
	testEnv();
	const worktree = fakeWorktree();
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
		],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig(),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	const result = await execute(card(), ctx('run_int').value);
	assert.equal(result.completionReason, 'interrupted');
	assert.equal(result.status, 'FAILED');
	assert.match(result.error ?? '', /interrupted/i);
});

test('a card that never finishes hits the timeout instead of hanging', async () => {
	testEnv();
	const worktree = fakeWorktree();
	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [[worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('working')] })]],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig({ cardTimeoutMs: 40, agentPollIntervalMs: 5 }),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	const result = await execute(card(), ctx('run_timeout').value);
	assert.equal(result.status, 'TIMEOUT');
	assert.equal(result.completionReason, 'timeout');
});

test('a vanished worktree ends the card rather than polling forever', async () => {
	testEnv();
	const orca = fakeOrca({ worktreePath: fakeWorktree(), psFrames: [[]] });

	const execute = createOrcaExecutor({
		orca,
		config: testConfig(),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	const result = await execute(card(), ctx('run_gone').value);
	assert.equal(result.completionReason, 'gone');
	assert.equal(result.status, 'FAILED');
});

test('an agent that finishes with no result file and no status token FAILS explicitly', async () => {
	testEnv();
	const worktree = fakeWorktree();
	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [
			[
				worktreeRow({
					worktreeId: `repo::${worktree}`,
					path: worktree,
					agents: [agentRow('done', { lastAssistantMessage: 'I had a look around.' })],
				}),
			],
		],
	});

	const execute = createOrcaExecutor({
		orca,
		// Short grace so the genuine no-show is asserted without a real 3-minute wait.
		config: testConfig({ resultGraceMs: 40, agentPollIntervalMs: 10, doneConfirmations: 1 }),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	const result = await execute(card(), ctx('run_silent').value);
	assert.equal(result.status, 'FAILED');
	assert.match(result.error ?? '', /without writing its result file/);
});

test('a card with no repo and no default is blocked with a clear reason', async () => {
	testEnv();
	const execute = createOrcaExecutor({
		orca: fakeOrca(),
		config: testConfig({ defaultRepo: null }),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	const result = await execute(card({ repo: null }), ctx('run_norepo').value);
	assert.equal(result.status, 'BLOCKED');
	assert.match(result.error ?? '', /defaultRepo/);
});

test('the run is registered as an Orca Task + Dispatch and released on completion', async () => {
	testEnv();
	const worktree = fakeWorktree();
	writeResult(worktree, 'run_prov', { status: 'DONE' });

	const released: string[] = [];
	const orchestration = {
		...fakeOrchestration,
		releaseWorker: async (id: string) => {
			released.push(id);
			return true;
		},
	};

	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [[worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('done')] })]],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig({
			orchestration: { enabled: true, objective: 'test', runId: null },
			closeSessionWhenDone: true,
		}),
		orchestration,
		lookupCard: () => null,
	});

	const c = ctx('run_prov');
	await execute(card(), c.value);

	const session = c.sessions[0];
	assert.equal(session?.['orcaTaskId'], 'task_test', 'the Orca Task id is recorded on the card');
	assert.equal(session?.['orcaDispatchId'], 'ctx_test', 'the Orca Dispatch id is recorded on the card');
	assert.deepEqual(released, ['ctx_test'], 'cleanup goes through worker-release, not a raw terminal close');
	assert.equal(
		orca.calls.find((call) => call.startsWith('terminalClose:')),
		undefined,
		'a released worker is not also closed by hand',
	);
});

test('a dispatch that cannot be released still gets its terminal closed', async () => {
	// Regression: `worker-release` returns dispatch_not_found for a low-level
	// `dispatch`, which previously left the agent terminal open forever.
	testEnv();
	const worktree = fakeWorktree();
	writeResult(worktree, 'run_leak', { status: 'DONE' });

	const orchestration = { ...fakeOrchestration, releaseWorker: async () => false };
	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [[worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('done')] })]],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig({
			closeSessionWhenDone: true,
			orchestration: { enabled: true, objective: 'test', runId: null },
		}),
		orchestration,
		lookupCard: () => null,
	});

	await execute(card(), ctx('run_leak').value);

	assert.ok(
		orca.calls.some((call) => call.startsWith('terminalClose:')),
		'the session must be closed when Orca will not release the worker',
	);
});

test('stopping a card interrupts its Orca session', async () => {
	testEnv();
	const worktree = fakeWorktree();
	const controller = new AbortController();
	controller.abort();

	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [[worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('working')] })]],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig({ closeSessionWhenDone: true, orchestration: { enabled: false, objective: '', runId: null } }),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	const result = await execute(card(), ctx('run_stop', controller.signal).value);

	assert.equal(result.completionReason, 'stopped');
	assert.ok(orca.calls.includes('terminalSend:interrupt'), 'the live agent was interrupted');
	assert.ok(orca.calls.some((c) => c.startsWith('terminalClose:')), 'the session was closed');
});

test('readResultFile ignores a half-written file', async (t) => {
	testEnv();
	const worktree = fakeWorktree();
	const file = path.join(worktree, '.orca-kanban', 'partial.json');

	await t.test('truncated JSON is not accepted', () => {
		writeFileSync(file, '{"status": "DO', 'utf8');
		assert.equal(readResultFile(file), null);
	});

	await t.test('an unknown status is not accepted', () => {
		writeFileSync(file, JSON.stringify({ status: 'MAYBE' }), 'utf8');
		assert.equal(readResultFile(file), null);
	});

	await t.test('a valid file parses and normalises the status', () => {
		writeFileSync(file, JSON.stringify({ status: 'done', summary: 'ok' }), 'utf8');
		assert.equal(readResultFile(file)?.status, 'DONE');
	});

	await t.test('a missing file is simply absent', () => {
		assert.equal(readResultFile(path.join(worktree, 'nope.json')), null);
	});
});

test('statusFromText finds a bare status token in the final message', () => {
	assert.equal(statusFromText('work done\n\nDONE'), 'DONE');
	assert.equal(statusFromText('- **BLOCKED**'), 'BLOCKED');
	assert.equal(statusFromText('NEEDS_REVIEW\n'), 'NEEDS_REVIEW');
	assert.equal(statusFromText('I am done with everything'), null, 'prose must not be mistaken for a status');
	assert.equal(statusFromText(null), null);
});

test('a second attempt retires the worktree the first attempt left behind', async () => {
	testEnv();
	const worktree = fakeWorktree();
	writeResult(worktree, 'run_super', { status: 'DONE' });

	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [[worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('done')] })]],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig({ mirrorToOrcaBoard: true }),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	// The card still carries the worktree of its previous, rejected attempt.
	await execute(card({ worktreeId: 'repo::/tmp/first-attempt', attemptCount: 2 }), ctx('run_super').value);

	assert.equal(
		orca.columns["id:repo::/tmp/first-attempt"],
		"superseded",
		"the abandoned worktree must leave In Progress; an empty status would not move it",
	);
	assert.match(
		orca.statusWrites.find((w) => w.selector === "id:repo::/tmp/first-attempt")?.comment ?? "",
		/superseded by attempt 2/,
	);
});

test('a result file that lands after Orca says done is still honoured', async () => {
	testEnv();
	const worktree = fakeWorktree();

	// Orca insists the agent is done from the very first sample, but the file only
	// appears later — exactly the sequence that failed a finished card in the wild.
	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [[worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('done')] })]],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig({ agentPollIntervalMs: 10, doneConfirmations: 1, startupGraceMs: 0, resultGraceMs: 5000 }),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	const pending = execute(card(), ctx('run_late').value);
	// Land the file well after the old code would have given up (2 polls ≈ 20ms).
	setTimeout(() => writeResult(worktree, 'run_late', { status: 'DONE', summary: 'slow but finished' }), 120);

	const result = await pending;
	assert.equal(result.status, 'DONE', 'the finished work must not be thrown away');
	assert.equal(result.completionReason, 'result-file');
	assert.equal(result.summary, 'slow but finished');
});

test('an agent that really never reports is failed once the grace expires', async () => {
	testEnv();
	const worktree = fakeWorktree();
	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [[worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow('done')] })]],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig({ agentPollIntervalMs: 10, doneConfirmations: 1, startupGraceMs: 0, resultGraceMs: 60 }),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	const result = await execute(card(), ctx('run_never').value);
	assert.equal(result.status, 'FAILED', 'a genuine no-show still fails');
	assert.equal(result.completionReason, 'agent-done');
	assert.match(result.error ?? '', /without writing its result file/);
});

test('an agent that goes back to working resets the countdown', async () => {
	testEnv();
	const worktree = fakeWorktree();
	const row = (state: 'done' | 'working') =>
		worktreeRow({ worktreeId: `repo::${worktree}`, path: worktree, agents: [agentRow(state)] });

	// done, done, then working again: the grace must restart, not expire.
	const orca = fakeOrca({
		worktreePath: worktree,
		psFrames: [[row('done')], [row('done')], [row('working')], [row('working')], [row('done')]],
	});

	const execute = createOrcaExecutor({
		orca,
		config: testConfig({ agentPollIntervalMs: 10, doneConfirmations: 1, startupGraceMs: 0, resultGraceMs: 45 }),
		orchestration: fakeOrchestration,
		lookupCard: () => null,
	});

	const pending = execute(card(), ctx('run_resume').value);
	setTimeout(() => writeResult(worktree, 'run_resume', { status: 'DONE', summary: 'resumed then finished' }), 90);

	const result = await pending;
	assert.equal(result.completionReason, 'result-file', 'the working sample bought it more time');
	assert.equal(result.summary, 'resumed then finished');
});
