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
