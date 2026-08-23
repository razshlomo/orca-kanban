import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.ts';
import { schedulerLiveness } from '../src/board.ts';
import { configPath, loadConfigSafe, readConfigFile, saveConfig } from '../src/config.ts';
import { assertSchedulerFree, SchedulerBusyError } from '../src/guard.ts';
import {
	renderLaunchAgent,
	renderSystemdUnit,
	SERVICE_ENV_FLAG,
	serviceSpec,
	stableNodeBin,
	unitAlwaysOn,
} from '../src/service.ts';
import { createHttpServer } from '../src/server.ts';
import { fakeOrca, fakeOrchestration, silentLogger, testEnv } from './helpers.ts';
import type { SchedulerStatus } from '../src/types.ts';

type ConfigResponse = {
	file: string;
	error: string | null;
	restartPending: string[];
	agents: string[];
	fields: Array<{ key: string; kind: string; hot: boolean; value: unknown }>;
	applied?: string[];
	restartRequired?: string[];
};
type ErrorResponse = { error: string };
type StateResponse = { config: { maxConcurrent: number; error: string | null } };
type ServiceResponse = { supported: boolean; selfManaged: boolean; installed: boolean; logFile: string };

// --------------------------------------------------------------------- config file

test('a patch changes only the keys it names', () => {
	testEnv();
	writeFileSync(configPath(), JSON.stringify({ defaultRepo: '/tmp/repo', maxAttempts: 3 }));

	saveConfig({ maxConcurrent: 2 });

	const { raw } = readConfigFile();
	assert.equal(raw['defaultRepo'], '/tmp/repo', 'an untouched key survives');
	assert.equal(raw['maxAttempts'], 3);
	assert.equal(raw['maxConcurrent'], 2);
});

test('an unknown setting is refused instead of written', () => {
	testEnv();
	writeFileSync(configPath(), JSON.stringify({ maxAttempts: 3 }));

	assert.throws(() => saveConfig({ maxConkurrent: 4 }), /Unknown or read-only setting/);
	// A typo that reaches the file is a setting that silently does nothing forever.
	assert.equal(readConfigFile().raw['maxKonkurrent'], undefined);
	assert.equal(readConfigFile().raw['maxAttempts'], 3);
});

test('a value the board could not boot with never reaches the file', () => {
	testEnv();
	writeFileSync(configPath(), JSON.stringify({ maxConcurrent: 1 }));

	assert.throws(() => saveConfig({ maxConcurrent: 0 }), /must be >= 1/);
	assert.equal(readConfigFile().raw['maxConcurrent'], 1, 'the previous config is untouched');
});

test('an emptied text field means unset, not the empty string', () => {
	testEnv();
	saveConfig({ defaultRepo: '/tmp/repo' });
	assert.equal(readConfigFile().raw['defaultRepo'], '/tmp/repo');

	saveConfig({ defaultRepo: '  ' });
	assert.equal(readConfigFile().raw['defaultRepo'], null);
});

test('a nested key is written without flattening its siblings', () => {
	testEnv();
	writeFileSync(configPath(), JSON.stringify({ orchestration: { objective: 'keep me', runId: 'r1' } }));

	saveConfig({ 'orchestration.enabled': false });

	const nested = readConfigFile().raw['orchestration'] as Record<string, unknown>;
	assert.equal(nested['enabled'], false);
	assert.equal(nested['objective'], 'keep me');
	assert.equal(nested['runId'], 'r1');
});

test('a broken config is moved aside rather than patched or destroyed', () => {
	const { home } = testEnv();
	writeFileSync(configPath(), '{ this is not json');

	const saved = saveConfig({ maxConcurrent: 3 });

	assert.equal(saved.replacedBroken, `${configPath()}.broken`);
	assert.ok(existsSync(path.join(home, 'config.json.broken')), 'the unreadable original is kept');
	assert.equal(readConfigFile().raw['maxConcurrent'], 3);
});

test('a broken config is reported, not thrown, so the board still boots', () => {
	testEnv();
	writeFileSync(configPath(), '{ nope');

	const { config, error } = loadConfigSafe();
	assert.match(String(error), /Invalid config/);
	assert.equal(config.maxConcurrent, 1, 'defaults, so there is a board to fix it from');
});

test('an invalid config is reported the same way as an unparseable one', () => {
	testEnv();
	writeFileSync(configPath(), JSON.stringify({ defaultAgent: 'nobody' }));

	const { config, error } = loadConfigSafe();
	assert.match(String(error), /defaultAgent "nobody"/);
	assert.equal(config.defaultAgent, 'omp');
});

test('the port needs a restart; the slot count does not', () => {
	testEnv();
	const saved = saveConfig({ port: 7500, maxConcurrent: 2 });

	assert.deepEqual(saved.restartRequired, ['port']);
	assert.deepEqual(saved.applied, ['maxConcurrent']);
});

// --------------------------------------------------------------------- live apply

test('a hot setting reaches the running scheduler, not just the file', () => {
	const { dbPath } = testEnv();
	const app = createApp({ dbPath, orca: fakeOrca(), orchestration: fakeOrchestration, log: silentLogger });

	const result = app.applyConfig({ maxConcurrent: 3, cardTimeoutMs: 120_000 });

	// The executor and the loop read these off this one object when they need them,
	// so writing it here is the whole of "applied".
	assert.equal(app.config.maxConcurrent, 3);
	assert.equal(app.config.cardTimeoutMs, 120_000);
	assert.deepEqual(result.restartRequired, []);
	app.close();
});

test('turning auto-run off from settings stops pickup, not just the file', () => {
	const { dbPath } = testEnv();
	const app = createApp({ dbPath, orca: fakeOrca(), orchestration: fakeOrchestration, log: silentLogger });
	app.board.patchSchedulerState({ autoRun: true });

	app.applyConfig({ autoRun: false });

	assert.equal(app.board.schedulerStatus().autoRun, false);
	app.close();
});

test('disabling the board pauses pickup while the board stays up', () => {
	const { dbPath } = testEnv();
	const app = createApp({ dbPath, orca: fakeOrca(), orchestration: fakeOrchestration, log: silentLogger });
	app.board.patchSchedulerState({ autoRun: true });

	app.applyConfig({ enabled: false });

	assert.equal(app.config.enabled, false);
	assert.equal(app.board.schedulerStatus().autoRun, false);
	app.close();
});

// ----------------------------------------------------------------- one scheduler

function status(over: Partial<SchedulerStatus> = {}): SchedulerStatus {
	return {
		runState: 'idle',
		autoRun: true,
		currentCardId: null,
		currentRunId: null,
		currentSessionId: null,
		inFlight: [],
		startedAt: Date.now(),
		lastCardFinishedAt: null,
		cardsExecuted: 0,
		stopAfterCurrent: false,
		heartbeatAt: Date.now(),
		ownerPid: process.pid,
		...over,
	};
}

test('a second scheduler is refused while another process owns the board', async () => {
	// A real live pid that is not us: two loops on one board would drive the same
	// agent sessions, and the claim transaction only caps cards, not watchers.
	const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
	await new Promise<void>((resolve) => child.once('spawn', resolve));

	const owned = status({ ownerPid: child.pid ?? null });
	const live = schedulerLiveness(owned, 2000);
	assert.equal(live.alive, true);

	assert.throws(() => assertSchedulerFree('run', owned, live), SchedulerBusyError);
	child.kill('SIGKILL');
});

test('a dead owner does not block a restart', () => {
	const dead = status({ ownerPid: 2_147_483_646, heartbeatAt: Date.now() });
	const live = schedulerLiveness(dead, 2000);

	assert.equal(live.alive, false);
	assert.doesNotThrow(() => assertSchedulerFree('serve', dead, live));
});

test('a stale heartbeat from a live pid does not block a restart', () => {
	const stale = status({ heartbeatAt: Date.now() - 120_000 });
	assert.doesNotThrow(() => assertSchedulerFree('serve', stale, schedulerLiveness(stale, 2000)));
});

test('our own row never blocks us', () => {
	const own = status();
	assert.doesNotThrow(() => assertSchedulerFree('serve', own, schedulerLiveness(own, 2000)));
});

// ---------------------------------------------------------------------- the unit

test('the launchd unit runs this interpreter and this checkout, not whatever is on PATH', () => {
	testEnv();
	const spec = serviceSpec({ kind: 'launchd', alwaysOn: true });
	const plist = renderLaunchAgent(spec);

	assert.match(plist, /<string>serve<\/string>/);
	assert.ok(plist.includes(spec.nodeBin), 'the absolute node binary');
	assert.ok(plist.includes(spec.cliPath), 'the absolute cli path');
	// launchd hands a job a bare PATH and no shell profile, so `orca` and the agent
	// CLIs are only findable if PATH is written into the unit.
	assert.ok(plist.includes(`<key>PATH</key>`));
	assert.ok(plist.includes(`<key>${SERVICE_ENV_FLAG}</key>`));
	assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
	assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
	assert.ok(plist.includes(spec.logFile));
});

test('the pinned interpreter is this interpreter, by a path an upgrade will not delete', () => {
	testEnv();
	const pinned = stableNodeBin();

	// Same binary…
	assert.equal(realpathSync(pinned), realpathSync(process.execPath));
	// …but preferably reached through a stable name. `/opt/homebrew/Cellar/node/26.6.0`
	// and `~/.nvm/versions/node/v22.21.0` both vanish on the next upgrade, taking an
	// always-on service with them.
	if (pinned !== process.execPath) {
		assert.ok(!/\d+\.\d+\.\d+/.test(pinned), `${pinned} still carries a version`);
	}
});

test('always-on off writes a unit that neither starts at login nor respawns', () => {
	testEnv();
	const plist = renderLaunchAgent(serviceSpec({ kind: 'launchd', alwaysOn: false }));

	// KeepAlive starts a job at load whether RunAtLoad is set or not, so these two
	// cannot disagree without lying about what the manager will do.
	assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
	assert.match(plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
	assert.equal(unitAlwaysOn(plist, 'launchd'), false);
});

test('the systemd unit restarts always and logs where the board expects', () => {
	testEnv();
	const spec = serviceSpec({ kind: 'systemd', alwaysOn: true });
	const unit = renderSystemdUnit(spec);

	assert.match(unit, /^Restart=always$/m);
	assert.match(unit, new RegExp(`^ExecStart=.*${SYSTEMD_ESCAPE(spec.cliPath)} serve$`, 'm'));
	assert.match(unit, new RegExp(`^Environment=${SERVICE_ENV_FLAG}=1$`, 'm'));
	assert.ok(unit.includes(spec.logFile));
	assert.equal(unitAlwaysOn(unit, 'systemd'), true);
	assert.equal(unitAlwaysOn(renderSystemdUnit(serviceSpec({ kind: 'systemd', alwaysOn: false })), 'systemd'), false);
});

function SYSTEMD_ESCAPE(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------------------------------------------------------------------------- HTTP

type Harness = {
	stop: () => Promise<void>;
	call: <T>(route: string, method?: string, body?: unknown) => Promise<{ status: number; json: T }>;
};

async function harness(): Promise<Harness> {
	const { dbPath } = testEnv();
	const app = createApp({
		dbPath,
		orca: fakeOrca(),
		orchestration: fakeOrchestration,
		log: silentLogger,
		config: { pollIntervalMs: 100, mirrorToOrcaBoard: false, orchestration: { enabled: false, objective: 'test', runId: null } },
	});

	const server = createHttpServer(app);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	return {
		stop: async () => {
			await app.scheduler.stop();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			app.close();
		},
		call: async <T,>(route: string, method = 'GET', body?: unknown) => {
			const res = await fetch(`http://127.0.0.1:${port}${route}`, {
				method,
				headers: body === undefined ? undefined : { 'content-type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			return { status: res.status, json: (await res.json()) as T };
		},
	};
}

test('the config endpoint describes every editable field and where it lives', async (t) => {
	const h = await harness();
	t.after(() => h.stop());

	const { status: code, json } = await h.call<ConfigResponse>('/api/config');
	assert.equal(code, 200);
	assert.equal(json.file, configPath());

	const port = json.fields.find((f) => f.key === 'port');
	assert.equal(port?.hot, false, 'the UI must be able to say "restart needed" before you click');
	assert.equal(json.fields.find((f) => f.key === 'maxConcurrent')?.hot, true);
	assert.ok(json.agents.includes('omp'));
});

test('a rejected setting answers 400 with the reason and changes nothing', async (t) => {
	const h = await harness();
	t.after(() => h.stop());

	const bad = await h.call<ErrorResponse>('/api/config', 'PATCH', { nonsense: 1 });
	assert.equal(bad.status, 400);
	assert.match(bad.json.error, /Unknown or read-only setting/);

	const invalid = await h.call<ErrorResponse>('/api/config', 'PATCH', { pollIntervalMs: 10 });
	assert.equal(invalid.status, 400);
	assert.match(invalid.json.error, />= 100/);
});

test('a saved hot setting is visible to the board on the next poll', async (t) => {
	const h = await harness();
	t.after(() => h.stop());

	const saved = await h.call<ConfigResponse>('/api/config', 'PATCH', { maxConcurrent: 2 });
	assert.equal(saved.status, 200);
	assert.deepEqual(saved.json.applied, ['maxConcurrent']);

	const state = await h.call<StateResponse>('/api/state');
	assert.equal(state.json.config.maxConcurrent, 2);
});

test('a restart-only setting is saved and then kept visible as pending', async (t) => {
	const h = await harness();
	t.after(() => h.stop());

	const saved = await h.call<ConfigResponse>('/api/config', 'PATCH', { port: 7531 });
	assert.deepEqual(saved.json.restartRequired, ['port']);

	// The port in use is still the bound one, so the panel has to keep saying so.
	const after = await h.call<ConfigResponse>('/api/config');
	assert.deepEqual(after.json.restartPending, ['port']);
});

test('the service endpoint says what the platform supports', async (t) => {
	const h = await harness();
	t.after(() => h.stop());

	const { json } = await h.call<ServiceResponse>('/api/service');
	assert.equal(typeof json.supported, 'boolean');
	assert.equal(json.selfManaged, false, 'a test board was not started by a service manager');
	assert.ok(json.logFile.endsWith('service.log'));
});

test('a board nobody manages refuses to restart itself', async (t) => {
	const h = await harness();
	t.after(() => h.stop());

	const { status: code, json } = await h.call<ErrorResponse>('/api/service/restart', 'POST', {});
	// Exiting would just kill this board, and kicking the manager would restart a
	// different process while this one kept running. Either way: refuse.
	assert.equal(code, 409);
	assert.match(json.error, /started by hand|Not running as a service/);
});

test('the settings panel is wired to endpoints that exist', () => {
	const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');

	for (const route of ['/api/config', '/api/service/', '/api/service']) {
		assert.ok(html.includes(route), `the UI calls ${route}`);
	}
	// One fixed slot on the right: two panels open at once would overlap.
	assert.ok(/closeSettings\(\)/.test(html) && /closePanel\(\)/.test(html));
	assert.ok(html.includes('id="setpanel"'));
});
