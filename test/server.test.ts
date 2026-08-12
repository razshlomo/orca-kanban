import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { createHttpServer } from '../src/server.ts';
import { fakeOrca, fakeOrchestration, silentLogger, testEnv } from './helpers.ts';
import type { Card, SchedulerStatus } from '../src/types.ts';

// Response shapes of the endpoints under test, declared once instead of asserted
// at each property access.
type StateResponse = {
	cards: Card[];
	scheduler: SchedulerStatus;
	eligible: string[];
	config: { defaultAgent: string };
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
