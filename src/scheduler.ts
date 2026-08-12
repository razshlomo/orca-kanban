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

/** A card this process is executing right now. */
type InFlight = {
	card: Card;
	runId: string;
	sessionId: string | null;
	abort: AbortController;
	settled: Promise<IterationOutcome>;
};

/**
 * Card scheduler.
 *
 * The single hard rule: every pick re-reads the board from SQLite. There is no
 * queue, no snapshot, and no precomputed plan — so cards added, removed,
 * reprioritised, or blocked while other cards run all take effect on the very next
 * selection.
 *
 * Concurrency has two halves. This loop fills up to `maxConcurrent` slots, and the
 * board enforces the same ceiling inside the claim transaction — so the limit holds
 * even when several schedulers, a UI and a one-shot CLI all race for the last slot.
 */
export class Scheduler extends EventEmitter {
	private readonly board: Board;
	private readonly config: KanbanConfig;
	private readonly executor: CardExecutor;
	private readonly log: Logger;
	private readonly mirror: (card: Card, state: CardState, comment?: string) => Promise<void>;

	private running = false;
	private stopAfterCurrentFlag = false;
	private loopPromise: Promise<void> | null = null;
	private wake: (() => void) | null = null;
	private readonly inFlight = new Map<string, InFlight>();

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
		return this.inFlight.size > 0;
	}

	/** Cards this process is executing right now. */
	get inFlightCards(): InFlight[] {
		return [...this.inFlight.values()];
	}

	/** Free slots left to this process, before the board's own ceiling is consulted. */
	private get freeSlots(): number {
		return Math.max(0, this.config.maxConcurrent - this.inFlight.size);
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

	/**
	 * Aborts an in-flight card immediately (its Orca session is interrupted).
	 * Without a card id, aborts every card this scheduler is running.
	 */
	stopCurrentCard(cardId?: string): boolean {
		const targets = cardId ? [this.inFlight.get(cardId)].filter(Boolean) : [...this.inFlight.values()];
		if (targets.length === 0) return false;

		for (const target of targets as InFlight[]) target.abort.abort();
		this.wakeUp();
		return true;
	}

	/** Stops the loop entirely and waits for every in-flight card to settle. */
	async stop(options: { abortCurrent?: boolean } = {}): Promise<void> {
		this.running = false;
		if (options.abortCurrent) for (const flight of this.inFlight.values()) flight.abort.abort();
		this.wakeUp();
		await this.loopPromise?.catch(() => {});
		this.loopPromise = null;
		await Promise.allSettled([...this.inFlight.values()].map((f) => f.settled));
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
				await this.waitForWork();
				continue;
			}

			// Fill every free slot. Each claim is its own fresh board read, so a card
			// added while the previous one was starting is still seen on this pass.
			let started = 0;
			while (this.running && !this.stopAfterCurrentFlag && this.freeSlots > 0) {
				const flight = this.claimAndStart();
				if (!flight) break;
				started += 1;
			}

			if (this.stopAfterCurrentFlag && this.inFlight.size === 0) {
				this.stopAfterCurrentFlag = false;
				this.board.patchSchedulerState({ autoRun: false, stopAfterCurrent: false, runState: 'paused' });
				this.emitEvent('scheduler_idle', { reason: 'stop_after_current' });
				continue;
			}

			if (this.inFlight.size > 0) {
				// Wait for whichever card finishes first, so its slot is refilled at once
				// rather than after the whole batch drains.
				await Promise.race([
					Promise.allSettled([...this.inFlight.values()].map((f) => f.settled)).then(() => undefined),
					...[...this.inFlight.values()].map((f) => f.settled.then(() => undefined)),
				]);
				continue;
			}

			if (started === 0) {
				this.board.patchSchedulerState({ runState: 'idle' });
				this.emitEvent('scheduler_idle', { reason: 'no_eligible_cards' });
				this.emit('idle');
				await this.waitForWork();
			}
		}

		this.board.patchSchedulerState({ runState: 'stopped' });
	}

	/**
	 * Claims the next eligible card and starts it WITHOUT awaiting, so several cards
	 * can be in flight at once. Returns null when nothing is runnable or the board
	 * refused the claim — which includes the concurrency ceiling being full.
	 */
	private claimAndStart(): InFlight | null {
		// FRESH READ — never a cached list.
		const candidate = this.board.getNextEligibleCard();
		if (!candidate) return null;

		this.emitEvent('card_selected', {
			cardId: candidate.id,
			priority: candidate.priority,
			order: candidate.order,
			title: candidate.title,
		});

		const card = this.claim(candidate);
		if (!card) return null;

		const run = this.board.startRun(card.id, null);
		const abort = new AbortController();
		const flight: InFlight = {
			card,
			runId: run.id,
			sessionId: null,
			abort,
			// Assigned below; the map entry must exist before the work can complete.
			settled: Promise.resolve(null),
		};

		this.inFlight.set(card.id, flight);
		flight.settled = this.runInSlot(flight, run, {});
		return flight;
	}

	/** Runs one card to completion and frees its slot, whatever the outcome. */
	private async runInSlot(
		flight: InFlight,
		run: CardRun,
		options: { resume?: ResumeTarget },
	): Promise<IterationOutcome> {
		try {
			await this.mirror(
				flight.card,
				'In Progress',
				`running (attempt ${flight.card.attemptCount}/${flight.card.maxAttempts})`,
			);
			return await this.executeAndPersist(flight, run, options);
		} finally {
			this.inFlight.delete(flight.card.id);
			this.publishInFlight();
			this.wakeUp();
		}
	}

	/** Atomic Ready -> In Progress, with the board's ceiling applied. */
	private claim(candidate: Card): Card | null {
		const card = this.board.claimCard(candidate.id, this.config.workerId, {
			maxConcurrent: this.config.maxConcurrent,
		});

		if (!card) {
			this.log.warn('claim refused, re-reading board', {
				cardId: candidate.id,
				inFlight: this.board.inFlightCount(),
				maxConcurrent: this.config.maxConcurrent,
			});
			return null;
		}

		this.emitEvent('card_claimed', {
			cardId: card.id,
			claimedBy: card.claimedBy,
			attempt: card.attemptCount,
			maxAttempts: card.maxAttempts,
			slot: `${this.inFlight.size + 1}/${this.config.maxConcurrent}`,
		});
		return card;
	}

	/**
	 * One full cycle, awaited to completion: fresh read → claim → execute → persist.
	 * Returns null when the board currently has nothing runnable.
	 *
	 * The CLI's one-shot mode and the tests use this; the loop uses `claimAndStart`
	 * so it can hold several cards at once.
	 */
	async runOnce(): Promise<IterationOutcome> {
		const flight = this.claimAndStart();
		if (!flight) return null;
		return flight.settled;
	}

	/**
	 * Re-attaches to a card whose Orca worktree and agent survived a restart.
	 * The card is already claimed and In Progress, so it keeps its original run — and
	 * it occupies one of this scheduler's slots like any other card.
	 */
	async adoptCard(card: Card, run: CardRun, resume: ResumeTarget): Promise<IterationOutcome> {
		this.emitEvent('card_recovered', { cardId: card.id, runId: run.id, sessionId: resume.sessionId, action: 'adopt' });

		const flight: InFlight = {
			card,
			runId: run.id,
			sessionId: resume.sessionId,
			abort: new AbortController(),
			settled: Promise.resolve(null),
		};
		this.inFlight.set(card.id, flight);
		flight.settled = this.runInSlot(flight, run, { resume });
		return flight.settled;
	}

	/**
	 * Shared tail of a card execution: run the agent, persist the outcome, emit the
	 * lifecycle events, and mirror the resulting state onto Orca's board.
	 */
	private async executeAndPersist(
		flight: InFlight,
		run: CardRun,
		options: { resume?: ResumeTarget },
	): Promise<IterationOutcome> {
		const card = flight.card;
		this.publishInFlight();
		this.emit('card_started', { card, runId: run.id });

		let result: ExecutionResult;
		try {
			result = await this.executor(card, {
				runId: run.id,
				signal: flight.abort.signal,
				log: this.log,
				resume: options.resume,
				onSession: (info) => {
					flight.sessionId = info.sessionId;
					this.board.updateRunSession(run.id, info.sessionId);
					this.board.attachSession(card.id, info);
					this.publishInFlight();
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
			lastCardFinishedAt: Date.now(),
			cardsExecuted: status.cardsExecuted + 1,
		});

		this.emit('card_finished', { card: persisted, result });
		return { card: persisted, result };
	}
	/**
	 * Mirrors this process's slots into the scheduler row so the UI and other
	 * processes can see every card in flight, not just the first one.
	 *
	 * `currentCardId` keeps reporting the oldest in-flight card, so a single-slot
	 * setup and every existing reader behave exactly as before.
	 */
	private publishInFlight(): void {
		const flights = [...this.inFlight.values()];
		const oldest = flights[0];

		this.board.patchSchedulerState({
			runState: flights.length > 0 ? 'running' : 'idle',
			currentCardId: oldest?.card.id ?? null,
			currentRunId: oldest?.runId ?? null,
			currentSessionId: oldest?.sessionId ?? null,
			inFlight: flights.map((f) => ({ cardId: f.card.id, runId: f.runId, sessionId: f.sessionId })),
		});
	}

	/**
	 * Sleeps until the board changes, a deferred card comes due, the poll interval
	 * elapses, or a control wakes us. Never a busy loop.
	 */
	private waitForWork(): Promise<void> {
		const dueAt = this.board.nextWakeAt();
		const untilDue = dueAt === null ? Number.POSITIVE_INFINITY : Math.max(0, dueAt - Date.now());
		return this.waitForBoardChangeOrPoll(Math.min(this.config.pollIntervalMs, untilDue));
	}

	/**
	 * Sleeps until the board changes, `withinMs` elapses, or a control wakes us.
	 * Never a busy loop.
	 */
	private waitForBoardChangeOrPoll(withinMs = this.config.pollIntervalMs): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		let settled = false;

		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			this.wake = null;
			resolve();
		};

		const timer = setTimeout(finish, withinMs);
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
