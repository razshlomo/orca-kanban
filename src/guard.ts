import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { SchedulerStatus } from './types.ts';

/** Marker written into a card's worktree while its agent is running. */
export type CardMarker = {
	cardId: string;
	runId: string;
	title: string;
	startedAt: number;
	/** Worktree root that owns the marker. */
	worktreePath: string;
	markerPath: string;
};

export const CONTROL_DIR = '.orca-kanban';
export const MARKER_FILE = 'card.json';

/**
 * Walks up from `startDir` looking for an active card marker.
 *
 * This is how the CLI knows it is being run *by a card's own agent* rather than by
 * a human or a coordinator. It matters because the scheduler launches omp / claude
 * / codex as card workers, and those workers load the same kanban skill — without
 * this check, a worker could add or reprioritise cards mid-card and corrupt the
 * board it is being executed from.
 */
export function detectCardWorktree(startDir: string = process.cwd()): CardMarker | null {
	let dir = path.resolve(startDir);

	while (true) {
		const markerPath = path.join(dir, CONTROL_DIR, MARKER_FILE);
		if (existsSync(markerPath)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf8'));
				if (parsed && typeof parsed === 'object') {
					const raw = parsed as Record<string, unknown>;
					const cardId = typeof raw['cardId'] === 'string' ? raw['cardId'] : '';
					const runId = typeof raw['runId'] === 'string' ? raw['runId'] : '';
					if (cardId && runId) {
						return {
							cardId,
							runId,
							title: typeof raw['title'] === 'string' ? raw['title'] : '',
							startedAt: typeof raw['startedAt'] === 'number' ? raw['startedAt'] : 0,
							worktreePath: dir,
							markerPath,
						};
					}
				}
			} catch {
				// A corrupt marker is treated as absent rather than blocking everything.
			}
		}

		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export class CardWorkerGuardError extends Error {
	readonly marker: CardMarker;

	constructor(command: string, marker: CardMarker) {
		super(
			[
				`Refusing to run "${command}": this is the worktree of Kanban card ${marker.cardId}.`,
				'',
				`  card:     ${marker.cardId}${marker.title ? ` — ${marker.title}` : ''}`,
				`  run:      ${marker.runId}`,
				`  worktree: ${marker.worktreePath}`,
				'',
				'A card must work only on itself. Changing the board from inside a running card',
				'can reorder, block, or delete the very card being executed.',
				'',
				'If you are the card agent: do not modify the board. Report your outcome in the',
				'result file instead, and describe any follow-up work in your summary.',
				'',
				'If you are a human and meant to do this, re-run from outside the worktree, or',
				'pass --force.',
			].join('\n'),
		);
		this.name = 'CardWorkerGuardError';
		this.marker = marker;
	}
}

/** Commands that change the board or drive the scheduler. */
const MUTATING = new Set(['card add', 'card move', 'card rm', 'card retry', 'serve', 'run', 'recover', 'service']);

export function isMutatingCommand(command: string): boolean {
	return MUTATING.has(command);
}

/**
 * Throws when a board-mutating command is invoked from inside a running card's
 * worktree. Read-only commands (`card list`, `card show`, `status`, `doctor`) stay
 * available so a card agent can still orient itself.
 */
export function assertBoardWritable(
	command: string,
	options: { force?: boolean; cwd?: string } = {},
): CardMarker | null {
	const marker = detectCardWorktree(options.cwd);
	if (!marker) return null;
	if (!isMutatingCommand(command)) return marker;
	if (options.force) return marker;
	throw new CardWorkerGuardError(command, marker);
}

/**
 * Refuses to start a second scheduler against the same board.
 *
 * Until now the HTTP port was the only lock: `serve` cannot bind a port another board
 * already holds, but `run` binds nothing and stamps its own pid into `scheduler_state`,
 * so a stray `kanban run` beside a running board becomes a second watcher on the same
 * Orca sessions — two loops settling one card, closing one terminal, writing one row.
 * The board's claim transaction caps concurrent *cards*; it says nothing about
 * concurrent *loops*. With the board running as a background service that stops being
 * an edge case, so it is refused outright.
 */
export class SchedulerBusyError extends Error {
	readonly ownerPid: number;

	constructor(command: string, ownerPid: number, reason: string) {
		super(
			[
				`Refusing to run "${command}": another scheduler is already watching this board (${reason}).`,
				'',
				'Two schedulers on one board would both drive the same agent sessions.',
				'',
				'  see it:   kanban status',
				'  stop it:  kanban service stop   (if it runs as a service)',
				'            or Ctrl+C in the terminal running it',
				'',
				'Read-only commands and card edits still work while it runs.',
			].join('\n'),
		);
		this.name = 'SchedulerBusyError';
		this.ownerPid = ownerPid;
	}
}

/**
 * Throws when a live scheduler owns the board. `live` comes from `schedulerLiveness`,
 * which checks the owning pid and its heartbeat — a crashed owner does not block a
 * restart, which is what makes an always-on service safe to kill and respawn.
 */
export function assertSchedulerFree(
	command: string,
	status: SchedulerStatus,
	live: { alive: boolean; reason: string },
): void {
	if (!live.alive || status.ownerPid === null) return;
	// Our own row, from a previous loop in this same process.
	if (status.ownerPid === process.pid) return;
	throw new SchedulerBusyError(command, status.ownerPid, live.reason);
}
