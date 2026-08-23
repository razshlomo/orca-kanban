import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDITABLE_FIELDS, configPath, readConfigField } from './config.ts';
import { gitReviewDiff } from './git.ts';
import { commitCardWork, describeDrop, describeLanding, planLanding } from './land.ts';
import { describeResume, resumeCardSession } from './resume.ts';
import {
	installService,
	serviceState,
	startService,
	stopService,
	uninstallService,
} from './service.ts';
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
function bool(v: unknown): boolean | undefined {
	return typeof v === 'boolean' ? v : undefined;
}

/**
 * Per-server state that is not the board's business.
 *
 * `restartPending` remembers settings that were saved but cannot take effect until the
 * process restarts (the bound port, the orchestration client). Without it the UI would
 * show a saved value that the running board is not actually using.
 */
type Session = { restartPending: Set<string> };

function configView(app: App, session: Session): Record<string, unknown> {
	const live = app.config as unknown as Record<string, unknown>;
	return {
		file: configPath(),
		error: app.configError,
		restartPending: [...session.restartPending],
		agents: Object.keys(app.config.agents),
		fields: Object.entries(EDITABLE_FIELDS).map(([key, spec]) => ({
			key,
			...spec,
			value: readConfigField(live, key) ?? null,
		})),
	};
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
			// The UI needs to know which agents can reopen a conversation, so it can disable
			// the button with a reason rather than failing on click.
			resumableAgents: Object.entries(app.config.agents)
				.filter(([, a]) => a.resumeCommand)
				.map(([name]) => name),
			mirrorToOrcaBoard: app.config.mirrorToOrcaBoard,
			orchestrationEnabled: app.config.orchestration.enabled,
			enabled: app.config.enabled,
			// Surfaced on every poll so a broken config.json and a pending restart are
			// visible on the board itself, not only inside the settings panel.
			error: app.configError,
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
	const session: Session = { restartPending: new Set() };

	return createServer((req, res) => {
		void handle(app, session, req, res).catch((err: Error) => {
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

async function handle(app: App, session: Session, req: IncomingMessage, res: ServerResponse): Promise<void> {
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

		if (action === '/takeover' && method === 'POST') {
			const card = await app.takeOver(id);
			send(res, 200, { card, interrupted: Boolean(card.sessionId) });
			return;
		}

		if (action === '/takeback' && method === 'POST') {
			const { card, run } = await app.scheduler.takeBack(id);
			send(res, 200, { card, runId: run.id });
			return;
		}

		// A refused landing is a 409 with the reason, never a silent no-op: the caller
		// asked to change shared history and deserves to be told exactly what stopped it.
		if (action === '/land' && method === 'POST') {
			const keepBranch = (await readBody(req))['keepBranch'] === true;
			const { card, outcome } = await app.land(id, { keepBranch });
			if (!outcome.landed) {
				return send(res, 409, { error: describeLanding(outcome), reason: outcome.reason, card });
			}
			send(res, 200, { card, sha: outcome.sha, base: outcome.plan.base, disposed: outcome.disposed, detail: describeLanding(outcome) });
			return;
		}

		if (action === '/drop' && method === 'POST') {
			const force = (await readBody(req))['force'] === true;
			const { card, outcome } = await app.drop(id, { force });
			if (!outcome.dropped) {
				return send(res, 409, {
					error: describeDrop(outcome),
					reason: outcome.reason,
					unlandedCommits: outcome.unlandedCommits ?? 0,
					card,
				});
			}
			send(res, 200, { card, detail: describeDrop(outcome) });
			return;
		}

		// What the Land button may do, without doing it. The answer depends on the state
		// of the repository, not just the card, so the UI cannot work it out by itself.
		if (action === '/landable' && method === 'GET') {
			const card = app.board.getCard(id);
			if (!card) return send(res, 404, { error: `no such card ${id}` });

			const plan = await planLanding(card, app.config);
			send(res, 200, {
				can: plan.landed,
				reason: plan.landed ? null : plan.reason,
				why: plan.landed ? null : describeLanding(plan),
				base: plan.plan?.base ?? null,
				ahead: plan.plan?.standing.ahead ?? 0,
				behind: plan.plan?.standing.behind ?? 0,
				verifyCommand: app.config.verifyCommand,
			});
			return;
		}

		if (action === '/resume' && method === 'POST') {
			const card = app.board.getCard(id);
			if (!card) return send(res, 404, { error: `no such card ${id}` });

			const outcome = await resumeCardSession(card, app.config, app.orca);
			if (!outcome.resumed) {
				return send(res, 409, { error: describeResume(outcome), reason: outcome.reason });
			}
			// Point the card at the reopened terminal so Open session works again.
			const updated = app.board.attachSession(id, {
				sessionId: outcome.sessionId,
				worktreeId: card.worktreeId,
				worktreePath: card.worktreePath,
				branch: card.branch,
			});
			send(res, 200, { card: updated, sessionId: outcome.sessionId, command: outcome.command });
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
			const landing = await commitCardWork(target, app.config);
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
					held: report.held.map((d) => d.card.id),
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

	if (route === '/api/config' && method === 'GET') {
		send(res, 200, configView(app, session));
		return;
	}

	if (route === '/api/config' && (method === 'PATCH' || method === 'POST')) {
		const patch = await readBody(req);
		try {
			const result = app.applyConfig(patch);
			for (const key of result.restartRequired) session.restartPending.add(key);
			send(res, 200, { ...configView(app, session), ...result });
		} catch (err) {
			// A rejected setting is the caller's mistake, and the message is the whole
			// point of rejecting it — the board is unchanged either way.
			send(res, 400, { error: (err as Error).message });
		}
		return;
	}

	if (route === '/api/service' && method === 'GET') {
		send(res, 200, { ...serviceState(), restartPending: [...session.restartPending] });
		return;
	}

	if (route.startsWith('/api/service/') && method === 'POST') {
		const body = await readBody(req);
		const op = route.slice('/api/service/'.length);

		switch (op) {
			case 'install': {
				const { spec, actions } = installService({ alwaysOn: bool(body['alwaysOn']) ?? true });
				send(res, 200, { state: serviceState(), unitPath: spec.unitPath, actions });
				return;
			}
			case 'uninstall': {
				const { actions, removed } = uninstallService();
				send(res, 200, { state: serviceState(), removed, actions });
				return;
			}
			case 'autostart': {
				// The unit is rewritten rather than edited: RunAtLoad and KeepAlive are one
				// switch (launchd starts a KeepAlive job at load either way), so this is the
				// same install with the other value.
				const { spec, actions } = installService({ alwaysOn: body['enabled'] !== false });
				send(res, 200, { state: serviceState(), unitPath: spec.unitPath, actions });
				return;
			}
			case 'start':
				send(res, 200, { state: serviceState(), action: startService() });
				return;
			case 'stop':
				send(res, 200, { action: stopService() });
				return;
			case 'restart': {
				const force = body['force'] === true;
				const state = serviceState();
				const busy = app.scheduler.inFlightCards.length;

				// Restarting mid-card means SIGTERM on a running agent. Recovery would
				// reconcile it on the way back up, but throwing away a card's turn should be
				// asked for, not implied by clicking Save.
				if (busy > 0 && !force) {
					return send(res, 409, {
						error: `${busy} card${busy === 1 ? '' : 's'} still running. Wait for them, or restart with force.`,
					});
				}

				// Only the managed process may restart itself. A board started by hand is not
				// the board the manager owns: kicking the manager would restart a *different*
				// process and leave this one running, which is how you end up with two.
				if (!state.selfManaged) {
					return send(res, 409, {
						error: state.installed
							? 'This board was started by hand, so it is not the one the service manages. ' +
								'Restart it where you started it, or use: kanban service restart'
							: 'Not running as a service, so nothing would bring it back. ' +
								'Install the service first, or restart this process by hand.',
					});
				}

				if (!state.alwaysOn) {
					return send(res, 409, {
						error:
							'This board would not come back: the service is installed with always-on off. ' +
							'Turn always-on on, or restart it from a terminal with: kanban service restart',
					});
				}

				send(res, 200, { restarting: true, via: 'exit', state });
				// Exit cleanly and let the service manager start the replacement. Doing it
				// from the outside (kickstart) would mean signalling ourselves and racing
				// our own shutdown.
				setTimeout(() => {
					void app.scheduler.stop({ abortCurrent: force }).then(() => {
						app.log.info('restarting: exiting for the service manager');
						app.close();
						process.exit(0);
					});
				}, 150).unref();
				return;
			}
			default:
				return send(res, 404, { error: `unknown service op ${op}` });
		}
	}

	send(res, 404, { error: `no route for ${method} ${route}` });
}
