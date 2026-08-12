import type { Logger } from './logger.ts';
import type { OrcaApi } from './orca.ts';
import type { Card, CardState, KanbanConfig } from './types.ts';

/**
 * Mirrors a card onto Orca's own workspace board.
 *
 * Each card's Orca worktree *is* a card in Orca's workspace board, so writing
 * `workspaceStatus` puts it in the matching column and `comment` supplies the short
 * progress text Orca shows on the card. Verified: Orca accepts custom status ids
 * (`backlog`, `ready`, `blocked`) alongside its defaults.
 *
 * Purely additive — a mirror failure never changes a card's real state, because the
 * scheduler's SQLite board stays authoritative for priority, deps, and retries.
 */
export async function mirrorCardToOrca(args: {
	orca: OrcaApi;
	config: KanbanConfig;
	log: Logger;
	card: Card;
	state?: CardState;
	comment?: string | null;
}): Promise<void> {
	const { orca, config, log, card } = args;
	if (!config.mirrorToOrcaBoard) return;

	// Only cards that already have a worktree exist on Orca's board.
	const selector = card.worktreeId ? `id:${card.worktreeId}` : card.worktreePath ? `path:${card.worktreePath}` : null;
	if (!selector) return;

	const state = args.state ?? card.state;
	const workspaceStatus = config.orcaStatusMap[state];

	try {
		await orca.worktreeSet({
			selector,
			workspaceStatus: workspaceStatus ?? null,
			comment: args.comment ?? null,
		});
	} catch (err) {
		log.warn('failed to mirror card onto Orca board', {
			cardId: card.id,
			state,
			workspaceStatus,
			error: (err as Error).message,
		});
	}
}

/** Short progress line shown on the Orca workspace card. */
export function commentForCard(card: Card, extra?: string): string {
	const attempt = card.maxAttempts > 1 ? ` (attempt ${card.attemptCount}/${card.maxAttempts})` : '';
	return `Kanban ${card.id}: ${extra ?? card.state}${attempt}`.slice(0, 200);
}
