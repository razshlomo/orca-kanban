import { EventEmitter } from 'node:events';
import type { Board } from './board.ts';
import type { CardExecutor, ResumeTarget } from './executor.ts';
import type { Logger } from './logger.ts';
import type { BoardEvent, Card, CardRun, CardState, ExecutionResult, KanbanConfig, SchedulerStatus } from './types.ts';

export type SchedulerDeps = {
	board: Board;
	config: KanbanConfig;
	executor: CardExecutor;
	log: Logger;
	/**
	 * Optional hook that reflects a card onto Orca's own workspace board. Injected
	 * rather than imported so the scheduler stays testable without Orca running.
	 */
	mirror?: (card: Card, state: CardState, comment?: string) => Promise<void>;
};

export type IterationOutcome = {
	card: Card;
	result: ExecutionResult;
} | null;

/**
 * Sequential card scheduler.
 *
 * The single hard rule: every iteration re-reads the board from SQLite and picks
 * again. There is no queue, no snapshot, and no precomputed plan — so cards added,
 * removed, reprioritised, or blocked while a card is running all take effect on
 * the very next selection.
 */
export class Scheduler extends EventEmitter {
	private readonly board: Board;
	private readonly config: KanbanConfig;
	private readonly executor: CardExecutor;
	private readonly log: Logger;
	private readonly mirror: (card: Card, state: CardState, comment?: string) => Promise<void>;

	private running = false;
	private stopAfterCurrentFlag = false;
	private currentAbort: AbortController | null = null;
	private loopPromise: Promise<void> | null = null;
	private wake: (() => void) | null = null;
	private busy = false;

	constructor(deps: SchedulerDeps) {
		super();
		this.board = deps.board;
		this.config = deps.config;
		this.executor = deps.executor;
		this.log = deps.log;
		this.mirror = deps.mirror ?? (async () => {});

		// A board mutation from this process wakes an idle loop immediately;
		// cross-process edits are picked up by the poll fallback.
		this.board.on('board_changed', () => this.wakeUp());
	}

	// -------------------------------------------------------------- controls

	get isRunning(): boolean {
		return this.running;
	}

	get isBusy(): boolean {
		return this.busy;
	}

	status(): SchedulerStatus {
		return this.board.schedulerStatus();
	}

	/** Starts the loop. Idempotent. */
	start(options: { autoRun?: boolean } = {}): void {
		if (options.autoRun !== undefined) {
			this.board.patchSchedulerState({ autoRun: options.autoRun });
		}
		if (this.running) {
			this.wakeUp();
			return;
		}

		this.running = true;
		this.stopAfterCurrentFlag = false;
		this.board.patchSchedulerState({
			runState: 'idle',
			startedAt: Date.now(),
			stopAfterCurrent: false,
			ownerPid: process.pid,
			heartbeatAt: Date.now(),
		});
		this.loopPromise = this.loop();
	}

	/** Enables/disables automatic pickup without tearing the loop down. */
	setAutoRun(enabled: boolean): void {
		this.board.patchSchedulerState({ autoRun: enabled });
		this.emitEvent(enabled ? 'scheduler_state' : 'scheduler_idle', { autoRun: enabled });
		this.wakeUp();
	}

	/** Finish the running card, then stop picking up new ones. */
	stopAfterCurrent(): void {
		this.stopAfterCurrentFlag = true;
		this.board.patchSchedulerState({ stopAfterCurrent: true });
		this.wakeUp();
	}

	/** Aborts the in-flight card immediately (its Orca session is interrupted). */
	stopCurrentCard(): boolean {
		if (!this.currentAbort) return false;
		this.currentAbort.abort();
		this.wakeUp();
		return true;
	}

	/** Stops the loop entirely and waits for the in-flight card to settle. */
	async stop(options: { abortCurrent?: boolean } = {}): Promise<void> {
		this.running = false;
		if (options.abortCurrent) this.currentAbort?.abort();
		this.wakeUp();
		await this.loopPromise?.catch(() => {});
		this.loopPromise = null;
		this.board.patchSchedulerState({ runState: 'stopped', currentCardId: null, currentRunId: null, currentSessionId: null });
	}

	private wakeUp(): void {
		this.wake?.();
	}

	// ------------------------------------------------------------------ loop

	private async loop(): Promise<void> {
		while (this.running) {
			this.board.patchSchedulerState({ heartbeatAt: Date.now() });

			if (!this.board.schedulerStatus().autoRun) {
				this.board.patchSchedulerState({ runState: 'paused' });
				await this.waitForBoardChangeOrPoll();
				continue;
			}

			// ---- fresh board read happens inside runOnce, every single iteration.
			const outcome = await this.runOnce();

			if (this.stopAfterCurrentFlag) {
				this.stopAfterCurrentFlag = false;
				this.board.patchSchedulerState({ autoRun: false, stopAfterCurrent: false, runState: 'paused' });
				this.emitEvent('scheduler_idle', { reason: 'stop_after_current' });
				continue;
			}

			if (!outcome) {
				this.board.patchSchedulerState({ runState: 'idle' });
				this.emitEvent('scheduler_idle', { reason: 'no_eligible_cards' });
				this.emit('idle');
				await this.waitForBoardChangeOrPoll();
			}
		}

		this.board.patchSchedulerState({ runState: 'stopped' });
	}

	/**
	 * One full cycle: fresh read → atomic claim → execute → persist.
	 * Returns null when the board currently has nothing runnable.
	 *
	 * Safe to call directly (the CLI's one-shot mode and the tests both do).
	 */
	async runOnce(): Promise<IterationOutcome> {
		// FRESH READ — never a cached list.
		const candidate = this.board.getNextEligibleCard();
		if (!candidate) return null;

		this.emitEvent('card_selected', {
			cardId: candidate.id,
			priority: candidate.priority,
			order: candidate.order,
			title: candidate.title,
		});

		// Atomic Ready -> In Progress. Losing the race simply means re-reading.
		const card = this.board.claimCard(candidate.id, this.config.workerId);
		if (!card) {
			this.log.warn('claim lost, re-reading board', { cardId: candidate.id });
			return null;
		}

		this.emitEvent('card_claimed', {
			cardId: card.id,
			claimedBy: card.claimedBy,
			attempt: card.attemptCount,
			maxAttempts: card.maxAttempts,
		});

		await this.mirror(card, 'In Progress', `running (attempt ${card.attemptCount}/${card.maxAttempts})`);
		return this.executeAndPersist(card, {});
	}

	/**
	 * Re-attaches to a card whose Orca worktree and agent survived a restart.
	 * The card is already claimed and In Progress, so it keeps its original run.
	 */
	async adoptCard(card: Card, run: CardRun, resume: ResumeTarget): Promise<IterationOutcome> {
		this.emitEvent('card_recovered', { cardId: card.id, runId: run.id, sessionId: resume.sessionId, action: 'adopt' });
		return this.executeAndPersist(card, { run, resume });
	}

	/**
	 * Shared tail of a card execution: run the agent, persist the outcome, emit the
	 * lifecycle events, and mirror the resulting state onto Orca's board.
	 */
	private async executeAndPersist(
		card: Card,
		options: { run?: CardRun; resume?: ResumeTarget },
	): Promise<IterationOutcome> {
		const run = options.run ?? this.board.startRun(card.id, null);
		const abort = new AbortController();
		this.currentAbort = abort;
		this.busy = true;

		this.board.patchSchedulerState({
			runState: 'running',
			currentCardId: card.id,
			currentRunId: run.id,
			currentSessionId: options.resume?.sessionId ?? null,
		});
		this.emit('card_started', { card, runId: run.id });

		let result: ExecutionResult;
		try {
			result = await this.executor(card, {
				runId: run.id,
				signal: abort.signal,
				log: this.log,
				resume: options.resume,
				onSession: (info) => {
					this.board.updateRunSession(run.id, info.sessionId);
					this.board.patchSchedulerState({ currentSessionId: info.sessionId });
					this.board.attachSession(card.id, info);
					this.emitEvent('session_started', { cardId: card.id, runId: run.id, ...info });
				},
			});
		} catch (err) {
			result = {
				status: 'FAILED',
				completionReason: 'gone',
				sessionId: null,
				runId: run.id,
				branch: null,
				worktreePath: null,
				worktreeId: null,
				commitSha: null,
				summary: null,
				error: `Executor threw: ${(err as Error).message}`,
				agentResponse: null,
				filesChanged: [],
				testsRun: [],
				lint: null,
				typecheck: null,
				concerns: null,
				startedAt: run.startedAt,
				finishedAt: Date.now(),
			};
		} finally {
			this.currentAbort = null;
			this.busy = false;
		}

		const persisted = this.board.persistResult(card, result, { successState: this.config.successState });

		if (result.status === 'DONE' || result.status === 'NEEDS_REVIEW') {
			this.emitEvent('card_completed', {
				cardId: card.id,
				runId: run.id,
				sessionId: result.sessionId,
				status: result.status,
				state: persisted.state,
				commitSha: result.commitSha,
				completionReason: result.completionReason,
			});
		} else if (result.status === 'BLOCKED') {
			this.emitEvent('card_blocked', {
				cardId: card.id,
				runId: run.id,
				sessionId: result.sessionId,
				error: result.error,
			});
		} else {
			this.emitEvent('card_failed', {
				cardId: card.id,
				runId: run.id,
				sessionId: result.sessionId,
				status: result.status,
				error: result.error,
			});
			if (persisted.state === 'Ready') {
				this.emitEvent('retry_scheduled', {
					cardId: card.id,
					attempt: persisted.attemptCount,
					maxAttempts: persisted.maxAttempts,
				});
			}
		}

		await this.mirror(persisted, persisted.state, result.summary ?? result.error ?? undefined);

		const status = this.board.schedulerStatus();
		this.board.patchSchedulerState({
			runState: 'idle',
			currentCardId: null,
			currentRunId: null,
			currentSessionId: null,
			lastCardFinishedAt: Date.now(),
			cardsExecuted: status.cardsExecuted + 1,
		});

		this.emit('card_finished', { card: persisted, result });
		return { card: persisted, result };
	}

	/**
	 * Sleeps until the board changes, the poll interval elapses, or a control
	 * wakes us. Never a busy loop.
	 */
	private waitForBoardChangeOrPoll(): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		let settled = false;

		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			this.wake = null;
			resolve();
		};

		const timer = setTimeout(finish, this.config.pollIntervalMs);
		if (typeof timer.unref === 'function') timer.unref();
		this.wake = finish;

		return promise;
	}

	private emitEvent(event: BoardEvent, fields: Record<string, unknown> = {}): void {
		const { cardId, runId, sessionId, ...rest } = fields as {
			cardId?: string;
			runId?: string;
			sessionId?: string;
		} & Record<string, unknown>;

		this.log.event(event, { cardId, runId, sessionId, ...rest });
		this.board.recordEvent(event, { cardId, runId, sessionId, data: rest });
		this.emit('event', { event, cardId, runId, sessionId, ...rest });
	}
}
