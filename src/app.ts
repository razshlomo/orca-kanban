import { Board } from './board.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { createOrcaExecutor } from './executor.ts';
import { createLogger, type Logger } from './logger.ts';
import { commentForCard, mirrorCardToOrca } from './mirror.ts';
import { OrcaCli, type OrcaApi } from './orca.ts';
import { disabledOrchestration, OrcaOrchestration, type OrchestrationApi } from './orchestration.ts';
import { recoverStrandedCards, type RecoveryReport } from './recovery.ts';
import { Scheduler } from './scheduler.ts';
import type { Card, CardState, KanbanConfig } from './types.ts';

export type App = {
	board: Board;
	config: KanbanConfig;
	orca: OrcaApi;
	orchestration: OrchestrationApi;
	scheduler: Scheduler;
	log: Logger;
	/**
	 * Reflects a card's current state onto its Orca worktree. Manual moves from the
	 * CLI and the UI go through here, so Orca's board never drifts from SQLite.
	 */
	mirrorCard: (card: Card, comment?: string) => Promise<void>;
	recover: () => Promise<RecoveryReport>;
	/**
	 * Takes the card's live session by hand: marks it, then interrupts the agent so it
	 * stops mid-turn. The mark is written first, so the watch loop cannot settle the
	 * card in the gap and close the terminal being claimed.
	 */
	takeOver: (id: string) => Promise<Card>;
	close: () => void;
};

/**
 * Wires the whole system together: SQLite board, Orca CLI client, orchestration
 * provenance, the card executor, and the scheduler.
 *
 * Everything is injectable so tests can swap Orca for a fake.
 */
export function createApp(
	options: {
		config?: Partial<KanbanConfig>;
		dbPath?: string;
		orca?: OrcaApi;
		log?: Logger;
		orchestration?: OrchestrationApi;
	} = {},
): App {
	const config = loadConfig(options.config ?? {});
	const log = options.log ?? createLogger();
	const board = new Board(options.dbPath ? openDb(options.dbPath) : openDb());
	const orca = options.orca ?? new OrcaCli();

	const orchestration =
		options.orchestration ??
		(config.orchestration.enabled
			? new OrcaOrchestration({ log, runId: config.orchestration.runId })
			: disabledOrchestration);

	const executor = createOrcaExecutor({
		orca,
		config,
		orchestration,
		lookupCard: (id) => board.getCard(id),
		lookupBackstory: (id) => board.backstoryFor(id),
	});

	const mirror = async (card: Card, state: CardState, comment?: string): Promise<void> => {
		await mirrorCardToOrca({ orca, config, log, card, state, comment: commentForCard(card, comment) });
	};

	const scheduler = new Scheduler({
		board,
		config,
		executor,
		log,
		mirror,
	});

	return {
		board,
		config,
		orca,
		orchestration,
		scheduler,
		log,
		mirrorCard: (card, comment) => mirror(card, card.state, comment),
		recover: async () => {
			const report = await recoverStrandedCards({ board, orca, config, log });
			// Re-attach anything still alive so its work is not thrown away.
			for (const decision of report.adopted) {
				if (!decision.openRun || !decision.resume) continue;
				void scheduler.adoptCard(decision.card, decision.openRun, decision.resume);
			}
			return report;
		},
		takeOver: async (id) => {
			const card = board.handToHuman(id, 'Session taken over by hand from the board.');
			if (!card) throw new Error(`no such card ${id}`);

			// Best-effort: the mark is what stops the board, so a terminal that will not
			// take an interrupt still leaves the card yours rather than half-claimed.
			if (card.sessionId) {
				try {
					await orca.terminalSend({ handle: card.sessionId, interrupt: true });
				} catch (err) {
					log.warn('could not interrupt the agent; the card is yours but its turn may still be running', {
						cardId: id,
						sessionId: card.sessionId,
						error: (err as Error).message,
					});
				}
			}
			return card;
		},
		close: () => board.close(),
	};
}
