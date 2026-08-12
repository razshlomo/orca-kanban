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
		close: () => board.close(),
	};
}
