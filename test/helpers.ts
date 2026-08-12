import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Board } from '../src/board.ts';
import { loadConfig } from '../src/config.ts';
import { silentLogger } from '../src/logger.ts';
import type { CardExecutor, ExecuteContext } from '../src/executor.ts';
import type { OrcaApi, OrcaTerminal, OrcaWorktree, OrcaWorktreeStatus } from '../src/orca.ts';
import type { OrchestrationApi } from '../src/orchestration.ts';
import type { Card, ExecutionResult, KanbanConfig } from '../src/types.ts';

/** Isolated ORCA_KANBAN_HOME + board file for one test. */
export function testEnv(): { home: string; dbPath: string } {
	const home = mkdtempSync(path.join(tmpdir(), 'orca-kanban-test-'));
	process.env['ORCA_KANBAN_HOME'] = home;
	process.env['ORCA_KANBAN_CONFIG'] = path.join(home, 'config.json');
	return { home, dbPath: path.join(home, 'board.sqlite') };
}

export function testBoard(): { board: Board; dbPath: string; home: string } {
	const { home, dbPath } = testEnv();
	return { board: new Board(dbPath), dbPath, home };
}

export function testConfig(overrides: Partial<KanbanConfig> = {}): KanbanConfig {
	return loadConfig({
		pollIntervalMs: 100,
		agentPollIntervalMs: 10,
		startupGraceMs: 0,
		doneConfirmations: 1,
		cardTimeoutMs: 5000,
		mirrorToOrcaBoard: false,
		closeSessionWhenDone: false,
		orchestration: { enabled: false, objective: 'test', runId: null },
		workerId: 'test-worker',
		...overrides,
	});
}

export { silentLogger };

/** A successful ExecutionResult for a fake executor. */
export function okResult(runId: string, over: Partial<ExecutionResult> = {}): ExecutionResult {
	const now = Date.now();
	return {
		status: 'DONE',
		completionReason: 'result-file',
		sessionId: 'term_fake',
		runId,
		branch: 'fake-branch',
		worktreePath: '/tmp/fake',
		worktreeId: 'repo::/tmp/fake',
		commitSha: null,
		summary: 'done',
		error: null,
		agentResponse: 'DONE',
		filesChanged: [],
		testsRun: [],
		lint: null,
		typecheck: null,
		concerns: null,
		startedAt: now,
		finishedAt: now,
		...over,
	};
}

/**
 * Records execution order and lets a test mutate the board mid-card — which is how
 * the "board is re-read every iteration" property is proven.
 */
export function recordingExecutor(
	executed: string[],
	during?: (card: Card, ctx: ExecuteContext) => void | Promise<void>,
	resultFor?: (card: Card, runId: string) => ExecutionResult,
): CardExecutor {
	return async (card, ctx) => {
		executed.push(card.title);
		await during?.(card, ctx);
		return resultFor?.(card, ctx.runId) ?? okResult(ctx.runId);
	};
}

export type FakeOrcaOptions = {
	/** Successive `worktree ps` snapshots; the last one repeats. */
	psFrames?: OrcaWorktreeStatus[][];
	onWorktreeCreate?: (name: string) => void;
	worktreePath?: string;
};

export type FakeOrca = OrcaApi & {
	calls: string[];
	psCallCount: number;
	statusWrites: Array<{ selector: string; workspaceStatus: string | null; comment: string | null }>;
};

export function worktreeRow(over: Partial<OrcaWorktreeStatus> = {}): OrcaWorktreeStatus {
	return {
		worktreeId: 'repo::/tmp/fake',
		path: '/tmp/fake',
		branch: 'refs/heads/fake',
		displayName: 'fake',
		workspaceStatus: 'in-progress',
		sortOrder: 1,
		comment: '',
		status: 'working',
		isArchived: false,
		liveTerminalCount: 1,
		lastOutputAt: Date.now(),
		preview: '',
		agents: [],
		...over,
	};
}

export function agentRow(state: string | null, over: Partial<OrcaWorktreeStatus['agents'][number]> = {}) {
	return {
		paneKey: 'pane',
		state,
		agentType: 'omp',
		prompt: 'card prompt',
		lastAssistantMessage: null,
		interrupted: false,
		updatedAt: Date.now(),
		...over,
	};
}

/** In-memory stand-in for the Orca CLI. */
export function fakeOrca(options: FakeOrcaOptions = {}): FakeOrca {
	const calls: string[] = [];
	const statusWrites: FakeOrca['statusWrites'] = [];
	const frames = options.psFrames ?? [[worktreeRow({ agents: [agentRow('done')] })]];
	const wtPath = options.worktreePath ?? '/tmp/fake';
	let psIndex = 0;

	const api: FakeOrca = {
		calls,
		statusWrites,
		psCallCount: 0,
		async status() {
			calls.push('status');
			return { runtimeReachable: true, appRunning: true, appVersion: '1.4.179' };
		},
		async repoList() {
			calls.push('repoList');
			return [{ id: 'repo', path: '/tmp/repo', displayName: 'repo', kind: 'git' }];
		},
		async resolveRepo(selector) {
			calls.push(`resolveRepo:${selector}`);
			return { id: 'repo', path: '/tmp/repo' };
		},
		async worktreeCreate(opts): Promise<OrcaWorktree> {
			calls.push(`worktreeCreate:${opts.name}:agent=${opts.agentId ?? 'none'}:prompt=${opts.prompt ? 'yes' : 'no'}`);
			options.onWorktreeCreate?.(opts.name);
			return {
				id: `repo::${wtPath}`,
				path: wtPath,
				branch: 'refs/heads/fake',
				agentTerminalHandle: 'term_fake',
			};
		},
		async worktreeRemove(selector) {
			calls.push(`worktreeRemove:${selector}`);
		},
		async worktreePs() {
			api.psCallCount += 1;
			calls.push('worktreePs');
			const frame = frames[Math.min(psIndex, frames.length - 1)] ?? [];
			psIndex += 1;
			return frame;
		},
		async worktreeSet(opts) {
			calls.push(`worktreeSet:${opts.selector}:${opts.workspaceStatus ?? ''}`);
			statusWrites.push({
				selector: opts.selector,
				workspaceStatus: opts.workspaceStatus ?? null,
				comment: opts.comment ?? null,
			});
		},
		async terminalCreate(opts): Promise<OrcaTerminal> {
			calls.push(`terminalCreate:${opts.command ?? ''}`);
			return { handle: 'term_fallback' };
		},
		async terminalSend(opts) {
			calls.push(`terminalSend:${opts.interrupt ? 'interrupt' : 'text'}`);
		},
		async terminalWait(opts) {
			calls.push('terminalWait');
			return { handle: opts.handle, condition: opts.condition, satisfied: true, status: 'running', exitCode: null, timedOut: false };
		},
		async terminalRead(opts) {
			calls.push('terminalRead');
			return { handle: opts.handle, status: 'running', tail: [], nextCursor: null, latestCursor: '0', oldestCursor: '0' };
		},
		async terminalShow(handle) {
			calls.push('terminalShow');
			return { handle, connected: true };
		},
		async terminalList() {
			calls.push('terminalList');
			return [{ handle: 'term_fake', connected: true }];
		},
		async terminalClose(opts) {
			calls.push(`terminalClose:${opts.handle}`);
		},
		async terminalSwitch(handle) {
			calls.push(`terminalSwitch:${handle}`);
		},
		async fileOpenChanged(opts) {
			calls.push(`fileOpenChanged:${opts.worktreeSelector}:${opts.mode ?? 'diff'}`);
		},
		async fileOpen(opts) {
			calls.push(`fileOpen:${opts.path}`);
		},
	};

	return api;
}

export const fakeOrchestration: OrchestrationApi = {
	runId: 'run_test',
	available: async () => true,
	ensureRun: async () => 'run_test',
	createTask: async () => 'task_test',
	dispatch: async () => 'ctx_test',
	updateTask: async () => {},
	checkWait: async () => ({ deliveryId: null, messages: [] }),
	ack: async () => {},
	releaseWorker: async () => true,
};
