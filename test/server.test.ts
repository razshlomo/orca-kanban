import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp, type App } from '../src/app.ts';
import { createHttpServer } from '../src/server.ts';
import { fakeOrca, fakeOrchestration, silentLogger, testEnv } from './helpers.ts';
import type { Card, SchedulerStatus } from '../src/types.ts';

// Response shapes of the endpoints under test, declared once instead of asserted
// at each property access.
type StateResponse = {
	cards: Card[];
	scheduler: SchedulerStatus;
	eligible: string[];
	config: {
		defaultAgent: string;
		modelAgents: string[];
		models: { default: string | null; choices: Array<{ id: string; label: string }> };
	};
};
type CardResponse = { card: Card };
type RunsResponse = { runs: unknown[] };
type SchedulerResponse = { scheduler: SchedulerStatus };
type StopResponse = { stopped: boolean };
type RecoverResponse = { inspected: number };
type OnceResponse = { outcome: { card: Card; result: { status: string } } | null };
type ErrorResponse = { error: string };

type Harness = {
	base: string;
	app: App;
	stop: () => Promise<void>;
	call: <T>(path: string, method?: string, body?: unknown) => Promise<{ status: number; json: T }>;
};

async function harness(): Promise<Harness> {
	const { dbPath } = testEnv();
	const app = createApp({
		dbPath,
		orca: fakeOrca(),
		orchestration: fakeOrchestration,
		log: silentLogger,
		config: {
			pollIntervalMs: 100,
			mirrorToOrcaBoard: false,
			orchestration: { enabled: false, objective: 'test', runId: null },
		},
	});

	const server = createHttpServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	const base = `http://127.0.0.1:${port}`;

	return {
		base,
		app,
		stop: async () => {
			await app.scheduler.stop();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			app.close();
		},
		/** The single trust boundary: the caller names the shape it expects. */
		call: async <T,>(path: string, method = 'GET', body?: unknown) => {
			const res = await fetch(`${base}${path}`, {
				method,
				headers: body === undefined ? undefined : { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const json = (await res.json()) as T;
			return { status: res.status, json };
		},
	};
}

test('the API serves the board state the UI polls', async () => {
	const h = await harness();
	try {
		const created = await h.call<CardResponse>('/api/cards', 'POST', {
			title: 'from api',
			priority: 7,
			state: 'Ready',
		});
		assert.equal(created.status, 201);

		const { status, json } = await h.call<StateResponse>('/api/state');
		assert.equal(status, 200);
		assert.equal(json.cards.length, 1);
		assert.equal(json.cards[0]?.title, 'from api');
		assert.equal(json.cards[0]?.priority, 7);
		assert.deepEqual(json.eligible, [json.cards[0]?.id], 'a Ready card is reported as eligible');
		assert.equal(json.config.defaultAgent, 'omp');
		assert.ok(json.scheduler.runState);
	} finally {
		await h.stop();
	}
});

test('cards can be created, edited, moved, retried, and deleted over HTTP', async () => {
	const h = await harness();
	try {
		const created = await h.call<CardResponse>('/api/cards', 'POST', { title: 'lifecycle' });
		const id = created.json.card.id;
		assert.equal(created.json.card.state, 'Backlog', 'new cards start in Backlog');

		const patched = await h.call<CardResponse>(`/api/cards/${id}`, 'PATCH', {
			priority: 42,
			acceptanceCriteria: 'must pass',
			dependencies: ['card_other'],
		});
		assert.equal(patched.json.card.priority, 42);
		assert.equal(patched.json.card.acceptanceCriteria, 'must pass');
		assert.deepEqual(patched.json.card.dependencies, ['card_other']);

		const moved = await h.call<CardResponse>(`/api/cards/${id}/move`, 'POST', { state: 'Ready' });
		assert.equal(moved.json.card.state, 'Ready');

		const badMove = await h.call<ErrorResponse>(`/api/cards/${id}/move`, 'POST', { state: 'Nonsense' });
		assert.equal(badMove.status, 400, 'an invalid column is rejected');

		const runs = await h.call<RunsResponse>(`/api/cards/${id}/runs`);
		assert.deepEqual(runs.json.runs, []);

		const retried = await h.call<CardResponse>(`/api/cards/${id}/retry`, 'POST', {});
		assert.equal(retried.json.card.state, 'Ready');

		assert.equal((await h.call<unknown>(`/api/cards/${id}`, 'DELETE')).status, 200);
		assert.equal(
			(await h.call<ErrorResponse>(`/api/cards/${id}`, 'PATCH', { title: 'x' })).status,
			404,
			'gone means gone',
		);
	} finally {
		await h.stop();
	}
});

test('the edit endpoint refuses what a live run is built on, and still takes the rest', async () => {
	const h = await harness();
	try {
		const created = await h.call<CardResponse>('/api/cards', 'POST', {
			title: 'running',
			state: 'In Progress',
			repo: '/tmp/one',
		});
		const id = created.json.card.id;

		const refused = await h.call<ErrorResponse>(`/api/cards/${id}`, 'PATCH', { repo: '/tmp/two' });
		assert.equal(refused.status, 409, 'a board rule is a 409, not a 500');
		assert.match(refused.json.error, /while it is running/);

		// The panel saves the whole card every time, so restating the running values while
		// editing text has to stay a 200 or editing a running card becomes impossible.
		const edited = await h.call<CardResponse>(`/api/cards/${id}`, 'PATCH', {
			title: 'renamed mid-run',
			repo: '/tmp/one',
			dependencies: [],
			maxAttempts: 2,
		});
		assert.equal(edited.status, 200);
		assert.equal(edited.json.card.title, 'renamed mid-run');
		assert.equal(edited.json.card.repo, '/tmp/one');
	} finally {
		await h.stop();
	}
});

test('the API refuses a model no agent can run, and records the default on new cards', async () => {
	const h = await harness();
	try {
		// The harness config keeps omp's real catalog command, so this asks the agent that
		// is actually installed — but the refusals below never need it.
		const bad = await h.call<ErrorResponse>('/api/cards', 'POST', { title: 'nonsense model', model: 'gpt-9' });
		assert.equal(bad.status, 409, 'a refused model is a 409, like a refused board rule');
		assert.match(bad.json.error, /not in the model menu/);

		const claude = await h.call<ErrorResponse>('/api/cards', 'POST', {
			title: 'claude on opus',
			agent: 'claude',
			model: 'opus',
		});
		assert.equal(claude.status, 409);
		assert.match(claude.json.error, /cannot be told which model/);

		// An agent that cannot take one must not be handed the default either.
		const plain = await h.call<CardResponse>('/api/cards', 'POST', { title: 'claude work', agent: 'claude' });
		assert.equal(plain.status, 201);
		assert.equal(plain.json.card.model, null);

		const explicitNone = await h.call<CardResponse>('/api/cards', 'POST', { title: 'no model', model: null });
		assert.equal(explicitNone.json.card.model, null, 'an explicit null is respected, not overwritten by the default');

		const listed = await h.call<StateResponse>('/api/state');
		assert.deepEqual(
			listed.json.config.modelAgents,
			['omp'],
			'the UI is told which agents can take a model, so it can disable the select with a reason',
		);
		assert.equal(listed.json.config.models.default, 'opus');
		assert.deepEqual(
			listed.json.config.models.choices.map((c) => c.id),
			['fable', 'opus', 'sonnet', 'haiku', 'sol', 'astra'],
		);
	} finally {
		await h.stop();
	}
});

test('re-sending the model a card already has needs no catalog and is not a change', async () => {
	const h = await harness();
	try {
		const created = await h.call<CardResponse>('/api/cards', 'POST', { title: 'held model', model: null });
		const id = created.json.card.id;
		// Force a model onto the card without going through validation, as if it had been
		// created when that model still existed.
		h.app.board.updateCard(id, { model: 'withdrawn-model' });

		const saved = await h.call<CardResponse>(`/api/cards/${id}`, 'PATCH', {
			title: 'renamed',
			model: 'withdrawn-model',
		});

		assert.equal(saved.status, 200, 'the panel can still edit a card whose model has gone away');
		assert.equal(saved.json.card.title, 'renamed');
		assert.equal(saved.json.card.model, 'withdrawn-model');
	} finally {
		await h.stop();
	}
});

test('a card with no title is rejected', async () => {
	const h = await harness();
	try {
		const res = await h.call<ErrorResponse>('/api/cards', 'POST', { description: 'no title' });
		assert.equal(res.status, 400);
		assert.match(res.json.error, /title/);
	} finally {
		await h.stop();
	}
});

test('scheduler controls are reachable over HTTP', async () => {
	const h = await harness();
	try {
		const started = await h.call<SchedulerResponse>('/api/scheduler/start', 'POST', {});
		assert.equal(started.status, 200);
		assert.equal(started.json.scheduler.autoRun, true);

		const paused = await h.call<SchedulerResponse>('/api/scheduler/pause', 'POST', {});
		assert.equal(paused.json.scheduler.autoRun, false);

		const after = await h.call<SchedulerResponse>('/api/scheduler/stop-after-current', 'POST', {});
		assert.equal(after.json.scheduler.stopAfterCurrent, true);

		const stopCurrent = await h.call<StopResponse>('/api/scheduler/stop-current', 'POST', {});
		assert.equal(stopCurrent.json.stopped, false, 'nothing is running to stop');

		const recovered = await h.call<RecoverResponse>('/api/scheduler/recover', 'POST', {});
		assert.equal(recovered.status, 200);
		assert.equal(recovered.json.inspected, 0);

		assert.equal((await h.call<ErrorResponse>('/api/scheduler/nonsense', 'POST', {})).status, 404);
	} finally {
		await h.stop();
	}
});

test('run-once executes exactly one card and reports its outcome', async () => {
	const h = await harness();
	try {
		await h.call<CardResponse>('/api/cards', 'POST', { title: 'single', state: 'Ready', priority: 1 });
		await h.call<CardResponse>('/api/cards', 'POST', { title: 'second', state: 'Ready', priority: 0 });

		const res = await h.call<OnceResponse>('/api/scheduler/run-once', 'POST', {});
		assert.equal(res.status, 200);
		assert.ok(res.json.outcome, 'a card was executed');
		assert.equal(res.json.outcome?.card.title, 'single', 'the highest-priority card ran');

		const state = await h.call<StateResponse>('/api/state');
		assert.equal(
			state.json.cards.find((c) => c.title === 'second')?.state,
			'Ready',
			'only one card was taken',
		);
	} finally {
		await h.stop();
	}
});

test('the UI is served at the root', async () => {
	const h = await harness();
	try {
		const res = await fetch(h.base);
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /Orca Kanban/);
		assert.match(html, /In Progress/, 'the board columns are rendered');
	} finally {
		await h.stop();
	}
});

test('an unknown route is a clean 404', async () => {
	const h = await harness();
	try {
		assert.equal((await h.call<ErrorResponse>('/api/nope')).status, 404);
	} finally {
		await h.stop();
	}
});

/**
 * A harness with mirroring on, exposing the Orca fake so the board writes can be
 * inspected. Regression cover for manual state changes drifting from Orca's board.
 */
async function mirrorHarness(): Promise<Harness & { app: ReturnType<typeof createApp>; orca: ReturnType<typeof fakeOrca> }> {
	const { dbPath } = testEnv();
	const orca = fakeOrca();
	const app = createApp({
		dbPath,
		orca,
		orchestration: fakeOrchestration,
		log: silentLogger,
		config: {
			pollIntervalMs: 100,
			mirrorToOrcaBoard: true,
			orchestration: { enabled: false, objective: 'test', runId: null },
		},
	});

	const server = createHttpServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	const base = `http://127.0.0.1:${port}`;

	return {
		base,
		app,
		orca,
		stop: async () => {
			await app.scheduler.stop();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			app.close();
		},
		call: async <T,>(path: string, method = 'GET', body?: unknown) => {
			const res = await fetch(`${base}${path}`, {
				method,
				headers: body === undefined ? undefined : { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			return { status: res.status, json: (await res.json()) as T };
		},
	};
}

/** Gives a card the worktree it would have after a run, so it exists on Orca's board. */
function withWorktree(app: ReturnType<typeof createApp>, card: Card): Card {
	app.board.attachSession(card.id, {
		sessionId: 'term_mirror',
		worktreeId: 'repo::/tmp/wt',
		worktreePath: '/tmp/wt',
		branch: 'card-branch',
	});
	return app.board.getCard(card.id) as Card;
}

test('a card moved by hand is mirrored onto Orca board, not just SQLite', async () => {
	const h = await mirrorHarness();
	try {
		const card = withWorktree(h.app, h.app.board.createCard({ title: 'reviewed work', state: 'Review' }));

		const res = await h.call<CardResponse>(`/api/cards/${card.id}/move`, 'POST', { state: 'Done' });
		assert.equal(res.json.card.state, 'Done');

		const write = h.orca.statusWrites.at(-1);
		assert.equal(write?.selector, 'id:repo::/tmp/wt', 'the card own worktree is targeted');
		assert.equal(write?.workspaceStatus, 'completed', 'Done maps to the completed column');
		assert.match(String(write?.comment), new RegExp(card.id), 'the comment identifies the card');
	} finally {
		await h.stop();
	}
});

test('an edit that changes state mirrors, and one that does not leaves the board alone', async () => {
	const h = await mirrorHarness();
	try {
		const card = withWorktree(h.app, h.app.board.createCard({ title: 'x', state: 'Review' }));

		await h.call<CardResponse>(`/api/cards/${card.id}`, 'PATCH', { title: 'renamed only' });
		assert.equal(h.orca.statusWrites.length, 0, 'a title edit is not a board move');

		await h.call<CardResponse>(`/api/cards/${card.id}`, 'PATCH', { state: 'Blocked' });
		assert.equal(h.orca.statusWrites.at(-1)?.workspaceStatus, 'blocked');
	} finally {
		await h.stop();
	}
});

test('retrying a card moves its Orca card back to the ready column', async () => {
	const h = await mirrorHarness();
	try {
		const card = withWorktree(h.app, h.app.board.createCard({ title: 'failed work', state: 'Blocked' }));

		await h.call<CardResponse>(`/api/cards/${card.id}/retry`, 'POST', {});

		const write = h.orca.statusWrites.at(-1);
		assert.equal(write?.workspaceStatus, 'ready');
		assert.match(String(write?.comment), /retry requested/);
	} finally {
		await h.stop();
	}
});

test('a card that never ran has no Orca worktree, so a move is a silent no-op', async () => {
	const h = await mirrorHarness();
	try {
		const card = h.app.board.createCard({ title: 'never ran', state: 'Ready' });

		const res = await h.call<CardResponse>(`/api/cards/${card.id}/move`, 'POST', { state: 'Done' });
		assert.equal(res.json.card.state, 'Done', 'the board move still succeeds');
		assert.equal(h.orca.statusWrites.length, 0, 'nothing is written to Orca for a card it never saw');
	} finally {
		await h.stop();
	}
});

type CommentsResponse = { comments: Array<{ kind: string; body: string }> };
type DiffResponse = { diff: { untracked: string[]; patch: string } | null; reason?: string };
type OpenResponse = { opened: string };

test('approving over HTTP records the verdict and moves the Orca card to completed', async () => {
	const h = await mirrorHarness();
	try {
		const card = withWorktree(h.app, h.app.board.createCard({ title: 'x', state: 'Review' }));

		const res = await h.call<CardResponse>(`/api/cards/${card.id}/approve`, 'POST', { comment: 'looks right' });
		assert.equal(res.json.card.state, 'Done');
		assert.equal(h.orca.statusWrites.at(-1)?.workspaceStatus, 'completed');

		const trail = await h.call<CommentsResponse>(`/api/cards/${card.id}/comments`);
		assert.deepEqual(trail.json.comments.at(-1), { ...trail.json.comments.at(-1), kind: 'approved', body: 'looks right' });
	} finally {
		await h.stop();
	}
});

test('a rejection without a reason is a 400 and leaves the card in Review', async () => {
	const h = await mirrorHarness();
	try {
		const card = withWorktree(h.app, h.app.board.createCard({ title: 'x', state: 'Review' }));

		const res = await h.call<ErrorResponse>(`/api/cards/${card.id}/reject`, 'POST', { comment: '  ' });
		assert.equal(res.status, 400);
		assert.match(res.json.error, /next agent/);
		assert.equal(h.app.board.getCard(card.id)?.state, 'Review');
	} finally {
		await h.stop();
	}
});

test('rejecting over HTTP sends the card back to Ready with the reason attached', async () => {
	const h = await mirrorHarness();
	try {
		const card = withWorktree(h.app, h.app.board.createCard({ title: 'x', state: 'Review' }));

		const res = await h.call<CardResponse>(`/api/cards/${card.id}/reject`, 'POST', { comment: 'wrong return type' });
		assert.equal(res.json.card.state, 'Ready');
		assert.equal(h.orca.statusWrites.at(-1)?.workspaceStatus, 'ready');
		assert.match(h.app.board.backstoryFor(card.id).comments.at(-1)?.body ?? '', /wrong return type/);
	} finally {
		await h.stop();
	}
});

test('a plain comment is stored without moving the card', async () => {
	const h = await mirrorHarness();
	try {
		const card = h.app.board.createCard({ title: 'x', state: 'Review' });

		assert.equal((await h.call<unknown>(`/api/cards/${card.id}/comments`, 'POST', { body: 'a question' })).status, 201);
		assert.equal((await h.call<ErrorResponse>(`/api/cards/${card.id}/comments`, 'POST', { body: '' })).status, 400);
		assert.equal(h.app.board.getCard(card.id)?.state, 'Review', 'commenting is not a verdict');
	} finally {
		await h.stop();
	}
});

test('a card that never ran reports no diff instead of failing', async () => {
	const h = await mirrorHarness();
	try {
		const card = h.app.board.createCard({ title: 'never ran' });

		const res = await h.call<DiffResponse>(`/api/cards/${card.id}/diff`);
		assert.equal(res.status, 200);
		assert.equal(res.json.diff, null);
		assert.match(String(res.json.reason), /no worktree/);
	} finally {
		await h.stop();
	}
});

test('opening a card asks Orca to show its changed files as diffs', async () => {
	const h = await mirrorHarness();
	try {
		const card = withWorktree(h.app, h.app.board.createCard({ title: 'x', state: 'Review' }));

		const res = await h.call<OpenResponse>(`/api/cards/${card.id}/open`, 'POST', { target: 'changes' });
		assert.equal(res.json.opened, 'changes');
		assert.ok(
			h.orca.calls.includes('fileOpenChanged:id:repo::/tmp/wt:diff'),
			`expected a diff-mode open, got: ${h.orca.calls.join(', ')}`,
		);
	} finally {
		await h.stop();
	}
});

test('opening the session switches Orca to that terminal, and 400s when there is none', async () => {
	const h = await mirrorHarness();
	try {
		const withSession = withWorktree(h.app, h.app.board.createCard({ title: 'has one', state: 'Review' }));
		await h.call<OpenResponse>(`/api/cards/${withSession.id}/open`, 'POST', { target: 'session' });
		assert.ok(h.orca.calls.includes('terminalSwitch:term_mirror'));

		const without = h.app.board.createCard({ title: 'no session' });
		const res = await h.call<ErrorResponse>(`/api/cards/${without.id}/open`, 'POST', { target: 'session' });
		assert.equal(res.status, 400);
	} finally {
		await h.stop();
	}
});

type LandingResponse = { card: Card; landing: { committed: boolean; reason?: string } };
type StoppedResponse = { stopped: boolean };

test('a verdict on a card with no result is a 409 that explains itself', async () => {
	const h = await mirrorHarness();
	try {
		const card = h.app.board.createCard({ title: 'not reviewable', state: 'Backlog' });

		for (const route of ['approve', 'reject']) {
			const res = await h.call<ErrorResponse & { state: string }>(`/api/cards/${card.id}/${route}`, 'POST', {
				comment: 'anything',
			});
			assert.equal(res.status, 409, `${route} must be refused, not accepted or 500`);
			assert.match(res.json.error, /only Review or Blocked/);
			assert.equal(res.json.state, 'Backlog', 'the response names the state that blocked it');
		}
		assert.equal(h.app.board.getCard(card.id)?.state, 'Backlog', 'the card never moved');
	} finally {
		await h.stop();
	}
});

test('destructive actions on a running card are 409, not silent damage', async () => {
	const h = await mirrorHarness();
	try {
		const card = h.app.board.createCard({ title: 'busy', state: 'Ready' });
		h.app.board.claimCard(card.id, 'worker-1');

		for (const [route, method, body] of [
			[`/api/cards/${card.id}`, 'DELETE', undefined],
			[`/api/cards/${card.id}/retry`, 'POST', {}],
			[`/api/cards/${card.id}/snooze`, 'POST', { until: '1d' }],
		] as const) {
			const res = await h.call<ErrorResponse>(route, method, body);
			assert.equal(res.status, 409, `${method} ${route} must be refused`);
			assert.match(res.json.error, /while it is running/);
		}
		assert.ok(h.app.board.getCard(card.id), 'the running card is intact');
	} finally {
		await h.stop();
	}
});

test('approving reports what it landed, even when there was nothing to land', async () => {
	const h = await mirrorHarness();
	try {
		const card = withWorktree(h.app, h.app.board.createCard({ title: 'x', state: 'Review' }));

		const res = await h.call<LandingResponse>(`/api/cards/${card.id}/approve`, 'POST', { comment: 'ok' });
		assert.equal(res.status, 200);
		assert.equal(res.json.card.state, 'Done');
		// /tmp/wt is not a git repo, so landing reports a failure rather than pretending.
		assert.equal(res.json.landing.committed, false);
		assert.ok(res.json.landing.reason, 'the reason is always stated');
	} finally {
		await h.stop();
	}
});

test('run-once refuses when every slot is already busy', async () => {
	const h = await mirrorHarness();
	try {
		const busy = h.app.board.createCard({ title: 'busy', state: 'Ready' });
		h.app.board.claimCard(busy.id, 'worker-1');
		h.app.board.createCard({ title: 'waiting', state: 'Ready' });

		const res = await h.call<ErrorResponse>('/api/scheduler/run-once', 'POST', {});
		assert.equal(res.status, 409, 'a full board says so instead of doing nothing');
		assert.match(res.json.error, /slot/);
	} finally {
		await h.stop();
	}
});

test('stopping a card that is not in flight reports false rather than pretending', async () => {
	const h = await mirrorHarness();
	try {
		const card = h.app.board.createCard({ title: 'idle', state: 'Ready' });
		const res = await h.call<StoppedResponse>('/api/scheduler/stop-current', 'POST', { cardId: card.id });
		assert.equal(res.status, 200);
		assert.equal(res.json.stopped, false);
	} finally {
		await h.stop();
	}
});
