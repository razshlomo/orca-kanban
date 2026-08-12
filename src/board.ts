import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { immediateTransaction, openDb, type Db, type SqlValue } from './db.ts';
import type {
	AgentStatus,
	Card,
	CardBackstory,
	CardComment,
	CardInput,
	CardRun,
	CardState,
	ExecutionResult,
	RunStatus,
	SchedulerStatus,
} from './types.ts';

type Row = Record<string, unknown>;

function rowToComment(row: Row): CardComment {
	return {
		id: String(row['id']),
		cardId: String(row['card_id']),
		kind: String(row['kind']) as CardComment['kind'],
		author: String(row['author']),
		body: String(row['body'] ?? ''),
		createdAt: Number(row['created_at']),
	};
}

/**
 * A refused board action: the card exists, but this move makes no sense for the state
 * it is in. Separate from "no such card" (null) so callers can answer 409 vs 404.
 */
export class BoardRuleError extends Error {
	readonly cardId: string;
	readonly state: CardState;

	constructor(message: string, cardId: string, state: CardState) {
		super(message);
		this.name = 'BoardRuleError';
		this.cardId = cardId;
		this.state = state;
	}
}

/** States a human verdict can be applied to: the card has run, or has given up. */
const REVIEWABLE: readonly CardState[] = ['Review', 'Blocked'];
/** Tolerates a missing or malformed column: an unreadable slot list is not a crash. */
function parseInFlight(raw: unknown): SchedulerStatus['inFlight'] {
	if (typeof raw !== 'string' || raw === '') return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.map((entry) => {
			const e = entry as Record<string, unknown>;
			return {
				cardId: String(e['cardId'] ?? ''),
				runId: String(e['runId'] ?? ''),
				sessionId: e['sessionId'] === null || e['sessionId'] === undefined ? null : String(e['sessionId']),
			};
		});
	} catch {
		return [];
	}
}

function rowToCard(row: Row): Card {
	let dependencies: string[] = [];
	try {
		const parsed: unknown = JSON.parse(String(row['dependencies'] ?? '[]'));
		if (Array.isArray(parsed)) dependencies = parsed.map(String);
	} catch {
		dependencies = [];
	}

	return {
		id: String(row['id']),
		title: String(row['title']),
		description: String(row['description'] ?? ''),
		acceptanceCriteria: String(row['acceptance_criteria'] ?? ''),
		state: String(row['state']) as CardState,
		priority: Number(row['priority'] ?? 0),
		order: Number(row['board_order'] ?? 0),
		dependencies,
		repo: (row['repo'] as string | null) ?? null,
		agent: (row['agent'] as string | null) ?? null,
		createdAt: Number(row['created_at']),
		updatedAt: Number(row['updated_at']),
		notBefore: row['not_before'] === null || row['not_before'] === undefined ? null : Number(row['not_before']),
		repeatEveryMs:
			row['repeat_every_ms'] === null || row['repeat_every_ms'] === undefined ? null : Number(row['repeat_every_ms']),
		claimedAt: row['claimed_at'] === null || row['claimed_at'] === undefined ? null : Number(row['claimed_at']),
		claimedBy: (row['claimed_by'] as string | null) ?? null,
		sessionId: (row['session_id'] as string | null) ?? null,
		branch: (row['branch'] as string | null) ?? null,
		worktreePath: (row['worktree_path'] as string | null) ?? null,
		commitSha: (row['commit_sha'] as string | null) ?? null,
		worktreeId: (row['worktree_id'] as string | null) ?? null,
		orcaTaskId: (row['orca_task_id'] as string | null) ?? null,
		orcaDispatchId: (row['orca_dispatch_id'] as string | null) ?? null,
		attemptCount: Number(row['attempt_count'] ?? 0),
		maxAttempts: Number(row['max_attempts'] ?? 2),
		lastResult: (row['last_result'] as string | null) ?? null,
		lastError: (row['last_error'] as string | null) ?? null,
		lastAgentSummary: (row['last_agent_summary'] as string | null) ?? null,
	};
}

function rowToRun(row: Row): CardRun {
	return {
		id: String(row['id']),
		cardId: String(row['card_id']),
		sessionId: (row['session_id'] as string | null) ?? null,
		startedAt: Number(row['started_at']),
		finishedAt: row['finished_at'] === null || row['finished_at'] === undefined ? null : Number(row['finished_at']),
		status: String(row['status']) as RunStatus,
		commitSha: (row['commit_sha'] as string | null) ?? null,
		summary: (row['summary'] as string | null) ?? null,
		error: (row['error'] as string | null) ?? null,
		details: (row['details'] as string | null) ?? null,
	};
}

/**
 * Selects runnable cards. A card is eligible only when it is Ready, unclaimed,
 * still has retry budget, due (`not_before` in the past or unset), and every
 * declared dependency is Done.
 *
 * A dependency id that does not exist on the board is treated as unsatisfied,
 * so a typo blocks the card rather than silently letting it run.
 *
 * Takes "now" as a bound parameter so a deferred card becomes eligible on its own,
 * with no cron and no separate timer to drift out of step.
 */
const ELIGIBLE_SQL = `
	SELECT * FROM cards c
	WHERE c.state = 'Ready'
	  AND c.claimed_by IS NULL
	  AND c.attempt_count < c.max_attempts
	  AND (c.not_before IS NULL OR c.not_before <= ?)
	  AND NOT EXISTS (
	    SELECT 1 FROM json_each(c.dependencies) dep
	    WHERE NOT EXISTS (
	      SELECT 1 FROM cards d WHERE d.id = dep.value AND d.state = 'Done'
	    )
	  )
	ORDER BY c.priority DESC, c.board_order ASC, c.created_at ASC
`;

export type PersistOptions = {
	successState: 'Review' | 'Done';
};

/**
 * The board. Every public read hits SQLite directly — there is deliberately no
 * cached card list anywhere in this class, because the scheduler must observe
 * external edits (new cards, reprioritisation, blocks) between iterations.
 */
export class Board extends EventEmitter {
	readonly db: Db;

	constructor(db: Db | string = openDb()) {
		super();
		this.db = typeof db === 'string' ? openDb(db) : db;
	}

	close(): void {
		this.db.close();
	}

	// ---------------------------------------------------------------- reads

	listCards(): Card[] {
		return (this.db.prepare('SELECT * FROM cards ORDER BY board_order ASC, created_at ASC').all() as Row[]).map(
			rowToCard,
		);
	}

	getCard(id: string): Card | null {
		const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as Row | undefined;
		return row ? rowToCard(row) : null;
	}

	/** Fresh read of every currently runnable card, best candidate first. */
	eligibleCards(now = Date.now()): Card[] {
		return (this.db.prepare(ELIGIBLE_SQL).all(now) as Row[]).map(rowToCard);
	}

	/**
	 * Fresh read of the single best runnable card. Returns null when the board has
	 * nothing to do right now. This is called once per scheduler iteration and
	 * never memoised.
	 */
	getNextEligibleCard(now = Date.now()): Card | null {
		const row = this.db.prepare(`${ELIGIBLE_SQL} LIMIT 1`).get(now) as Row | undefined;
		return row ? rowToCard(row) : null;
	}

	/** How many cards are executing right now, board-wide across every worker. */
	inFlightCount(): number {
		return Number((this.db.prepare(`SELECT COUNT(*) AS n FROM cards WHERE state = 'In Progress'`).get() as Row)['n']);
	}

	/** The soonest moment a deferred card becomes runnable, or null when none wait. */
	nextWakeAt(now = Date.now()): number | null {
		const row = this.db
			.prepare(
				`SELECT MIN(not_before) AS at FROM cards
				 WHERE state = 'Ready' AND claimed_by IS NULL AND not_before IS NOT NULL AND not_before > ?`,
			)
			.get(now) as Row | undefined;
		const at = row?.['at'];
		return at === null || at === undefined ? null : Number(at);
	}

	cardsInState(state: CardState): Card[] {
		return (
			this.db.prepare('SELECT * FROM cards WHERE state = ? ORDER BY board_order ASC').all(state) as Row[]
		).map(rowToCard);
	}

	runsForCard(cardId: string, limit = 50): CardRun[] {
		return (
			this.db
				.prepare('SELECT * FROM card_runs WHERE card_id = ? ORDER BY started_at DESC LIMIT ?')
				.all(cardId, limit) as Row[]
		).map(rowToRun);
	}

	recentEvents(limit = 200): Array<Record<string, unknown>> {
		return (
			this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as Row[]
		).map((r) => ({
			id: Number(r['id']),
			ts: Number(r['ts']),
			event: String(r['event']),
			cardId: r['card_id'] ?? null,
			runId: r['run_id'] ?? null,
			sessionId: r['session_id'] ?? null,
			data: r['data'] ? JSON.parse(String(r['data'])) : null,
		}));
	}

	boardRevision(): number {
		const row = this.db.prepare('SELECT board_revision FROM scheduler_state WHERE id = 1').get() as Row | undefined;
		return Number(row?.['board_revision'] ?? 0);
	}

	// ------------------------------------------------------------- mutations

	private bumpRevision(): void {
		this.db.exec('UPDATE scheduler_state SET board_revision = board_revision + 1 WHERE id = 1');
	}

	/** Bump the revision and wake anything waiting on a board change. */
	private touched(reason: string, cardId?: string): void {
		this.bumpRevision();
		this.emit('board_changed', { reason, cardId });
	}

	createCard(input: CardInput): Card {
		const now = Date.now();
		const id = input.id ?? `card_${randomUUID().slice(0, 8)}`;

		const nextOrder =
			input.order ??
			Number(
				(this.db.prepare('SELECT COALESCE(MAX(board_order), 0) + 1 AS n FROM cards').get() as Row)['n'] ?? 1,
			);

		this.db
			.prepare(
				`INSERT INTO cards (id, title, description, acceptance_criteria, state, priority, board_order,
				 dependencies, repo, agent, created_at, updated_at, attempt_count, max_attempts,
				 not_before, repeat_every_ms)
				 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
			)
			.run(
				id,
				input.title,
				input.description ?? '',
				input.acceptanceCriteria ?? '',
				input.state ?? 'Backlog',
				input.priority ?? 0,
				nextOrder,
				JSON.stringify(input.dependencies ?? []),
				input.repo ?? null,
				input.agent ?? null,
				now,
				now,
				input.maxAttempts ?? 2,
				input.notBefore ?? null,
				input.repeatEveryMs ?? null,
			);

		this.touched('card_created', id);
		const card = this.getCard(id);
		if (!card) throw new Error(`createCard failed for ${id}`);
		return card;
	}

	updateCard(id: string, patch: Partial<CardInput> & { state?: CardState }): Card | null {
		const existing = this.getCard(id);
		if (!existing) return null;

		const columns: Record<string, SqlValue> = {};
		if (patch.title !== undefined) columns['title'] = patch.title;
		if (patch.description !== undefined) columns['description'] = patch.description;
		if (patch.acceptanceCriteria !== undefined) columns['acceptance_criteria'] = patch.acceptanceCriteria;
		if (patch.state !== undefined) columns['state'] = patch.state;
		if (patch.priority !== undefined) columns['priority'] = patch.priority;
		if (patch.order !== undefined) columns['board_order'] = patch.order;
		if (patch.dependencies !== undefined) columns['dependencies'] = JSON.stringify(patch.dependencies);
		if (patch.repo !== undefined) columns['repo'] = patch.repo;
		if (patch.agent !== undefined) columns['agent'] = patch.agent;
		if (patch.maxAttempts !== undefined) columns['max_attempts'] = patch.maxAttempts;
		if (patch.notBefore !== undefined) columns['not_before'] = patch.notBefore;
		if (patch.repeatEveryMs !== undefined) columns['repeat_every_ms'] = patch.repeatEveryMs;

		if (Object.keys(columns).length === 0) return existing;

		columns['updated_at'] = Date.now();
		const sets = Object.keys(columns)
			.map((c) => `${c} = ?`)
			.join(', ');
		this.db.prepare(`UPDATE cards SET ${sets} WHERE id = ?`).run(...Object.values(columns), id);

		this.touched('card_updated', id);
		return this.getCard(id);
	}

	/** A live agent owns this card; changing it underneath would orphan the run. */
	private refuseWhileRunning(card: Card, action: string): void {
		if (card.state !== 'In Progress') return;
		throw new BoardRuleError(
			`Cannot ${action} while it is running. Stop the card first, or move it out of In Progress.`,
			card.id,
			card.state,
		);
	}

	/** A verdict only means something once the card has produced an outcome. */
	private refuseUnlessReviewable(card: Card, action: string): void {
		if (REVIEWABLE.includes(card.state)) return;
		throw new BoardRuleError(
			`Cannot ${action} a card in ${card.state}; only ${REVIEWABLE.join(' or ')} cards carry a result to judge.`,
			card.id,
			card.state,
		);
	}

	/**
	 * The card a verdict is about to be applied to, validated but untouched.
	 *
	 * Callers that do work before the verdict — committing the card's changes — must
	 * check first, or a refused approval still mutates the repository.
	 */
	verdictTarget(id: string): Card | null {
		const card = this.getCard(id);
		if (!card) return null;
		this.refuseUnlessReviewable(card, 'approve or request changes on');
		return card;
	}

	deleteCard(id: string, options: { force?: boolean } = {}): boolean {
		const existing = this.getCard(id);
		// Deleting a running card orphans its agent and worktree; make it deliberate.
		if (existing && !options.force) this.refuseWhileRunning(existing, 'delete a card');

		const changes = Number(this.db.prepare('DELETE FROM cards WHERE id = ?').run(id).changes);
		if (changes > 0) this.touched('card_deleted', id);
		return changes > 0;
	}

	/**
	 * Explicit state move (drag/drop in the UI). Moving a card out of
	 * "In Progress" also drops the claim so it cannot stay stuck.
	 */
	moveCard(id: string, state: CardState, order?: number): Card | null {
		const existing = this.getCard(id);
		if (!existing) return null;

		const clearClaim = state !== 'In Progress';
		this.db
			.prepare(
				`UPDATE cards SET state = ?, board_order = COALESCE(?, board_order), updated_at = ?,
				 claimed_by = CASE WHEN ? THEN NULL ELSE claimed_by END,
				 claimed_at = CASE WHEN ? THEN NULL ELSE claimed_at END
				 WHERE id = ?`,
			)
			.run(state, order ?? null, Date.now(), clearClaim ? 1 : 0, clearClaim ? 1 : 0, id);

		this.touched('card_moved', id);
		return this.rearmIfRecurring(id) ?? this.getCard(id);
	}

	/**
	 * A recurring card does not stay finished: reaching Done schedules the next
	 * occurrence instead, with a fresh retry budget and the claim cleared. All of its
	 * history stays on the one card, which is the point of `repeatEveryMs`.
	 *
	 * Returns the re-armed card, or null when this card is not recurring / not Done.
	 */
	private rearmIfRecurring(id: string): Card | null {
		const card = this.getCard(id);
		if (!card || card.state !== 'Done' || !card.repeatEveryMs) return null;

		const dueAt = Date.now() + card.repeatEveryMs;
		this.db
			.prepare(
				`UPDATE cards SET state = 'Ready', not_before = ?, attempt_count = 0,
				 claimed_by = NULL, claimed_at = NULL, updated_at = ?
				 WHERE id = ?`,
			)
			.run(dueAt, Date.now(), id);

		this.touched('card_rearmed', id);
		return this.getCard(id);
	}

	/**
	 * Defers a card: it stays where it is on the board but cannot be claimed until
	 * `dueAt`. This is "look at this again later" without losing the card.
	 */
	snoozeCard(id: string, dueAt: number, options: { state?: CardState } = {}): Card | null {
		const existing = this.getCard(id);
		if (!existing) return null;
		// Deferring a running card would drop the claim under a live agent.
		this.refuseWhileRunning(existing, 'hold a card');

		// A card parked in any other column would never wake by itself, so a snooze puts
		// it in Ready and lets `not_before` hold it there until it is due.
		const state = options.state ?? 'Ready';
		this.db
			.prepare(
				`UPDATE cards SET state = ?, not_before = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ?
				 WHERE id = ?`,
			)
			.run(state, dueAt, Date.now(), id);

		this.touched('card_snoozed', id);
		return this.getCard(id);
	}

	/** Reorder a whole column in one shot (UI drag/drop). */
	reorderCards(ids: string[]): void {
		immediateTransaction(this.db, () => {
			const stmt = this.db.prepare('UPDATE cards SET board_order = ?, updated_at = ? WHERE id = ?');
			const now = Date.now();
			ids.forEach((id, index) => stmt.run(index + 1, now, id));
		});
		this.touched('cards_reordered');
	}

	/**
	 * Puts a failed/blocked card back in play: clears the claim, restores retry
	 * budget, and returns it to Ready.
	 */
	retryCard(id: string, options: { resetAttempts?: boolean } = {}): Card | null {
		const card = this.getCard(id);
		if (!card) return null;
		this.refuseWhileRunning(card, 'retry a card');

		const resetAttempts = options.resetAttempts ?? true;
		this.db
			.prepare(
				`UPDATE cards SET state = 'Ready', claimed_by = NULL, claimed_at = NULL,
				 attempt_count = CASE WHEN ? THEN 0 ELSE attempt_count END,
				 max_attempts = CASE WHEN ? THEN max_attempts ELSE MAX(max_attempts, attempt_count + 1) END,
				 last_error = NULL, updated_at = ?
				 WHERE id = ?`,
			)
			.run(resetAttempts ? 1 : 0, resetAttempts ? 1 : 0, Date.now(), id);

		this.touched('card_retry', id);
		return this.getCard(id);
	}

	// --------------------------------------------------------------- review

	/**
	 * Records a reviewer's words on a card. Append-only: an approval or rejection
	 * keeps its reason forever, and the next agent gets to read it.
	 */
	addComment(cardId: string, body: string, options: { kind?: CardComment['kind']; author?: string } = {}): CardComment | null {
		if (!this.getCard(cardId)) return null;

		const comment: CardComment = {
			id: `cmt_${randomUUID().slice(0, 8)}`,
			cardId,
			kind: options.kind ?? 'comment',
			author: options.author ?? 'human',
			body,
			createdAt: Date.now(),
		};

		this.db
			.prepare('INSERT INTO card_comments (id, card_id, kind, author, body, created_at) VALUES (?,?,?,?,?,?)')
			.run(comment.id, comment.cardId, comment.kind, comment.author, comment.body, comment.createdAt);

		this.touched('card_commented', cardId);
		return comment;
	}

	/** The whole review trail for a card, oldest first. */
	commentsForCard(cardId: string): CardComment[] {
		// rowid breaks ties in true insertion order. Sorting by `id` looked fine but is a
		// random UUID, so two comments in the same millisecond came back in random order —
		// and "the most recent CHANGES REQUESTED" would then be a coin toss.
		return this.db
			.prepare('SELECT * FROM card_comments WHERE card_id = ? ORDER BY created_at ASC, rowid ASC')
			.all(cardId)
			.map((row) => rowToComment(row as Row));
	}

	/**
	 * Accepts the work: the card lands in `state` (Done by default) with the
	 * approval recorded. The reviewer's decision is the only way out of Review.
	 */
	approveCard(id: string, options: { comment?: string; state?: CardState; author?: string } = {}): Card | null {
		const card = this.getCard(id);
		if (!card) return null;
		this.refuseUnlessReviewable(card, 'approve');

		this.addComment(id, options.comment?.trim() || 'Approved.', { kind: 'approved', author: options.author ?? 'human' });
		return this.moveCard(id, options.state ?? 'Done');
	}

	/**
	 * Sends the work back for another attempt with the reason attached, so the next
	 * agent session starts knowing what was wrong. Restores the retry budget,
	 * because a human asking for changes is not one of the card's own failures.
	 */
	rejectCard(id: string, feedback: string, options: { author?: string; state?: CardState } = {}): Card | null {
		const card = this.getCard(id);
		if (!card) return null;
		this.refuseUnlessReviewable(card, 'request changes on');

		const reason = feedback.trim();
		if (!reason) throw new Error('a rejection needs a reason — that reason is what the next agent reads');

		this.addComment(id, reason, { kind: 'rejected', author: options.author ?? 'human' });

		if (options.state && options.state !== 'Ready') return this.moveCard(id, options.state);
		return this.retryCard(id, { resetAttempts: true });
	}

	/**
	 * What a fresh agent should be told about the card's past: every comment, plus
	 * how the last attempt ended.
	 */
	backstoryFor(cardId: string): CardBackstory {
		const runs = this.runsForCard(cardId);
		const last = runs.find((r) => r.finishedAt !== null) ?? null;

		return {
			comments: this.commentsForCard(cardId),
			previousAttempt: last
				? { attempt: runs.filter((r) => r.finishedAt !== null).length, status: last.status, summary: last.summary, error: last.error }
				: null,
		};
	}

	// ---------------------------------------------------------------- claim

	/**
	 * Atomically claims one specific card. Returns null when somebody else won the
	 * race, the card left Ready, its retry budget is gone, it is not due yet, or the
	 * concurrency cap is already full.
	 *
	 * Every guard lives in the UPDATE's WHERE clause, so the winner is decided by
	 * SQLite rather than by application-level checks. That is what makes the cap hold
	 * across processes: two daemons racing for the last slot cannot both win it.
	 */
	claimCard(id: string, workerId: string, options: { maxConcurrent?: number } = {}): Card | null {
		const maxConcurrent = Math.max(1, options.maxConcurrent ?? Number.MAX_SAFE_INTEGER);

		return immediateTransaction(this.db, () => {
			const changes = Number(
				this.db
					.prepare(
						`UPDATE cards
						 SET state = 'In Progress', claimed_by = ?, claimed_at = ?, updated_at = ?,
						     attempt_count = attempt_count + 1
						 WHERE id = ?
						   AND state = 'Ready'
						   AND claimed_by IS NULL
						   AND attempt_count < max_attempts
						   AND (not_before IS NULL OR not_before <= ?)
						   AND (SELECT COUNT(*) FROM cards busy WHERE busy.state = 'In Progress') < ?
						   AND NOT EXISTS (
						     SELECT 1 FROM json_each(cards.dependencies) dep
						     WHERE NOT EXISTS (
						       SELECT 1 FROM cards d WHERE d.id = dep.value AND d.state = 'Done'
						     )
						   )`,
					)
					.run(workerId, Date.now(), Date.now(), id, Date.now(), maxConcurrent).changes,
			);

			if (changes !== 1) return null;
			this.bumpRevision();
			return this.getCard(id);
		});
	}

	/** Records the live Orca session, worktree, and orchestration ids while a card runs. */
	attachSession(
		id: string,
		meta: {
			sessionId: string | null;
			worktreeId: string | null;
			worktreePath: string | null;
			branch: string | null;
			orcaTaskId?: string | null;
			orcaDispatchId?: string | null;
		},
	): void {
		this.db
			.prepare(
				`UPDATE cards SET session_id = ?, worktree_id = ?, worktree_path = ?, branch = ?,
				 orca_task_id = COALESCE(?, orca_task_id), orca_dispatch_id = COALESCE(?, orca_dispatch_id),
				 updated_at = ? WHERE id = ?`,
			)
			.run(
				meta.sessionId,
				meta.worktreeId,
				meta.worktreePath,
				meta.branch,
				meta.orcaTaskId ?? null,
				meta.orcaDispatchId ?? null,
				Date.now(),
				id,
			);
		this.touched('session_attached', id);
	}

	/**
	 * Records the commit an approval produced, so the card points at the work rather
	 * than merely claiming to be finished.
	 */
	recordCommit(id: string, sha: string): Card | null {
		if (!this.getCard(id)) return null;
		this.db.prepare('UPDATE cards SET commit_sha = ?, updated_at = ? WHERE id = ?').run(sha, Date.now(), id);
		this.touched('card_committed', id);
		return this.getCard(id);
	}

	/**
	 * Fresh board read + atomic claim of the best candidate. Losing a race on the
	 * top candidate simply moves to the next one, so a busy board still makes
	 * progress with several workers.
	 */
	claimNext(workerId: string): Card | null {
		for (const candidate of this.eligibleCards()) {
			const claimed = this.claimCard(candidate.id, workerId);
			if (claimed) {
				this.emit('board_changed', { reason: 'card_claimed', cardId: claimed.id });
				return claimed;
			}
		}
		return null;
	}

	releaseClaim(id: string, state: CardState = 'Ready'): void {
		this.db
			.prepare('UPDATE cards SET state = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?')
			.run(state, Date.now(), id);
		this.touched('claim_released', id);
	}

	/**
	 * Moves a card out of "In Progress" after its run was interrupted, recording
	 * why so the UI can explain the state change.
	 */
	markInterrupted(id: string, state: CardState, reason: string): void {
		this.db
			.prepare(
				`UPDATE cards SET state = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ?,
				 last_result = 'INTERRUPTED', last_error = ? WHERE id = ?`,
			)
			.run(state, Date.now(), reason, id);
		this.touched('card_interrupted', id);
	}

	// ------------------------------------------------------------------ runs

	startRun(cardId: string, sessionId: string | null): CardRun {
		const id = `run_${randomUUID().slice(0, 8)}`;
		this.db
			.prepare('INSERT INTO card_runs (id, card_id, session_id, started_at, status) VALUES (?,?,?,?,?)')
			.run(id, cardId, sessionId, Date.now(), 'RUNNING');
		this.touched('run_started', cardId);
		const run = this.db.prepare('SELECT * FROM card_runs WHERE id = ?').get(id) as Row;
		return rowToRun(run);
	}

	updateRunSession(runId: string, sessionId: string | null): void {
		this.db.prepare('UPDATE card_runs SET session_id = ? WHERE id = ?').run(sessionId, runId);
	}

	finishRun(
		runId: string,
		patch: {
			status: RunStatus;
			commitSha?: string | null;
			summary?: string | null;
			error?: string | null;
			details?: unknown;
		},
	): void {
		this.db
			.prepare(
				'UPDATE card_runs SET finished_at = ?, status = ?, commit_sha = ?, summary = ?, error = ?, details = ? WHERE id = ?',
			)
			.run(
				Date.now(),
				patch.status,
				patch.commitSha ?? null,
				patch.summary ?? null,
				patch.error ?? null,
				patch.details === undefined ? null : JSON.stringify(patch.details),
				runId,
			);
	}

	/** Marks a run that never reported an outcome (worker died mid-card). */
	interruptRun(runId: string, error: string): void {
		this.db
			.prepare(
				"UPDATE card_runs SET finished_at = ?, status = 'INTERRUPTED', error = ? WHERE id = ? AND status = 'RUNNING'",
			)
			.run(Date.now(), error, runId);
	}

	openRunsForCard(cardId: string): CardRun[] {
		return (
			this.db
				.prepare("SELECT * FROM card_runs WHERE card_id = ? AND status = 'RUNNING' ORDER BY started_at DESC")
				.all(cardId) as Row[]
		).map(rowToRun);
	}

	// --------------------------------------------------------------- outcome

	/**
	 * Maps an execution result onto the next board state and writes the card +
	 * run history in one transaction.
	 *
	 *   DONE          -> configured success state (Review by default)
	 *   NEEDS_REVIEW  -> Review
	 *   BLOCKED       -> Blocked
	 *   FAILED/TIMEOUT-> Ready while retry budget remains, otherwise Blocked
	 */
	persistResult(card: Card, result: ExecutionResult, options: PersistOptions): Card {
		const fresh = this.getCard(card.id) ?? card;
		const attempts = fresh.attemptCount;
		const retryAvailable = attempts < fresh.maxAttempts;

		let nextState: CardState;
		if (result.status === 'DONE') nextState = options.successState;
		else if (result.status === 'NEEDS_REVIEW') nextState = 'Review';
		else if (result.status === 'BLOCKED') nextState = 'Blocked';
		else nextState = retryAvailable ? 'Ready' : 'Blocked';

		const updated = immediateTransaction(this.db, () => {
			this.db
				.prepare(
					`UPDATE cards SET state = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ?,
					 session_id = ?, branch = ?, worktree_path = ?, worktree_id = COALESCE(?, worktree_id),
					 commit_sha = COALESCE(?, commit_sha),
					 last_result = ?, last_error = ?, last_agent_summary = ?
					 WHERE id = ?`,
				)
				.run(
					nextState,
					Date.now(),
					result.sessionId,
					result.branch,
					result.worktreePath,
					result.worktreeId,
					result.commitSha,
					result.status,
					result.error,
					result.summary,
					card.id,
				);

			this.finishRun(result.runId, {
				status: result.status,
				commitSha: result.commitSha,
				summary: result.summary,
				error: result.error,
				details: {
					completionReason: result.completionReason,
					filesChanged: result.filesChanged,
					testsRun: result.testsRun,
					lint: result.lint,
					typecheck: result.typecheck,
					concerns: result.concerns,
					agentResponse: result.agentResponse,
					branch: result.branch,
					worktreePath: result.worktreePath,
					durationMs: result.finishedAt - result.startedAt,
				},
			});

			this.db.exec('UPDATE scheduler_state SET board_revision = board_revision + 1 WHERE id = 1');
			return this.getCard(card.id);
		});

		this.emit('board_changed', { reason: 'result_persisted', cardId: card.id });
		if (!updated) throw new Error(`persistResult lost card ${card.id}`);

		// With successState "Done" a card can finish unattended, so recurrence has to be
		// re-armed here too — not only on the human's approve/move path.
		return this.rearmIfRecurring(card.id) ?? updated;
	}

	recordEvent(
		event: string,
		fields: { cardId?: string | null; runId?: string | null; sessionId?: string | null; data?: unknown } = {},
	): void {
		this.db
			.prepare('INSERT INTO events (ts, event, card_id, run_id, session_id, data) VALUES (?,?,?,?,?,?)')
			.run(
				Date.now(),
				event,
				fields.cardId ?? null,
				fields.runId ?? null,
				fields.sessionId ?? null,
				fields.data === undefined ? null : JSON.stringify(fields.data),
			);
	}

	// ----------------------------------------------------- scheduler state

	schedulerStatus(): SchedulerStatus {
		const row = this.db.prepare('SELECT * FROM scheduler_state WHERE id = 1').get() as Row;
		return {
			runState: String(row['run_state']) as SchedulerStatus['runState'],
			autoRun: Number(row['auto_run']) === 1,
			currentCardId: (row['current_card_id'] as string | null) ?? null,
			currentRunId: (row['current_run_id'] as string | null) ?? null,
			currentSessionId: (row['current_session_id'] as string | null) ?? null,
			inFlight: parseInFlight(row['in_flight']),
			startedAt: row['started_at'] === null ? null : Number(row['started_at']),
			lastCardFinishedAt: row['last_card_finished_at'] === null ? null : Number(row['last_card_finished_at']),
			cardsExecuted: Number(row['cards_executed'] ?? 0),
			stopAfterCurrent: Number(row['stop_after_current']) === 1,
		};
	}

	patchSchedulerState(patch: {
		runState?: SchedulerStatus['runState'];
		autoRun?: boolean;
		currentCardId?: string | null;
		currentRunId?: string | null;
		currentSessionId?: string | null;
		inFlight?: SchedulerStatus['inFlight'];
		startedAt?: number | null;
		lastCardFinishedAt?: number | null;
		cardsExecuted?: number;
		stopAfterCurrent?: boolean;
		heartbeatAt?: number | null;
		ownerPid?: number | null;
	}): SchedulerStatus {
		const columns: Record<string, SqlValue> = {};
		if (patch.runState !== undefined) columns['run_state'] = patch.runState;
		if (patch.autoRun !== undefined) columns['auto_run'] = patch.autoRun ? 1 : 0;
		if (patch.currentCardId !== undefined) columns['current_card_id'] = patch.currentCardId;
		if (patch.currentRunId !== undefined) columns['current_run_id'] = patch.currentRunId;
		if (patch.currentSessionId !== undefined) columns['current_session_id'] = patch.currentSessionId;
		if (patch.inFlight !== undefined) columns['in_flight'] = JSON.stringify(patch.inFlight);
		if (patch.startedAt !== undefined) columns['started_at'] = patch.startedAt;
		if (patch.lastCardFinishedAt !== undefined) columns['last_card_finished_at'] = patch.lastCardFinishedAt;
		if (patch.cardsExecuted !== undefined) columns['cards_executed'] = patch.cardsExecuted;
		if (patch.stopAfterCurrent !== undefined) columns['stop_after_current'] = patch.stopAfterCurrent ? 1 : 0;
		if (patch.heartbeatAt !== undefined) columns['heartbeat_at'] = patch.heartbeatAt;
		if (patch.ownerPid !== undefined) columns['owner_pid'] = patch.ownerPid;

		if (Object.keys(columns).length > 0) {
			const sets = Object.keys(columns)
				.map((c) => `${c} = ?`)
				.join(', ');
			this.db.prepare(`UPDATE scheduler_state SET ${sets} WHERE id = 1`).run(...Object.values(columns));
			this.emit('scheduler_state', this.schedulerStatus());
		}

		return this.schedulerStatus();
	}
}

export type { AgentStatus };
