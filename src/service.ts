import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kanbanHome } from './config.ts';

/**
 * Running the board under the OS service manager.
 *
 * Two things make this more than "put it in a plist":
 *
 * 1. **It must be a per-user agent, not a system daemon.** The scheduler drives Orca
 *    by shelling out to the `orca` CLI, and Orca is a desktop app living in the user's
 *    GUI login session. A macOS LaunchDaemon runs in the system context and cannot
 *    reach it, so every `worktree create` would fail. Hence `gui/<uid>` on darwin and
 *    a `--user` unit on linux.
 * 2. **The service manager gives you almost no environment.** launchd starts jobs with
 *    a bare `PATH`, no shell profile, no `nvm`. The board needs `node` (captured as an
 *    absolute path) plus `orca` and the agent CLIs (`omp`, `claude`, `codex`) on PATH,
 *    so PATH is captured from the shell that installs the service and written into the
 *    unit.
 */

export const SERVICE_LABEL = 'co.orca.kanban';
export const SYSTEMD_UNIT_NAME = 'orca-kanban.service';

/** Set in the unit, so the running process knows a manager will restart it. */
export const SERVICE_ENV_FLAG = 'ORCA_KANBAN_SERVICE';

export type ServiceKind = 'launchd' | 'systemd';

export type ServiceSpec = {
	kind: ServiceKind;
	label: string;
	unitPath: string;
	/** Absolute node binary — never resolved through the manager's bare PATH. */
	nodeBin: string;
	cliPath: string;
	workingDir: string;
	logFile: string;
	env: Record<string, string>;
	/**
	 * Start at login and come back after a crash.
	 *
	 * One switch, not two: launchd's `KeepAlive` starts a job at load whether or not
	 * `RunAtLoad` is set, so "restart forever but do not start at login" is not a state
	 * the manager can actually hold. Off means loaded but idle until started by hand.
	 */
	alwaysOn: boolean;
};

export type ServiceState = {
	kind: ServiceKind | null;
	supported: boolean;
	/** Whether this very process was started by the service manager. */
	selfManaged: boolean;
	unitPath: string | null;
	logFile: string;
	installed: boolean;
	alwaysOn: boolean;
	running: boolean;
	pid: number | null;
	lastExitStatus: number | null;
	detail: string;
};

export function serviceKind(): ServiceKind | null {
	const os = platform();
	if (os === 'darwin') return 'launchd';
	if (os === 'linux') return 'systemd';
	return null;
}

export function serviceLogFile(): string {
	return path.join(kanbanHome(), 'service.log');
}

export function serviceUnitPath(kind: ServiceKind): string {
	return kind === 'launchd'
		? path.join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
		: path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(homedir(), '.config'), 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

/**
 * The interpreter path to write into the unit.
 *
 * `process.execPath` is fully resolved, which for a managed install means a
 * version-pinned real path — `/opt/homebrew/Cellar/node/26.6.0/bin/node`,
 * `~/.nvm/versions/node/v22.21.0/bin/node`. The next upgrade deletes it and the
 * always-on service dies at the one moment nobody is watching. If PATH holds a
 * stable symlink to this same binary, that is the one worth persisting.
 */
export function stableNodeBin(): string {
	const real = realpathSync(process.execPath);

	for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, 'node');
		try {
			if (realpathSync(candidate) === real && candidate !== real) return candidate;
		} catch {
			// Not a node on this PATH entry.
		}
	}
	return process.execPath;
}

/**
 * What the unit will contain if installed right now, from this process's own
 * interpreter, checkout and PATH.
 */
export function serviceSpec(options: { alwaysOn?: boolean; kind?: ServiceKind } = {}): ServiceSpec {
	const kind = options.kind ?? serviceKind();
	if (!kind) throw new Error(`No supported service manager for platform "${platform()}"`);

	const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.ts');
	const env: Record<string, string> = {
		[SERVICE_ENV_FLAG]: '1',
		PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
		HOME: homedir(),
	};
	// Carry the overrides that relocate the board, so a non-default setup keeps working
	// when the same board is started by the manager instead of by a shell.
	for (const key of ['ORCA_KANBAN_HOME', 'ORCA_KANBAN_CONFIG', 'ORCA_KANBAN_DB', 'ORCA_BIN']) {
		const value = process.env[key];
		if (value) env[key] = value;
	}

	return {
		kind,
		label: kind === 'launchd' ? SERVICE_LABEL : SYSTEMD_UNIT_NAME,
		unitPath: serviceUnitPath(kind),
		nodeBin: stableNodeBin(),
		cliPath,
		workingDir: path.dirname(path.dirname(cliPath)),
		logFile: serviceLogFile(),
		env,
		alwaysOn: options.alwaysOn ?? true,
	};
}

function xml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

export function renderLaunchAgent(spec: ServiceSpec): string {
	const envEntries = Object.entries(spec.env)
		.map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`)
		.join('\n');

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xml(SERVICE_LABEL)}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xml(spec.nodeBin)}</string>
\t\t<string>${xml(spec.cliPath)}</string>
\t\t<string>serve</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${xml(spec.workingDir)}</string>
\t<key>EnvironmentVariables</key>
\t<dict>
${envEntries}
\t</dict>
\t<key>RunAtLoad</key>
\t<${spec.alwaysOn ? 'true' : 'false'}/>
\t<key>KeepAlive</key>
\t<${spec.alwaysOn ? 'true' : 'false'}/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ProcessType</key>
\t<string>Interactive</string>
\t<key>StandardOutPath</key>
\t<string>${xml(spec.logFile)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(spec.logFile)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(spec: ServiceSpec): string {
	const env = Object.entries(spec.env)
		.map(([k, v]) => `Environment=${k}=${v}`)
		.join('\n');

	return `[Unit]
Description=Orca Kanban board and scheduler
After=graphical-session.target

[Service]
Type=simple
ExecStart=${spec.nodeBin} ${spec.cliPath} serve
WorkingDirectory=${spec.workingDir}
${env}
Restart=${spec.alwaysOn ? 'always' : 'no'}
RestartSec=10
StandardOutput=append:${spec.logFile}
StandardError=append:${spec.logFile}

[Install]
WantedBy=default.target
`;
}

export function renderUnit(spec: ServiceSpec): string {
	return spec.kind === 'launchd' ? renderLaunchAgent(spec) : renderSystemdUnit(spec);
}

type Run = { ok: boolean; stdout: string; stderr: string; code: number | null };

function run(command: string, args: string[]): Run {
	const result = spawnSync(command, args, { encoding: 'utf8' });
	if (result.error) return { ok: false, stdout: '', stderr: result.error.message, code: null };
	return {
		ok: result.status === 0,
		stdout: String(result.stdout ?? ''),
		stderr: String(result.stderr ?? ''),
		code: result.status,
	};
}

function launchDomain(): string {
	return `gui/${userInfo().uid}`;
}

function launchTarget(): string {
	return `${launchDomain()}/${SERVICE_LABEL}`;
}

/** Every manager call this module makes, so failures can be reported verbatim. */
export type ServiceAction = { command: string; ok: boolean; output: string };

function act(command: string, args: string[]): ServiceAction {
	const result = run(command, args);
	return {
		command: [command, ...args].join(' '),
		ok: result.ok,
		output: `${result.stdout}${result.stderr}`.trim(),
	};
}

/** Blocks without a timer, for the short waits launchd's asynchronous verbs need. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function installService(options: { alwaysOn?: boolean } = {}): {
	spec: ServiceSpec;
	actions: ServiceAction[];
} {
	const spec = serviceSpec(options);
	mkdirSync(path.dirname(spec.unitPath), { recursive: true });
	mkdirSync(path.dirname(spec.logFile), { recursive: true });
	writeFileSync(spec.unitPath, renderUnit(spec));

	const actions: ServiceAction[] = [];

	if (spec.kind === 'launchd') {
		// Unload first: bootstrap refuses a label that is already loaded, and an install
		// over an older unit is the normal case (upgrade, PATH change, autostart toggle).
		actions.push(act('launchctl', ['bootout', launchTarget()]));

		// `bootout` returns before the job is really gone, and bootstrapping a label the
		// domain is still unloading fails with a bare "Input/output error". Observed on
		// exactly this install path, so wait for the domain to forget it.
		for (let waited = 0; waited < 5_000 && run('launchctl', ['print', launchTarget()]).ok; waited += 100) {
			sleepSync(100);
		}

		actions.push(act('launchctl', ['bootstrap', launchDomain(), spec.unitPath]));
		if (!actions.at(-1)?.ok) {
			// One retry: the wait above covers the common case, and a second attempt costs
			// nothing next to leaving somebody with no service and a cryptic errno.
			sleepSync(750);
			actions.push(act('launchctl', ['bootstrap', launchDomain(), spec.unitPath]));
		}
		if (!actions.at(-1)?.ok) {
			throw new Error(`launchctl bootstrap failed: ${actions.at(-1)?.output || 'unknown error'}`);
		}
	} else {
		actions.push(act('systemctl', ['--user', 'daemon-reload']));
		// Without linger, a user unit dies at logout — "always running" would quietly
		// mean "while you are logged in".
		if (spec.alwaysOn) actions.push(act('loginctl', ['enable-linger', userInfo().username]));
		actions.push(
			act('systemctl', ['--user', ...(spec.alwaysOn ? ['enable', '--now'] : ['disable']), SYSTEMD_UNIT_NAME]),
		);
		if (!actions.at(-1)?.ok) {
			throw new Error(`systemctl failed: ${actions.at(-1)?.output || 'unknown error'}`);
		}
	}

	return { spec, actions };
}

export function uninstallService(): { actions: ServiceAction[]; removed: string | null } {
	const kind = serviceKind();
	if (!kind) throw new Error(`No supported service manager for platform "${platform()}"`);

	const unitPath = serviceUnitPath(kind);
	const actions: ServiceAction[] =
		kind === 'launchd'
			? [act('launchctl', ['bootout', launchTarget()])]
			: [
					act('systemctl', ['--user', 'stop', SYSTEMD_UNIT_NAME]),
					act('systemctl', ['--user', 'disable', SYSTEMD_UNIT_NAME]),
				];

	let removed: string | null = null;
	if (existsSync(unitPath)) {
		rmSync(unitPath);
		removed = unitPath;
	}
	if (kind === 'systemd') actions.push(act('systemctl', ['--user', 'daemon-reload']));

	return { actions, removed };
}

/** Starts a loaded-but-idle service (the `alwaysOn: false` shape). */
export function startService(): ServiceAction {
	const kind = serviceKind();
	if (kind === 'launchd') return act('launchctl', ['kickstart', launchTarget()]);
	if (kind === 'systemd') return act('systemctl', ['--user', 'start', SYSTEMD_UNIT_NAME]);
	throw new Error(`No supported service manager for platform "${platform()}"`);
}

/**
 * Stops the service.
 *
 * On launchd this unloads the unit, because a `KeepAlive` job cannot be "stopped" —
 * launchd would put it straight back. The unit file stays on disk, so `service start`
 * brings it back with the same settings.
 */
export function stopService(): ServiceAction {
	const kind = serviceKind();
	if (kind === 'launchd') return act('launchctl', ['bootout', launchTarget()]);
	if (kind === 'systemd') return act('systemctl', ['--user', 'stop', SYSTEMD_UNIT_NAME]);
	throw new Error(`No supported service manager for platform "${platform()}"`);
}

/** Asks the manager to restart the service (SIGTERM, then a fresh process). */
export function restartService(): ServiceAction {
	const kind = serviceKind();
	if (kind === 'launchd') return act('launchctl', ['kickstart', '-k', launchTarget()]);
	if (kind === 'systemd') return act('systemctl', ['--user', 'restart', SYSTEMD_UNIT_NAME]);
	throw new Error(`No supported service manager for platform "${platform()}"`);
}

/** Reads `alwaysOn` back from an installed unit, including one edited by hand. */
export function unitAlwaysOn(text: string, kind: ServiceKind): boolean {
	return kind === 'launchd'
		? /<key>KeepAlive<\/key>\s*<true\/>/.test(text)
		: /^Restart=always$/m.test(text);
}

export function serviceState(): ServiceState {
	const kind = serviceKind();
	const logFile = serviceLogFile();
	const selfManaged = process.env[SERVICE_ENV_FLAG] === '1';

	if (!kind) {
		return {
			kind: null,
			supported: false,
			selfManaged,
			unitPath: null,
			logFile,
			installed: false,
			alwaysOn: false,
			running: false,
			pid: null,
			lastExitStatus: null,
			detail: `No supported service manager for platform "${platform()}"`,
		};
	}

	const unitPath = serviceUnitPath(kind);
	const installed = existsSync(unitPath);
	const base = { kind, supported: true, selfManaged, unitPath, logFile, installed };

	if (!installed) {
		return {
			...base,
			alwaysOn: false,
			running: false,
			pid: null,
			lastExitStatus: null,
			detail: 'not installed',
		};
	}

	let alwaysOn = false;
	try {
		alwaysOn = unitAlwaysOn(readFileSync(unitPath, 'utf8'), kind);
	} catch {
		// An unreadable unit is reported as installed-but-unknown rather than crashing
		// the status call somebody is running *because* something is wrong.
	}

	if (kind === 'launchd') {
		const listed = run('launchctl', ['list', SERVICE_LABEL]);
		if (!listed.ok) {
			return { ...base, alwaysOn, running: false, pid: null, lastExitStatus: null, detail: 'installed, not loaded' };
		}
		const pid = /"PID"\s*=\s*(\d+)/.exec(listed.stdout);
		const exit = /"LastExitStatus"\s*=\s*(-?\d+)/.exec(listed.stdout);
		return {
			...base,
			alwaysOn,
			running: pid !== null,
			pid: pid ? Number(pid[1]) : null,
			lastExitStatus: exit ? Number(exit[1]) : null,
			detail: pid ? `running (pid ${pid[1]})` : 'loaded, not running',
		};
	}

	const shown = run('systemctl', [
		'--user',
		'show',
		SYSTEMD_UNIT_NAME,
		'--property=ActiveState',
		'--property=MainPID',
		'--property=ExecMainStatus',
	]);
	const props: Record<string, string> = {};
	for (const line of shown.stdout.split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1).trim();
	}
	const pid = Number(props['MainPID'] ?? '0');
	return {
		...base,
		alwaysOn,
		running: props['ActiveState'] === 'active',
		pid: Number.isFinite(pid) && pid > 0 ? pid : null,
		lastExitStatus: props['ExecMainStatus'] === undefined ? null : Number(props['ExecMainStatus']),
		detail: props['ActiveState'] ?? (shown.stderr.trim() || 'unknown'),
	};
}
