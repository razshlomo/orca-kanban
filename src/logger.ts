import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { kanbanHome } from './config.ts';
import { SERVICE_ENV_FLAG } from './service.ts';
import type { BoardEvent } from './types.ts';

/**
 * Rotate at 8 MB, keeping one previous file.
 *
 * A board that runs for months as a service writes here forever, and nothing else
 * would ever trim it: this log was already megabytes after a week of hand-started
 * runs.
 */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

export type LogFields = {
	cardId?: string | null;
	sessionId?: string | null;
	runId?: string | null;
	[key: string]: unknown;
};

export type Logger = {
	event: (event: BoardEvent, fields?: LogFields) => void;
	info: (message: string, fields?: LogFields) => void;
	warn: (message: string, fields?: LogFields) => void;
	error: (message: string, fields?: LogFields) => void;
};

/**
 * Structured JSON-lines logger. Every line carries cardId/sessionId/runId when
 * known so a board decision, an Orca session, and a CardRun can be correlated.
 */
export function createLogger(options: { file?: string | null; stderr?: boolean } = {}): Logger {
	// Under a service manager stderr is redirected into the service log, so writing
	// every line to both would duplicate the whole log into a file nothing rotates.
	const stderr = options.stderr ?? process.env[SERVICE_ENV_FLAG] !== '1';
	const file = options.file === undefined ? path.join(kanbanHome(), 'scheduler.log') : options.file;

	if (file) mkdirSync(path.dirname(file), { recursive: true });

	let bytes = 0;
	if (file) {
		try {
			bytes = statSync(file).size;
		} catch {
			// No log yet.
		}
	}

	const write = (level: string, kind: string, fields: LogFields): void => {
		const line = JSON.stringify({
			ts: new Date().toISOString(),
			level,
			...(level === 'event' ? { event: kind } : { msg: kind }),
			cardId: fields.cardId ?? undefined,
			sessionId: fields.sessionId ?? undefined,
			runId: fields.runId ?? undefined,
			...Object.fromEntries(
				Object.entries(fields).filter(([k]) => k !== 'cardId' && k !== 'sessionId' && k !== 'runId'),
			),
		});
		if (stderr) process.stderr.write(`${line}\n`);
		if (file) {
			try {
				appendFileSync(file, `${line}\n`);
				bytes += line.length + 1;
				if (bytes > MAX_LOG_BYTES) {
					renameSync(file, `${file}.1`);
					bytes = 0;
				}
			} catch {
				// Never let logging break execution.
			}
		}
	};

	return {
		event: (event, fields = {}) => write('event', event, fields),
		info: (message, fields = {}) => write('info', message, fields),
		warn: (message, fields = {}) => write('warn', message, fields),
		error: (message, fields = {}) => write('error', message, fields),
	};
}

export const silentLogger: Logger = {
	event: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};
