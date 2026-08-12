import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitReviewDiff } from './git.ts';
import { landCardWork } from './land.ts';
import { parseDueAt } from './text.ts';
import { BoardRuleError, schedulerLiveness } from './board.ts';
import type { App } from './app.ts';
import { isCardState, type Card, type CardInput, type CardState } from './types.ts';

const UI_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');

type Json = Record<string, unknown> | Array<unknown> | null;

function send(res: ServerResponse, status: number, body: Json): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
	res.end(payload);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
	const chunks: Buffer[] = [];
	req.on('data', (c: Buffer) => {
		chunks.push(c);
		// Cards are small; refuse anything that looks like an upload.
		if (chunks.reduce((n, b) => n + b.length, 0) > 1_000_000) reject(new Error('body too large'));
	});
	req.on('error', reject);
	req.on('end', () => {
		const raw = Buffer.concat(chunks).toString('utf8').trim();
		if (raw === '') return resolve({});
		try {
			const parsed: unknown = JSON.parse(raw);
			resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
		} catch (err) {
			reject(err as Error);
		}
	});
	return promise;
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function cardInputFrom(body: Record<string, unknown>): Partial<CardInput> & { state?: CardState } {
	const patch: Partial<CardInput> & { state?: CardState } = {};
	if (str(body['title']) !== undefined) patch.title = str(body['title']);
	if (str(body['description']) !== undefined) patch.description = str(body['description']);
	if (str(body['acceptanceCriteria']) !== undefined) patch.acceptanceCriteria = str(body['acceptanceCriteria']);
	if (num(body['priority']) !== undefined) patch.priority = num(body['priority']);
	if (num(body['order']) !== undefined) patch.order = num(body['order']);
	if (num(body['maxAttempts']) !== undefined) patch.maxAttempts = num(body['maxAttempts']);
	if (Array.isArray(body['dependencies'])) patch.dependencies = body['dependencies'].map(String);
	if ('repo' in body) patch.repo = str(body['repo']) ?? null;
	if ('agent' in body) patch.agent = str(body['agent']) ?? null;
	// A schedule is clearable, so an explicit null must survive as null.
	if ('notBefore' in body) patch.notBefore = num(body['notBefore']) ?? null;
	if ('repeatEveryMs' in body) patch.repeatEveryMs = num(body['repeatEveryMs']) ?? null;
	if (isCardState(body['state'])) patch.state = body['state'];
	return patch;
}

/** Board + scheduler view the UI polls. */
function stateSnapshot(app: App): Record<string, unknown> {
	const status = app.board.schedulerStatus();
	// The reason a card sits still travels with the card, so the UI never has to
	// re-derive the eligibility rules and drift from the board.
	const cards = app.board.listCards().map((c) => ({ ...c, heldBecause: app.board.whyNotRunnable(c) }));

	return {
		cards,
		scheduler: {
			...status,
			isRunning: app.scheduler.isRunning,
			isBusy: app.scheduler.isBusy,
			maxConcurrent: app.config.maxConcurrent,
			inFlightCount: app.board.inFlightCount(),
			nextWakeAt: app.board.nextWakeAt(),
			// The UI must not promise pickup when no process is watching the board.
			live: schedulerLiveness(status, app.config.pollIntervalMs),
		},
		config: {
			defaultAgent: app.config.defaultAgent,
			defaultRepo: app.config.defaultRepo,
			successState: app.config.successState,
			maxAttempts: app.config.maxAttempts,
			pollIntervalMs: app.config.pollIntervalMs,
			maxConcurrent: app.config.maxConcurrent,
			agents: Object.keys(app.config.agents),
			mirrorToOrcaBoard: app.config.mirrorToOrcaBoard,
			orchestrationEnabled: app.config.orchestration.enabled,
		},
		eligible: app.board.eligibleCards().map((c: Card) => c.id),
		events: app.board.recentEvents(60),
		boardRevision: app.board.boardRevision(),
	};
}

/**
 * Minimal HTTP API + single-page UI for the Kanban board.
 *
 * Deliberately small: Orca's own workspace board already renders each running card
 * (state, progress comment, agent), so this surface only adds what Orca has no
 * columns for — priority, dependencies, retries, run history, scheduler controls.
 */
export function createHttpServer(app: App): Server {
	return createServer((req, res) => {
		void handle(app, req, res).catch((err: Error) => {
			if (res.headersSent) return;
			// A refused transition is the caller asking for something the board's rules
			// forbid — a 409 with the reason, not an opaque 500.
			if (err instanceof BoardRuleError) {
				send(res, 409, { error: err.message, cardId: err.cardId, state: err.state });
				return;
			}
			send(res, 500, { error: err.message });
		});
	});
}

async function handle(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? '/', 'http://localhost');
	const route = url.pathname.replace(/\/+$/, '') || '/';
	const method = req.method ?? 'GET';

	if (route === '/' && method === 'GET') {
		try {
			const html = readFileSync(UI_FILE, 'utf8');
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
			res.end(html);
		} catch {
			send(res, 500, { error: `UI not found at ${UI_FILE}` });
		}
		return;
	}

	if (route === '/api/state' && method === 'GET') {
		send(res, 200, stateSnapshot(app));
		return;
	}

	if (route === '/api/cards' && method === 'GET') {
		send(res, 200, { cards: app.board.listCards() });
		return;
	}

	if (route === '/api/cards' && method === 'POST') {
		const body = await readBody(req);
		const title = str(body['title'])?.trim();
		if (!title) return send(res, 400, { error: 'title is required' });
		const input = cardInputFrom(body);
		const card = app.board.createCard({ ...input, title, state: input.state ?? 'Backlog' });
		send(res, 201, { card });
		return;
	}

	const cardMatch = /^\/api\/cards\/([^/]+)(\/[a-z-]+)?$/.exec(route);
	if (cardMatch) {
		const id = decodeURIComponent(cardMatch[1] as string);
		const action = cardMatch[2];
		const card = app.board.getCard(id);
		if (!card) return send(res, 404, { error: `no such card ${id}` });

		if (!action && method === 'PATCH') {
			const body = await readBody(req);
			const updated = app.board.updateCard(id, cardInputFrom(body));
			// An edit that changes state must move the Orca card too.
			if (updated && updated.state !== card.state) await app.mirrorCard(updated);
			send(res, 200, { card: updated });
			return;
		}

		if (!action && method === 'DELETE') {
			send(res, 200, { deleted: app.board.deleteCard(id) });
			return;
		}

		if (action === '/move' && method === 'POST') {
			const body = await readBody(req);
			const state = body['state'];
			if (!isCardState(state)) return send(res, 400, { error: 'state must be a valid board state' });
			const moved = app.board.moveCard(id, state, num(body['order']));
			if (moved) await app.mirrorCard(moved);
			send(res, 200, { card: moved });
			return;
		}

		if (action === '/retry' && method === 'POST') {
			const body = await readBody(req);
			const resetAttempts = body['resetAttempts'] !== false;
			const retried = app.board.retryCard(id, { resetAttempts });
			if (retried) await app.mirrorCard(retried, 'retry requested');
			send(res, 200, { card: retried });
			return;
		}

		if (action === '/runs' && method === 'GET') {
			send(res, 200, { runs: app.board.runsForCard(id) });
			return;
		}

		if (action === '/snooze' && method === 'POST') {
			const body = await readBody(req);
			const until = str(body['until']);
			const dueAt = until ? parseDueAt(until) : num(body['notBefore']);
			if (dueAt === undefined || dueAt === null) {
				return send(res, 400, { error: 'until must be a duration like "7d" or a date, or pass notBefore in epoch ms' });
			}

			const snoozed = app.board.snoozeCard(id, dueAt);
			if (snoozed) await app.mirrorCard(snoozed, `deferred until ${new Date(dueAt).toISOString()}`);
			send(res, 200, { card: snoozed });
			return;
		}

		if (action === '/approve' && method === 'POST') {
			const body = await readBody(req);
			const state = body['state'];

			// Validate before touching the repository: a refused approval must not commit.
			const target = app.board.verdictTarget(id);
			if (!target) return send(res, 404, { error: `no such card ${id}` });

			// Then land the work, so Done never means "finished, changes lost".
			const landing = await landCardWork(target, app.config);
			if (landing.committed) app.board.recordCommit(card.id, landing.sha);

			const approved = app.board.approveCard(id, {
				...(str(body['comment']) ? { comment: String(body['comment']) } : {}),
				...(isCardState(state) ? { state } : {}),
			});
			if (approved) await app.mirrorCard(approved, 'approved by review');
			send(res, 200, { card: approved, landing });
			return;
		}

		if (action === '/reject' && method === 'POST') {
			const body = await readBody(req);
			const comment = str(body['comment'])?.trim();
			// The reason is the whole point: it is what the next agent reads.
			if (!comment) return send(res, 400, { error: 'comment is required — it is what the next agent reads' });
			const rejected = app.board.rejectCard(id, comment);
			if (rejected) await app.mirrorCard(rejected, 'changes requested');
			send(res, 200, { card: rejected });
			return;
		}

		if (action === '/comments' && method === 'GET') {
			send(res, 200, { comments: app.board.commentsForCard(id) });
			return;
		}

		if (action === '/comments' && method === 'POST') {
			const body = await readBody(req);
			const text = str(body['body'])?.trim();
			if (!text) return send(res, 400, { error: 'body is required' });
			send(res, 201, { comment: app.board.addComment(id, text) });
			return;
		}

		if (action === '/diff' && method === 'GET') {
			if (!card.worktreePath) return send(res, 200, { diff: null, reason: 'this card has no worktree yet' });
			const diff = await gitReviewDiff(card.worktreePath, { baseRef: app.config.baseBranch });
			send(res, 200, { diff });
			return;
		}

		if (action === '/open' && method === 'POST') {
			const body = await readBody(req);
			const target = str(body['target']) ?? 'changes';

			try {
				if (target === 'session') {
					if (!card.sessionId) return send(res, 400, { error: 'this card has no Orca session' });
					await app.orca.terminalSwitch(card.sessionId);
				} else {
					if (!card.worktreePath) return send(res, 400, { error: 'this card has no worktree yet' });
					const selector = card.worktreeId ? `id:${card.worktreeId}` : `path:${card.worktreePath}`;
					await app.orca.fileOpenChanged({ worktreeSelector: selector, mode: 'diff' });
				}
			} catch (err) {
				return send(res, 502, { error: `Orca refused: ${(err as Error).message}` });
			}

			send(res, 200, { opened: target });
			return;
		}

		return send(res, 405, { error: `${method} not allowed on ${route}` });
	}

	if (route === '/api/cards/reorder' && method === 'POST') {
		const body = await readBody(req);
		const ids = Array.isArray(body['ids']) ? body['ids'].map(String) : null;
		if (!ids) return send(res, 400, { error: 'ids must be an array of card ids' });
		app.board.reorderCards(ids);
		send(res, 200, { ok: true });
		return;
	}

	if (route.startsWith('/api/scheduler/') && method === 'POST') {
		const body = await readBody(req);
		const op = route.slice('/api/scheduler/'.length);

		switch (op) {
			case 'start':
				app.scheduler.start({ autoRun: true });
				break;
			case 'pause':
				app.scheduler.setAutoRun(false);
				break;
			case 'autorun':
				app.scheduler.setAutoRun(body['enabled'] !== false);
				break;
			case 'stop-after-current':
				app.scheduler.stopAfterCurrent();
				break;
			case 'stop-current': {
				// Optional cardId, so one lane can be stopped without touching the others.
				const cardId = str(body['cardId']);
				send(res, 200, { stopped: app.scheduler.stopCurrentCard(cardId) });
				return;
			}
			case 'run-once': {
				// Saying "no slot" beats silently doing nothing and looking broken.
				const busy = app.board.inFlightCount();
				if (busy >= app.config.maxConcurrent) {
					return send(res, 409, {
						error: `All ${app.config.maxConcurrent} slot${app.config.maxConcurrent === 1 ? '' : 's'} are busy (${busy} in flight).`,
					});
				}
				const outcome = await app.scheduler.runOnce();
				send(res, 200, { outcome, eligible: app.board.eligibleCards().length });
				return;
			}
			case 'recover': {
				const report = await app.recover();
				send(res, 200, {
					inspected: report.inspected,
					adopted: report.adopted.map((d) => d.card.id),
					requeued: report.requeued.map((d) => d.card.id),
					blocked: report.blocked.map((d) => d.card.id),
				});
				return;
			}
			default:
				return send(res, 404, { error: `unknown scheduler op ${op}` });
		}

		send(res, 200, { scheduler: app.board.schedulerStatus() });
		return;
	}

	send(res, 404, { error: `no route for ${method} ${route}` });
}
