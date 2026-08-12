import type { Board } from './board.ts';
import type { ResumeTarget } from './executor.ts';
import type { Logger } from './logger.ts';
import type { OrcaApi, OrcaWorktreeStatus } from './orca.ts';
import type { Card, CardRun, KanbanConfig } from './types.ts';

export type RecoveryDecision = {
	card: Card;
	/**
	 * adopt   - the Orca worktree still exists with a live agent; re-attach
	 * requeue - work is gone, retry budget left; back to Ready
	 * block   - work is gone and out of retries (or policy says block)
	 */
	action: 'adopt' | 'requeue' | 'block';
	reason: string;
	openRun: CardRun | null;
	sessionId: string | null;
	/** Present only for `adopt`. */
	resume: ResumeTarget | null;
};

export type RecoveryReport = {
	inspected: number;
	adopted: RecoveryDecision[];
	requeued: RecoveryDecision[];
	blocked: RecoveryDecision[];
};

/**
 * Reconciles cards left in "In Progress" by a crash, a force-quit, or an Orca
 * restart. Nothing is ever left silently stranded: every such card is either
 * re-attached to its surviving Orca worktree or moved to a state a human can act on.
 *
 * Liveness is judged from Orca's own view (`worktree ps`), not from a pid or a
 * terminal handle we happen to remember.
 */
export async function recoverStrandedCards(deps: {
	board: Board;
	orca: OrcaApi;
	config: KanbanConfig;
	log: Logger;
}): Promise<RecoveryReport> {
	const { board, orca, config, log } = deps;
	const stranded = board.cardsInState('In Progress');
	const report: RecoveryReport = { inspected: stranded.length, adopted: [], requeued: [], blocked: [] };

	if (stranded.length === 0) {
		clearStaleSchedulerState(board);
		return report;
	}

	// One snapshot serves every card; an unreachable runtime means nothing is alive.
	let rows: OrcaWorktreeStatus[] = [];
	try {
		rows = await orca.worktreePs();
	} catch (err) {
		log.warn('could not read Orca worktree state during recovery; treating all sessions as dead', {
			error: (err as Error).message,
		});
	}

	for (const card of stranded) {
		const openRun = board.openRunsForCard(card.id)[0] ?? null;
		const sessionId = card.sessionId ?? openRun?.sessionId ?? null;

		const row = rows.find(
			(r) =>
				(card.worktreeId && r.worktreeId === card.worktreeId) ||
				(card.worktreePath && r.path === card.worktreePath),
		);

		/**
		 * Adoptable whenever Orca still tracks a non-interrupted agent for that
		 * worktree. A `done` agent counts: re-attaching lets the executor read the
		 * result file it already wrote instead of throwing that work away.
		 */
		const liveAgent =
			row?.agents.find((a) => (a.state === 'working' || a.state === 'done') && !a.interrupted) ?? null;

		if (row && liveAgent && openRun && card.worktreePath && card.worktreeId) {
			const decision: RecoveryDecision = {
				card,
				action: 'adopt',
				reason: `Orca still reports a ${liveAgent.state} ${liveAgent.agentType ?? 'agent'} in ${card.worktreePath}; re-attaching to run ${openRun.id}.`,
				openRun,
				sessionId,
				resume: {
					worktreeId: card.worktreeId,
					worktreePath: card.worktreePath,
					branch: card.branch,
					sessionId,
					runId: openRun.id,
				},
			};
			report.adopted.push(decision);
			board.recordEvent('card_recovered', {
				cardId: card.id,
				runId: openRun.id,
				sessionId,
				data: { action: 'adopt', reason: decision.reason },
			});
			log.event('card_recovered', { cardId: card.id, runId: openRun.id, sessionId, action: 'adopt' });
			continue;
		}

		if (openRun) {
			board.interruptRun(
				openRun.id,
				row
					? 'Scheduler restarted and Orca no longer reports a working agent for this worktree.'
					: 'Scheduler restarted and the card\'s Orca worktree was gone.',
			);
		}

		const retryAvailable = card.attemptCount < card.maxAttempts;
		const action: RecoveryDecision['action'] =
			config.recoveryPolicy === 'blocked' || !retryAvailable ? 'block' : 'requeue';
		const reason =
			action === 'requeue'
				? `Previous run interrupted; returning to Ready (attempt ${card.attemptCount}/${card.maxAttempts}).`
				: `Previous run interrupted and ${retryAvailable ? 'recoveryPolicy=blocked' : 'retry budget exhausted'}.`;

		board.markInterrupted(card.id, action === 'requeue' ? 'Ready' : 'Blocked', reason);

		const decision: RecoveryDecision = { card, action, reason, openRun, sessionId, resume: null };
		if (action === 'requeue') report.requeued.push(decision);
		else report.blocked.push(decision);

		board.recordEvent('card_recovered', {
			cardId: card.id,
			runId: openRun?.id ?? null,
			sessionId,
			data: { action, reason },
		});
		log.event('card_recovered', { cardId: card.id, runId: openRun?.id ?? null, sessionId, action, reason });
	}

	clearStaleSchedulerState(board);
	return report;
}

/** A scheduler row still claiming to run after a crash would freeze the UI. */
function clearStaleSchedulerState(board: Board): void {
	const status = board.schedulerStatus();
	if (status.runState === 'running' || status.runState === 'stopping') {
		board.patchSchedulerState({
			runState: 'stopped',
			currentCardId: null,
			currentRunId: null,
			currentSessionId: null,
			stopAfterCurrent: false,
		});
	}
}
