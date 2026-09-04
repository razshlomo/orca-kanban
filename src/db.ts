import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { kanbanHome } from './config.ts';

export type Db = DatabaseSync;

/** Values SQLite can bind directly. */
export type SqlValue = string | number | bigint | null | Uint8Array;

export function defaultDbPath(): string {
	return process.env.ORCA_KANBAN_DB ?? path.join(kanbanHome(), 'board.sqlite');
}

const MIGRATIONS: string[] = [
	// v1 — board, append-only run history, event log, scheduler singleton.
	`
	CREATE TABLE cards (
		id                  TEXT PRIMARY KEY,
		title               TEXT NOT NULL,
		description         TEXT NOT NULL DEFAULT '',
		acceptance_criteria TEXT NOT NULL DEFAULT '',
		state               TEXT NOT NULL DEFAULT 'Backlog',
		priority            INTEGER NOT NULL DEFAULT 0,
		board_order         INTEGER NOT NULL DEFAULT 0,
		dependencies        TEXT NOT NULL DEFAULT '[]',
		repo                TEXT,
		agent               TEXT,
		created_at          INTEGER NOT NULL,
		updated_at          INTEGER NOT NULL,
		claimed_at          INTEGER,
		claimed_by          TEXT,
		session_id          TEXT,
		branch              TEXT,
		worktree_path       TEXT,
		commit_sha          TEXT,
		attempt_count       INTEGER NOT NULL DEFAULT 0,
		max_attempts        INTEGER NOT NULL DEFAULT 2,
		last_result         TEXT,
		last_error          TEXT,
		last_agent_summary  TEXT,
		/* Orca-native linkage: the worktree that *is* this card's board card. */
		worktree_id         TEXT,
		orca_task_id        TEXT,
		orca_dispatch_id    TEXT,
		CHECK (state IN ('Backlog','Ready','In Progress','Review','Done','Blocked'))
	);

	CREATE INDEX idx_cards_pick ON cards (state, priority DESC, board_order ASC, created_at ASC);

	CREATE TABLE card_runs (
		id          TEXT PRIMARY KEY,
		card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
		session_id  TEXT,
		started_at  INTEGER NOT NULL,
		finished_at INTEGER,
		status      TEXT NOT NULL,
		commit_sha  TEXT,
		summary     TEXT,
		error       TEXT,
		details     TEXT
	);

	CREATE INDEX idx_runs_card ON card_runs (card_id, started_at DESC);

	CREATE TABLE events (
		id       INTEGER PRIMARY KEY AUTOINCREMENT,
		ts       INTEGER NOT NULL,
		event    TEXT NOT NULL,
		card_id  TEXT,
		run_id   TEXT,
		session_id TEXT,
		data     TEXT
	);

	CREATE INDEX idx_events_ts ON events (ts DESC);

	CREATE TABLE scheduler_state (
		id                     INTEGER PRIMARY KEY CHECK (id = 1),
		auto_run               INTEGER NOT NULL DEFAULT 0,
		run_state              TEXT NOT NULL DEFAULT 'stopped',
		current_card_id        TEXT,
		current_run_id         TEXT,
		current_session_id     TEXT,
		started_at             INTEGER,
		last_card_finished_at  INTEGER,
		cards_executed         INTEGER NOT NULL DEFAULT 0,
		stop_after_current     INTEGER NOT NULL DEFAULT 0,
		heartbeat_at           INTEGER,
		owner_pid              INTEGER,
		/** Bumped on every board mutation so watchers can wake without polling content. */
		board_revision         INTEGER NOT NULL DEFAULT 0
	);

	INSERT INTO scheduler_state (id) VALUES (1);
	`,
	// v2 — append-only review trail: reviewer comments and approve/reject verdicts.
	`
	CREATE TABLE card_comments (
		id         TEXT PRIMARY KEY,
		card_id    TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
		/* 'comment' is a plain note; 'approved' and 'rejected' are review verdicts. */
		kind       TEXT NOT NULL DEFAULT 'comment',
		author     TEXT NOT NULL DEFAULT 'human',
		body       TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL,
		CHECK (kind IN ('comment','approved','rejected'))
	);

	CREATE INDEX idx_comments_card ON card_comments (card_id, created_at ASC);
	`,
	// v3 — deferred and recurring cards.
	`
	/* Epoch ms before which the card must not run. NULL means "runnable now". */
	ALTER TABLE cards ADD COLUMN not_before INTEGER;
	/* When set, reaching Done re-arms the card this many ms into the future. */
	ALTER TABLE cards ADD COLUMN repeat_every_ms INTEGER;

	DROP INDEX IF EXISTS idx_cards_pick;
	CREATE INDEX idx_cards_pick ON cards (state, not_before, priority DESC, board_order ASC, created_at ASC);

	/* Every card the owning scheduler is executing, as JSON. current_card_id keeps
	   reporting the oldest of them so existing readers are unaffected. */
	ALTER TABLE scheduler_state ADD COLUMN in_flight TEXT NOT NULL DEFAULT '[]';
	`,

	// v4 — when a card last changed column.
	`
	/* Epoch ms of the last STATE transition, as opposed to updated_at which moves on any
	   edit. This is what answers "how long has this been sitting in Review". Existing rows
	   seed from updated_at: imprecise for old cards, but never null and never in the future. */
	ALTER TABLE cards ADD COLUMN state_changed_at INTEGER;
	UPDATE cards SET state_changed_at = updated_at WHERE state_changed_at IS NULL;

	/* Eight separate statements move a card between columns — claim, move, retry, snooze,
	   re-arm and three result paths — and more will be added. Triggers keep the stamp
	   correct without every future write path having to remember it.

	   julianday gives millisecond precision; strftime('%s') would only give seconds.
	   Recursive triggers are off by default, and the WHEN guard makes a same-state write
	   a no-op regardless. */
	CREATE TRIGGER cards_state_changed AFTER UPDATE OF state ON cards
	WHEN old.state <> new.state
	BEGIN
		UPDATE cards
		SET state_changed_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
		WHERE id = new.id;
	END;

	CREATE TRIGGER cards_state_inserted AFTER INSERT ON cards
	WHEN new.state_changed_at IS NULL
	BEGIN
		UPDATE cards SET state_changed_at = new.created_at WHERE id = new.id;
	END;
	`,

	// v5 — manual control of a live session.
	`
	/* Epoch ms when a human took the session. While set the board stops supervising the
	   card entirely: no result-file settle, no idle settle, no timeout, no terminal close.

	   Deliberately NOT a seventh card state. cards.state carries a CHECK constraint, and
	   both card_runs and card_comments reference cards(id) ON DELETE CASCADE with foreign
	   keys enforced — so adding a state value means a table rebuild that would take every
	   run and comment with it. A nullable column is the whole change, and it keeps the
	   existing guards working: the card really is In Progress, so delete/hold/retry stay
	   refused, and the slot stays held because the lane is occupied by you. */
	ALTER TABLE cards ADD COLUMN manual_since INTEGER;
	`,
	`
	/* The merge commit that landed this card's branch on the base branch, and when.

	   Separate from commit_sha on purpose: that one says the work exists on a branch of
	   its own, this one says it has been published where others build from. Landing is a
	   deliberate human step, never a consequence of a card reaching Done, so most cards
	   keep these null for good — their deliverable was an answer, not code. */
	ALTER TABLE cards ADD COLUMN landed_sha TEXT;
	ALTER TABLE cards ADD COLUMN landed_at INTEGER;
	`,
	// v7 — the model a card runs on, and the agent catalogs used to check it.
	`
	/* A short alias from config.models.choices ("opus", "sol"), not a pinned version:
	   the alias is resolved against the agent's own catalog when the card runs, so a
	   card queued today runs whatever that name means on the day it executes. NULL
	   leaves the model to the agent's own default, which is how every card behaved
	   before this column existed. */
	ALTER TABLE cards ADD COLUMN model TEXT;

	/* One agent's model catalog, as reported by its own CLI. Cached in the board so
	   the CLI, the server and the scheduler share a single fetch instead of paying
	   seconds each; a stale copy is still better than refusing a card because the
	   agent's binary hiccuped, so nothing here is ever deleted, only replaced. */
	CREATE TABLE model_catalog (
		agent      TEXT PRIMARY KEY,
		models     TEXT NOT NULL,
		fetched_at INTEGER NOT NULL
	);
	`,
];

/**
 * Opens the board database, applies pending migrations, and sets the pragmas that
 * make cross-process claiming safe (WAL + a real busy timeout).
 */
export function openDb(dbPath: string = defaultDbPath()): Db {
	if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });

	const db = new DatabaseSync(dbPath);
	// busy_timeout MUST come first: switching journal_mode needs a brief exclusive
	// lock, and without a timeout already in effect a concurrent open fails
	// outright with SQLITE_BUSY ("database is locked").
	db.exec('PRAGMA busy_timeout = 10000');
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA synchronous = NORMAL');
	db.exec('PRAGMA foreign_keys = ON');

	const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
	let version = Number(row?.user_version ?? 0);

	while (version < MIGRATIONS.length) {
		const sql = MIGRATIONS[version];
		if (!sql) break;
		db.exec('BEGIN IMMEDIATE');
		try {
			db.exec(sql);
			version += 1;
			db.exec(`PRAGMA user_version = ${version}`);
			db.exec('COMMIT');
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
	}

	return db;
}

/**
 * Runs `fn` inside BEGIN IMMEDIATE so a read-then-write claim cannot interleave
 * with another worker's claim of the same card.
 */
export function immediateTransaction<T>(db: Db, fn: () => T): T {
	db.exec('BEGIN IMMEDIATE');
	try {
		const result = fn();
		db.exec('COMMIT');
		return result;
	} catch (err) {
		try {
			db.exec('ROLLBACK');
		} catch {
			// Rollback can fail if the transaction was already aborted; keep the original error.
		}
		throw err;
	}
}
