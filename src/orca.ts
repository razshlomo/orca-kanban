import { execFile } from 'node:child_process';

export type OrcaEnvelope<T> = {
	id?: string;
	ok: boolean;
	result?: T;
	error?: { code: string; message: string; data?: unknown };
};

export type OrcaWorktree = {
	id: string;
	path: string;
	branch: string;
	repoId?: string;
	displayName?: string;
	workspaceStatus?: string;
	sortOrder?: number;
	comment?: string;
	/** Present when the worktree was created with `--agent`. */
	agentTerminalHandle?: string | null;
};

/**
 * One agent Orca is tracking inside a worktree, as reported by `worktree ps`.
 *
 * `state` is Orca's own agent lifecycle (observed: `working` -> `done`) and
 * `lastAssistantMessage` is the agent's final response. Together these remove any
 * need to scrape terminal output to decide a card is finished.
 */
export type OrcaAgentInfo = {
	paneKey: string | null;
	state: string | null;
	agentType: string | null;
	prompt: string | null;
	lastAssistantMessage: string | null;
	interrupted: boolean;
	updatedAt: number | null;
};

/** A row of `orca worktree ps` — the orchestration summary across worktrees. */
export type OrcaWorktreeStatus = {
	worktreeId: string;
	path: string;
	branch: string;
	displayName: string;
	workspaceStatus: string | null;
	sortOrder: number | null;
	comment: string;
	/** Worktree-level activity: observed `working` | `active` | `inactive`. */
	status: string | null;
	isArchived: boolean;
	liveTerminalCount: number;
	lastOutputAt: number | null;
	preview: string;
	agents: OrcaAgentInfo[];
};

export type OrcaTerminal = {
	handle: string;
	worktreeId?: string;
	worktreePath?: string;
	branch?: string;
	title?: string;
	connected?: boolean;
	status?: string;
	lastOutputAt?: number;
	preview?: string;
	tabId?: string;
};

export type OrcaReadResult = {
	handle: string;
	status: string;
	tail: string[];
	nextCursor: string | null;
	latestCursor: string | null;
	oldestCursor: string | null;
	truncated?: boolean;
};

export type OrcaWaitResult = {
	handle: string;
	condition: string;
	satisfied: boolean;
	status: string | null;
	exitCode: number | null;
	/** True when the CLI returned its `timeout` error instead of a satisfied wait. */
	timedOut: boolean;
};

/** The Orca surface the scheduler depends on. Faked wholesale in tests. */
export type OrcaApi = {
	status(): Promise<{ runtimeReachable: boolean; appRunning: boolean; appVersion: string | null }>;
	repoList(): Promise<Array<{ id: string; path: string; displayName: string; kind: string }>>;
	resolveRepo(selector: string): Promise<{ id: string; path: string }>;
	/**
	 * Agent-first worktree creation. Passing `agentId` makes Orca launch the agent
	 * in the worktree's first terminal and deliver `prompt` to it — the documented
	 * path, and the one that avoids a stray fallback shell.
	 */
	worktreeCreate(options: {
		repoSelector: string;
		name: string;
		baseBranch?: string | null;
		comment?: string | null;
		agentId?: string | null;
		prompt?: string | null;
		setup?: 'run' | 'skip' | 'inherit';
	}): Promise<OrcaWorktree>;
	worktreeRemove(selector: string): Promise<void>;
	/** Orchestration summary across worktrees, including native agent state. */
	worktreePs(): Promise<OrcaWorktreeStatus[]>;
	/** Moves a card on Orca's own board and/or updates its progress comment. */
	worktreeSet(options: {
		selector: string;
		workspaceStatus?: string | null;
		comment?: string | null;
		displayName?: string | null;
	}): Promise<void>;
	terminalCreate(options: {
		worktreeSelector: string;
		title?: string;
		command?: string;
		focus?: boolean;
	}): Promise<OrcaTerminal>;
	terminalSend(options: {
		handle: string;
		text?: string;
		enter?: boolean;
		interrupt?: boolean;
	}): Promise<void>;
	terminalWait(options: {
		handle: string;
		condition: 'exit' | 'tui-idle';
		timeoutMs: number;
	}): Promise<OrcaWaitResult>;
	terminalRead(options: { handle: string; cursor?: string | null; limit?: number }): Promise<OrcaReadResult>;
	terminalShow(handle: string): Promise<OrcaTerminal | null>;
	terminalList(): Promise<OrcaTerminal[]>;
	terminalClose(options: { handle: string; tab?: boolean }): Promise<void>;
};

export class OrcaCliError extends Error {
	readonly code: string;
	readonly command: string[];

	constructor(message: string, code: string, command: string[]) {
		super(message);
		this.name = 'OrcaCliError';
		this.code = code;
		this.command = command;
	}
}

/**
 * Thin typed wrapper over the `orca` CLI.
 *
 * Orca ships no importable SDK — the packaged app is code-signed and its runtime
 * is reachable only through this CLI, which speaks a stable
 * `{ id, ok, result | error }` JSON envelope (schema v1).
 */
export class OrcaCli implements OrcaApi {
	private readonly bin: string;
	private readonly defaultTimeoutMs: number;

	constructor(options: { bin?: string; timeoutMs?: number } = {}) {
		this.bin = options.bin ?? process.env.ORCA_BIN ?? 'orca';
		this.defaultTimeoutMs = options.timeoutMs ?? 60_000;
	}

	/** Runs an orca subcommand and unwraps the JSON envelope. */
	private exec<T>(args: string[], options: { timeoutMs?: number; allowErrorCodes?: string[] } = {}): Promise<OrcaEnvelope<T>> {
		const argv = [...args, '--json'];
		const timeout = options.timeoutMs ?? this.defaultTimeoutMs;
		const { promise, resolve, reject } = Promise.withResolvers<OrcaEnvelope<T>>();

		execFile(this.bin, argv, { timeout, maxBuffer: 32 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
			const text = String(stdout ?? '').trim();
			let envelope: OrcaEnvelope<T> | null = null;

			if (text) {
				try {
					envelope = JSON.parse(text) as OrcaEnvelope<T>;
				} catch {
					// Some subcommands print a banner before the JSON; retry from the first brace.
					const start = text.indexOf('{');
					if (start >= 0) {
						try {
							envelope = JSON.parse(text.slice(start)) as OrcaEnvelope<T>;
						} catch {
							envelope = null;
						}
					}
				}
			}

			if (envelope) {
				if (!envelope.ok) {
					const code = envelope.error?.code ?? 'unknown';
					if (options.allowErrorCodes?.includes(code)) resolve(envelope);
					else
						reject(
							new OrcaCliError(envelope.error?.message ?? `orca ${args.join(' ')} failed (${code})`, code, argv),
						);
					return;
				}
				resolve(envelope);
				return;
			}

			if (err) {
				const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
				reject(
					new OrcaCliError(
						`orca ${args.join(' ')} failed: ${err.message}${stderr ? ` | ${String(stderr).trim()}` : ''}`,
						timedOut ? 'cli_timeout' : 'cli_error',
						argv,
					),
				);
				return;
			}

			reject(new OrcaCliError(`orca ${args.join(' ')} returned no JSON`, 'no_json', argv));
		});

		return promise;
	}

	async status(): Promise<{ runtimeReachable: boolean; appRunning: boolean; appVersion: string | null }> {
		const env = await this.exec<{
			app?: { running?: boolean };
			runtime?: { reachable?: boolean; appVersion?: string };
		}>(['status']);
		return {
			runtimeReachable: env.result?.runtime?.reachable === true,
			appRunning: env.result?.app?.running === true,
			appVersion: env.result?.runtime?.appVersion ?? null,
		};
	}

	async repoList(): Promise<Array<{ id: string; path: string; displayName: string; kind: string }>> {
		const env = await this.exec<{ repos?: Array<Record<string, unknown>> }>(['repo', 'list']);
		return (env.result?.repos ?? []).map((r) => ({
			id: String(r['id']),
			path: String(r['path']),
			displayName: String(r['displayName'] ?? ''),
			kind: String(r['kind'] ?? ''),
		}));
	}

	/**
	 * Accepts an Orca selector (`id:...`, `path:...`) or a bare filesystem path and
	 * returns the registered repo, adding it to Orca when a path is not known yet.
	 */
	async resolveRepo(selector: string): Promise<{ id: string; path: string }> {
		const repos = await this.repoList();

		if (selector.startsWith('id:')) {
			const id = selector.slice(3);
			const hit = repos.find((r) => r.id === id);
			if (!hit) throw new OrcaCliError(`Unknown Orca repo id ${id}`, 'repo_not_found', ['repo', 'list']);
			return { id: hit.id, path: hit.path };
		}

		const wanted = selector.startsWith('path:') ? selector.slice(5) : selector;
		const hit = repos.find((r) => r.path === wanted);
		if (hit) return { id: hit.id, path: hit.path };

		const env = await this.exec<{ repo?: Record<string, unknown> }>(['repo', 'add', '--path', wanted]);
		const repo = env.result?.repo;
		if (!repo) throw new OrcaCliError(`Could not register repo ${wanted}`, 'repo_add_failed', ['repo', 'add']);
		return { id: String(repo['id']), path: String(repo['path']) };
	}

	async worktreeCreate(options: {
		repoSelector: string;
		name: string;
		baseBranch?: string | null;
		comment?: string | null;
		agentId?: string | null;
		prompt?: string | null;
		setup?: 'run' | 'skip' | 'inherit';
	}): Promise<OrcaWorktree> {
		const args = [
			'worktree',
			'create',
			'--repo',
			options.repoSelector,
			'--name',
			options.name,
			'--no-parent',
			'--setup',
			options.setup ?? 'inherit',
		];
		if (options.baseBranch) args.push('--base-branch', options.baseBranch);
		if (options.comment) args.push('--comment', options.comment);
		// Agent-first: Orca starts the agent and hands it the prompt itself.
		if (options.agentId) args.push('--agent', options.agentId);
		if (options.prompt) args.push('--prompt', options.prompt);

		const env = await this.exec<{
			worktree?: Record<string, unknown>;
			agentTerminalHandle?: string;
			startupTerminal?: Record<string, unknown>;
		}>(args, { timeoutMs: 300_000 });

		const wt = env.result?.worktree;
		if (!wt) throw new OrcaCliError('worktree create returned no worktree', 'no_worktree', args);

		// Newer runtimes return agentTerminalHandle; older ones only startupTerminal.
		const handle = env.result?.agentTerminalHandle ?? env.result?.startupTerminal?.['handle'];

		return {
			id: String(wt['id']),
			path: String(wt['path']),
			branch: String(wt['branch'] ?? ''),
			repoId: wt['repoId'] ? String(wt['repoId']) : undefined,
			displayName: wt['displayName'] ? String(wt['displayName']) : undefined,
			workspaceStatus: wt['workspaceStatus'] ? String(wt['workspaceStatus']) : undefined,
			sortOrder: wt['sortOrder'] === undefined ? undefined : Number(wt['sortOrder']),
			comment: wt['comment'] ? String(wt['comment']) : undefined,
			agentTerminalHandle: handle ? String(handle) : null,
		};
	}

	async worktreeRemove(selector: string): Promise<void> {
		await this.exec(['worktree', 'rm', '--worktree', selector, '--force'], {
			timeoutMs: 120_000,
			allowErrorCodes: ['selector_not_found', 'not_found'],
		});
	}

	async worktreePs(): Promise<OrcaWorktreeStatus[]> {
		const env = await this.exec<{ worktrees?: Array<Record<string, unknown>> }>(['worktree', 'ps'], {
			timeoutMs: 60_000,
		});

		return (env.result?.worktrees ?? []).map((w) => ({
			worktreeId: String(w['worktreeId'] ?? w['id'] ?? ''),
			path: String(w['path'] ?? ''),
			branch: String(w['branch'] ?? ''),
			displayName: String(w['displayName'] ?? ''),
			workspaceStatus: w['workspaceStatus'] ? String(w['workspaceStatus']) : null,
			sortOrder: w['sortOrder'] === undefined || w['sortOrder'] === null ? null : Number(w['sortOrder']),
			comment: String(w['comment'] ?? ''),
			status: w['status'] ? String(w['status']) : null,
			isArchived: w['isArchived'] === true,
			liveTerminalCount: Number(w['liveTerminalCount'] ?? 0),
			lastOutputAt: w['lastOutputAt'] ? Number(w['lastOutputAt']) : null,
			preview: String(w['preview'] ?? ''),
			agents: (Array.isArray(w['agents']) ? (w['agents'] as Array<Record<string, unknown>>) : []).map((a) => ({
				paneKey: a['paneKey'] ? String(a['paneKey']) : null,
				state: a['state'] ? String(a['state']) : null,
				agentType: a['agentType'] ? String(a['agentType']) : null,
				prompt: a['prompt'] ? String(a['prompt']) : null,
				lastAssistantMessage: a['lastAssistantMessage'] ? String(a['lastAssistantMessage']) : null,
				interrupted: a['interrupted'] === true,
				updatedAt: a['updatedAt'] ? Number(a['updatedAt']) : null,
			})),
		}));
	}

	async worktreeSet(options: {
		selector: string;
		workspaceStatus?: string | null;
		comment?: string | null;
		displayName?: string | null;
	}): Promise<void> {
		const args = ['worktree', 'set', '--worktree', options.selector];
		if (options.workspaceStatus) args.push('--workspace-status', options.workspaceStatus);
		if (options.comment !== undefined && options.comment !== null) args.push('--comment', options.comment);
		if (options.displayName) args.push('--display-name', options.displayName);
		if (args.length === 4) return;

		await this.exec(args, { timeoutMs: 60_000, allowErrorCodes: ['selector_not_found', 'not_found'] });
	}

	async terminalCreate(options: {
		worktreeSelector: string;
		title?: string;
		command?: string;
		focus?: boolean;
	}): Promise<OrcaTerminal> {
		const args = ['terminal', 'create', '--worktree', options.worktreeSelector];
		if (options.title) args.push('--title', options.title);
		if (options.command) args.push('--command', options.command);
		if (options.focus) args.push('--focus');

		const env = await this.exec<{ terminal?: Record<string, unknown>; handle?: string }>(args, { timeoutMs: 120_000 });
		const handle = env.result?.terminal?.['handle'] ?? env.result?.handle;
		if (!handle) throw new OrcaCliError('terminal create returned no handle', 'no_handle', args);

		const t = env.result?.terminal ?? {};
		return {
			handle: String(handle),
			worktreeId: t['worktreeId'] ? String(t['worktreeId']) : undefined,
			worktreePath: t['worktreePath'] ? String(t['worktreePath']) : undefined,
			branch: t['branch'] ? String(t['branch']) : undefined,
			title: t['title'] ? String(t['title']) : undefined,
			tabId: t['tabId'] ? String(t['tabId']) : undefined,
		};
	}

	async terminalSend(options: { handle: string; text?: string; enter?: boolean; interrupt?: boolean }): Promise<void> {
		const args = ['terminal', 'send', '--terminal', options.handle];
		if (options.text !== undefined) args.push('--text', options.text);
		if (options.enter) args.push('--enter');
		if (options.interrupt) args.push('--interrupt');
		await this.exec(args);
	}

	/**
	 * Waits on Orca's own terminal state. A CLI `timeout` error is a normal
	 * outcome (the condition simply did not happen yet), so it is reported as
	 * `satisfied: false` instead of throwing.
	 */
	async terminalWait(options: {
		handle: string;
		condition: 'exit' | 'tui-idle';
		timeoutMs: number;
	}): Promise<OrcaWaitResult> {
		const args = [
			'terminal',
			'wait',
			'--terminal',
			options.handle,
			'--for',
			options.condition,
			'--timeout-ms',
			String(options.timeoutMs),
		];

		const env = await this.exec<{ wait?: Record<string, unknown> }>(args, {
			timeoutMs: options.timeoutMs + 30_000,
			allowErrorCodes: ['timeout'],
		});

		if (!env.ok) {
			return {
				handle: options.handle,
				condition: options.condition,
				satisfied: false,
				status: null,
				exitCode: null,
				timedOut: true,
			};
		}

		const w = env.result?.wait ?? {};
		return {
			handle: String(w['handle'] ?? options.handle),
			condition: String(w['condition'] ?? options.condition),
			satisfied: w['satisfied'] === true,
			status: w['status'] ? String(w['status']) : null,
			exitCode: w['exitCode'] === null || w['exitCode'] === undefined ? null : Number(w['exitCode']),
			timedOut: false,
		};
	}

	async terminalRead(options: { handle: string; cursor?: string | null; limit?: number }): Promise<OrcaReadResult> {
		const args = ['terminal', 'read', '--terminal', options.handle];
		if (options.cursor) args.push('--cursor', String(options.cursor));
		if (options.limit) args.push('--limit', String(options.limit));

		const env = await this.exec<{ terminal?: Record<string, unknown> }>(args);
		const t = env.result?.terminal ?? {};
		return {
			handle: String(t['handle'] ?? options.handle),
			status: String(t['status'] ?? 'unknown'),
			tail: Array.isArray(t['tail']) ? (t['tail'] as unknown[]).map(String) : [],
			nextCursor: t['nextCursor'] === undefined || t['nextCursor'] === null ? null : String(t['nextCursor']),
			latestCursor: t['latestCursor'] === undefined || t['latestCursor'] === null ? null : String(t['latestCursor']),
			oldestCursor: t['oldestCursor'] === undefined || t['oldestCursor'] === null ? null : String(t['oldestCursor']),
			truncated: t['truncated'] === true,
		};
	}

	async terminalShow(handle: string): Promise<OrcaTerminal | null> {
		try {
			const env = await this.exec<{ terminal?: Record<string, unknown> }>(['terminal', 'show', '--terminal', handle]);
			const t = env.result?.terminal;
			if (!t) return null;
			return {
				handle: String(t['handle'] ?? handle),
				worktreeId: t['worktreeId'] ? String(t['worktreeId']) : undefined,
				worktreePath: t['worktreePath'] ? String(t['worktreePath']) : undefined,
				branch: t['branch'] ? String(t['branch']) : undefined,
				title: t['title'] ? String(t['title']) : undefined,
				connected: t['connected'] === true,
				lastOutputAt: t['lastOutputAt'] ? Number(t['lastOutputAt']) : undefined,
				preview: t['preview'] ? String(t['preview']) : undefined,
			};
		} catch (err) {
			if (err instanceof OrcaCliError && /not_found|selector/.test(err.code)) return null;
			throw err;
		}
	}

	async terminalList(): Promise<OrcaTerminal[]> {
		const env = await this.exec<{ terminals?: Array<Record<string, unknown>> }>(['terminal', 'list']);
		return (env.result?.terminals ?? []).map((t) => ({
			handle: String(t['handle']),
			worktreeId: t['worktreeId'] ? String(t['worktreeId']) : undefined,
			worktreePath: t['worktreePath'] ? String(t['worktreePath']) : undefined,
			branch: t['branch'] ? String(t['branch']) : undefined,
			title: t['title'] ? String(t['title']) : undefined,
			connected: t['connected'] === true,
			lastOutputAt: t['lastOutputAt'] ? Number(t['lastOutputAt']) : undefined,
			preview: t['preview'] ? String(t['preview']) : undefined,
		}));
	}

	async terminalClose(options: { handle: string; tab?: boolean }): Promise<void> {
		const args = ['terminal', 'close', '--terminal', options.handle];
		if (options.tab !== false) args.push('--tab');
		await this.exec(args, { timeoutMs: 60_000, allowErrorCodes: ['selector_not_found', 'not_found'] });
	}
}
