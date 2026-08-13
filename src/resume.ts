import type { OrcaApi } from './orca.ts';
import type { Card, KanbanConfig } from './types.ts';

/**
 * Why this exists at all.
 *
 * `closeSessionWhenDone` closes a card's Orca terminal once the card settles, which is
 * right — one dead terminal per card would bury Orca. But it made a finished card's
 * conversation look gone, so reviewing "what did the agent actually do" had no answer
 * beyond the diff.
 *
 * The conversation is not gone. OMP keys its session store by working directory, and
 * every card runs in its own worktree, so `omp --continue` inside that worktree reopens
 * that card's history and nothing else. Resuming on demand beats keeping tabs open.
 */
export type ResumeOutcome =
	| { resumed: true; sessionId: string; command: string }
	| { resumed: false; reason: 'no-worktree' | 'no-resume-command'; detail: string };

export function describeResume(outcome: ResumeOutcome): string {
	if (outcome.resumed) return `reopened in ${outcome.sessionId}`;
	return outcome.reason === 'no-worktree'
		? 'this card has never run, so there is no conversation to reopen'
		: outcome.detail;
}

/**
 * Opens a fresh Orca terminal in the card's worktree running the agent's resume command.
 *
 * The new terminal handle is stored on the card, so **Open session** works again for as
 * long as the reopened terminal lives.
 */
export async function resumeCardSession(
	card: Card,
	config: KanbanConfig,
	orca: OrcaApi,
): Promise<ResumeOutcome> {
	if (!card.worktreePath && !card.worktreeId) {
		return { resumed: false, reason: 'no-worktree', detail: 'no worktree' };
	}

	const agentName = card.agent ?? config.defaultAgent;
	const agent = config.agents[agentName];
	const command = agent?.resumeCommand;
	if (!command) {
		return {
			resumed: false,
			reason: 'no-resume-command',
			detail: `${agentName} has no resume command configured`,
		};
	}

	// Prefer the worktree id: a path can move, and Orca resolves ids without touching disk.
	const selector = card.worktreeId ? `id:${card.worktreeId}` : `path:${card.worktreePath}`;
	const terminal = await orca.terminalCreate({
		worktreeSelector: selector,
		title: `Review: ${card.title}`.slice(0, 80),
		command,
		focus: true,
	});

	return { resumed: true, sessionId: terminal.handle, command };
}
