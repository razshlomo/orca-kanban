import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import type { AgentConfig, CardState, KanbanConfig, ModelChoice } from './types.ts';

/**
 * Home for the board database, config, and logs.
 * Override with ORCA_KANBAN_HOME (the test suite relies on this).
 */
export function kanbanHome(): string {
	return process.env.ORCA_KANBAN_HOME ?? path.join(homedir(), '.orca-kanban');
}

/**
 * Agents are Orca's own agent ids. Orca launches them itself via
 * `orca worktree create --agent <id> --prompt <text>`, which is the documented
 * agent-first path and delivers the prompt without touching the TUI.
 *
 * `modelCommand` is the exception to that path. Orca has no way to carry a model —
 * `worktree create` takes `--agent` and `--prompt` and nothing else — so a card that
 * names a model is launched as a plain terminal command instead. Orca still tracks it:
 * `worktree ps` reports `agents[].state` for any terminal running a known agent, which
 * is what the executor watches. An agent with no `modelCommand`/`modelsCommand` cannot
 * be asked for a model, and such a card is refused rather than run on the wrong one.
 */
export const DEFAULT_AGENTS: Record<string, AgentConfig> = {
	// `--continue` resumes the newest session for the current directory, and every card
	// runs in its own worktree, so this reopens that card's conversation and no other.
	omp: {
		orcaAgentId: 'omp',
		fallbackCommand: 'omp --auto-approve {{promptFileRel}}',
		resumeCommand: 'omp --continue',
		modelCommand: 'omp --auto-approve --model {{model}} {{promptFileRel}}',
		modelsCommand: 'omp models --json',
		modelsFormat: 'json',
		modelsRefreshCommand: 'omp models refresh',
	},
	codex: {
		orcaAgentId: 'codex',
		fallbackCommand: null,
		resumeCommand: 'codex resume --last',
		modelCommand: null,
		modelsCommand: null,
		modelsFormat: 'lines',
		modelsRefreshCommand: null,
	},
	claude: {
		orcaAgentId: 'claude',
		fallbackCommand: null,
		resumeCommand: 'claude --continue',
		modelCommand: null,
		modelsCommand: null,
		modelsFormat: 'lines',
		modelsRefreshCommand: null,
	},
	cursor: {
		orcaAgentId: 'cursor',
		fallbackCommand: null,
		resumeCommand: null,
		modelCommand: null,
		modelsCommand: null,
		modelsFormat: 'lines',
		modelsRefreshCommand: null,
	},
	opencode: {
		orcaAgentId: 'opencode',
		fallbackCommand: null,
		resumeCommand: null,
		modelCommand: null,
		modelsCommand: null,
		modelsFormat: 'lines',
		modelsRefreshCommand: null,
	},
	pi: {
		orcaAgentId: 'pi',
		fallbackCommand: null,
		resumeCommand: null,
		modelCommand: null,
		modelsCommand: null,
		modelsFormat: 'lines',
		modelsRefreshCommand: null,
	},
};

/**
 * The model menu, by name rather than by version.
 *
 * Model versions move every few weeks, so pinning `claude-opus-5` here would make this
 * list wrong by the next release. Each entry says which family it means and the newest
 * matching model in the agent's own catalog wins — `opus` was Opus 4.5 in November and
 * is Opus 5 now, with nothing to edit in between.
 *
 * `astra` is deliberately listed before it exists. Until the agent's catalog has it,
 * picking it is refused with that reason; the day it ships, `kanban models --refresh`
 * is the whole migration.
 */
export const DEFAULT_MODEL_CHOICES: ModelChoice[] = [
	{ id: 'fable', label: 'Fable', match: 'claude-fable', providers: ['anthropic'] },
	{ id: 'opus', label: 'Opus', match: 'claude-opus', providers: ['anthropic'] },
	{ id: 'sonnet', label: 'Sonnet', match: 'claude-sonnet', providers: ['anthropic'] },
	{ id: 'haiku', label: 'Haiku', match: 'claude-haiku', providers: ['anthropic'] },
	{ id: 'sol', label: 'Sol (codex)', match: 'sol', providers: ['openai-codex'] },
	// Shipped as openai-codex/gpt-6-astra. `match` stays the bare name so the next
	// version of it resolves without touching this list.
	{ id: 'astra', label: 'Astra (codex)', match: 'astra', providers: ['openai-codex'] },
];

/**
 * Card state -> Orca workspaceStatus id.
 *
 * Orca's defaults are todo / in-progress / in-review / completed, and it accepts
 * custom ids (verified), so Backlog/Ready/Blocked map to their own columns.
 */
export const DEFAULT_ORCA_STATUS_MAP: Record<CardState, string> = {
	Backlog: 'backlog',
	Ready: 'ready',
	'In Progress': 'in-progress',
	Review: 'in-review',
	Done: 'completed',
	Blocked: 'blocked',
};

export const DEFAULT_CONFIG: KanbanConfig = {
	enabled: true,
	autoRun: false,
	pollIntervalMs: 2000,
	maxConcurrent: 1,
	defaultAgent: 'omp',
	maxAttempts: 2,
	successState: 'Review',
	landOnApprove: 'commit',
	verifyCommand: null,
	defaultRepo: null,
	baseBranch: null,
	setupPolicy: 'inherit',
	removeWorktreeOnSuccess: false,
	closeSessionWhenDone: true,
	mirrorToOrcaBoard: true,
	orcaStatusMap: DEFAULT_ORCA_STATUS_MAP,
	// Orca reports no agent for the first seconds after launch; ignore state until then.
	startupGraceMs: 12_000,
	agentPollIntervalMs: 4000,
	doneConfirmations: 2,
	// Orca reports `done` between steps and the agent writes its result file last,
	// so give that file a real chance to appear before failing the card.
	resultGraceMs: 180_000,
	cardTimeoutMs: 45 * 60 * 1000,
	workerId: `${hostname()}:${process.pid}`,
	port: 7420,
	recoveryPolicy: 'ready',
	orchestration: {
		enabled: true,
		objective: 'Orca Kanban sequential card execution',
		runId: null,
	},
	agents: DEFAULT_AGENTS,
	models: { default: 'opus', choices: DEFAULT_MODEL_CHOICES },
};

export function configPath(): string {
	return process.env.ORCA_KANBAN_CONFIG ?? path.join(kanbanHome(), 'config.json');
}

type RawConfig = Record<string, unknown>;

/**
 * Reads config.json without deciding what a failure means.
 *
 * Both a flat object and a `{ kanban: {...}, agents: {...} }` shape are accepted so
 * the documented YAML-style layout maps 1:1 onto JSON.
 */
export function readConfigFile(file: string = configPath()): { raw: RawConfig; error: string | null } {
	if (!existsSync(file)) return { raw: {}, error: null };

	try {
		const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { raw: {}, error: `Invalid config at ${file}: expected a JSON object` };
		}
		const raw = { ...(parsed as RawConfig) };
		const nested = raw['kanban'];
		delete raw['kanban'];
		return {
			raw: { ...(nested && typeof nested === 'object' ? (nested as RawConfig) : {}), ...raw },
			error: null,
		};
	} catch (err) {
		return { raw: {}, error: `Invalid config at ${file}: ${(err as Error).message}` };
	}
}

/** Layers file values, then explicit overrides, over the defaults. */
export function mergeConfig(onDisk: Partial<KanbanConfig>, overrides: Partial<KanbanConfig> = {}): KanbanConfig {
	const agents: Record<string, AgentConfig> = { ...DEFAULT_AGENTS };
	for (const source of [onDisk.agents, overrides.agents]) {
		for (const [name, cfg] of Object.entries(source ?? {})) {
			agents[name] = {
				...(agents[name] ?? {
					orcaAgentId: name,
					fallbackCommand: null,
					resumeCommand: null,
					modelCommand: null,
								modelsCommand: null,
					modelsFormat: 'lines',
					modelsRefreshCommand: null,
				}),
				...cfg,
			};
		}
	}

	// A menu given on disk REPLACES the shipped one rather than merging into it:
	// removing an entry is the whole point of writing your own list, and a merge would
	// keep resurrecting the defaults you deleted.
	const models = {
		...DEFAULT_CONFIG.models,
		...onDisk.models,
		...overrides.models,
	};

	return {
		...DEFAULT_CONFIG,
		...onDisk,
		...overrides,
		orcaStatusMap: { ...DEFAULT_ORCA_STATUS_MAP, ...onDisk.orcaStatusMap, ...overrides.orcaStatusMap },
		orchestration: { ...DEFAULT_CONFIG.orchestration, ...onDisk.orchestration, ...overrides.orchestration },
		agents,
		models,
	};
}

/**
 * The invariants a running board depends on. Kept separate from loading so a
 * candidate config can be checked *before* it is written to disk — the service must
 * never be handed a config.json that stops it booting.
 */
export function validateConfig(merged: KanbanConfig): KanbanConfig {
	if (!merged.agents[merged.defaultAgent]) {
		throw new Error(
			`defaultAgent "${merged.defaultAgent}" is not defined under agents (have: ${Object.keys(merged.agents).join(', ')})`,
		);
	}
	if (merged.maxAttempts < 1) throw new Error('maxAttempts must be >= 1');
	if (merged.maxConcurrent < 1) throw new Error('maxConcurrent must be >= 1');
	if (!Number.isInteger(merged.maxConcurrent)) throw new Error('maxConcurrent must be a whole number of slots');
	if (merged.pollIntervalMs < 100) throw new Error('pollIntervalMs must be >= 100');
	if (merged.doneConfirmations < 1) throw new Error('doneConfirmations must be >= 1');
	if (merged.resultGraceMs < 0) throw new Error('resultGraceMs must be >= 0');
	if (!Number.isInteger(merged.port) || merged.port < 1 || merged.port > 65_535) {
		throw new Error('port must be a whole number between 1 and 65535');
	}

	const ids = merged.models.choices.map((c) => c.id);
	for (const choice of merged.models.choices) {
		if (!choice.id || !choice.label) throw new Error('every models.choices entry needs an id and a label');
		if (!choice.match && !choice.selector) {
			throw new Error(`models.choices "${choice.id}" needs either match (newest wins) or selector (pinned)`);
		}
	}
	if (new Set(ids).size !== ids.length) throw new Error(`models.choices has duplicate ids: ${ids.join(', ')}`);
	if (merged.models.default !== null && !ids.includes(merged.models.default)) {
		throw new Error(`models.default "${merged.models.default}" is not one of models.choices (have: ${ids.join(', ')})`);
	}
	return merged;
}

/**
 * Reads config.json and layers it over DEFAULT_CONFIG. Throws on a file that cannot
 * be parsed or a config that breaks an invariant.
 */
export function loadConfig(overrides: Partial<KanbanConfig> = {}): KanbanConfig {
	const { raw, error } = readConfigFile();
	if (error) throw new Error(error);
	return validateConfig(mergeConfig(raw as Partial<KanbanConfig>, overrides));
}

/**
 * Same, but reports a broken config instead of throwing.
 *
 * A long-running board is the thing you would use to *fix* a bad config, so it must
 * not be the thing a bad config kills: `serve` starts on defaults and shows the
 * error, rather than crash-looping under a service manager with no UI to repair it.
 */
export function loadConfigSafe(overrides: Partial<KanbanConfig> = {}): {
	config: KanbanConfig;
	error: string | null;
} {
	const { raw, error } = readConfigFile();
	if (error) return { config: validateConfig(mergeConfig({}, overrides)), error };

	try {
		return { config: validateConfig(mergeConfig(raw as Partial<KanbanConfig>, overrides)), error: null };
	} catch (err) {
		return { config: validateConfig(mergeConfig({}, overrides)), error: (err as Error).message };
	}
}

/**
 * The fields the board exposes for editing at runtime (UI and `PATCH /api/config`).
 *
 * `hot` is the honest half of this table. Every consumer reads its value off the one
 * shared config object at the moment it needs it — the executor asks for
 * `config.cardTimeoutMs` per card, the scheduler for `config.maxConcurrent` per pass —
 * so those fields take effect in place. The rest are captured once at boot (the HTTP
 * port is bound, the orchestration client is constructed) and are honest about needing
 * a restart rather than silently doing nothing.
 */
export type ConfigFieldSpec = {
	kind: 'boolean' | 'number' | 'string' | 'enum';
	/** Allowed values for `enum`. */
	values?: string[];
	/** `null` clears the field (no repo, no verify gate, …). */
	nullable?: boolean;
	min?: number;
	max?: number;
	integer?: boolean;
	/** Applies to the live process without a restart. */
	hot: boolean;
	label: string;
};

/** Key order is the order the UI renders them in. */
export const EDITABLE_FIELDS: Record<string, ConfigFieldSpec> = {
	enabled: { kind: 'boolean', hot: true, label: 'Board enabled' },
	autoRun: { kind: 'boolean', hot: true, label: 'Auto-run cards' },
	maxConcurrent: { kind: 'number', min: 1, integer: true, hot: true, label: 'Concurrent cards' },
	defaultAgent: { kind: 'string', hot: true, label: 'Default agent' },
	// Validated against models.choices by validateConfig, so a typo is refused before
	// it reaches disk rather than silently blocking every new card.
	'models.default': { kind: 'string', nullable: true, hot: true, label: 'Default model' },
	defaultRepo: { kind: 'string', nullable: true, hot: true, label: 'Default repo' },
	baseBranch: { kind: 'string', nullable: true, hot: true, label: 'Base branch' },
	maxAttempts: { kind: 'number', min: 1, integer: true, hot: true, label: 'Attempts per card' },
	successState: { kind: 'enum', values: ['Review', 'Done'], hot: true, label: 'Success lands in' },
	landOnApprove: { kind: 'enum', values: ['commit', 'off'], hot: true, label: 'On approve' },
	verifyCommand: { kind: 'string', nullable: true, hot: true, label: 'Verify before land' },
	setupPolicy: { kind: 'enum', values: ['run', 'skip', 'inherit'], hot: true, label: 'Worktree setup hook' },
	recoveryPolicy: { kind: 'enum', values: ['ready', 'blocked'], hot: true, label: 'Stranded cards go to' },
	removeWorktreeOnSuccess: { kind: 'boolean', hot: true, label: 'Remove worktree on success' },
	closeSessionWhenDone: { kind: 'boolean', hot: true, label: 'Close session when done' },
	mirrorToOrcaBoard: { kind: 'boolean', hot: true, label: 'Mirror to Orca board' },
	pollIntervalMs: { kind: 'number', min: 100, integer: true, hot: true, label: 'Board poll (ms)' },
	agentPollIntervalMs: { kind: 'number', min: 250, integer: true, hot: true, label: 'Agent poll (ms)' },
	startupGraceMs: { kind: 'number', min: 0, integer: true, hot: true, label: 'Agent startup grace (ms)' },
	doneConfirmations: { kind: 'number', min: 1, integer: true, hot: true, label: 'Done confirmations' },
	resultGraceMs: { kind: 'number', min: 0, integer: true, hot: true, label: 'Result file grace (ms)' },
	cardTimeoutMs: { kind: 'number', min: 60_000, integer: true, hot: true, label: 'Card timeout (ms)' },
	'orchestration.objective': { kind: 'string', hot: true, label: 'Orchestration objective' },
	// Bound / constructed once at boot.
	port: { kind: 'number', min: 1, max: 65_535, integer: true, hot: false, label: 'HTTP port' },
	'orchestration.enabled': { kind: 'boolean', hot: false, label: 'Orca orchestration' },
};

/** Reads a dotted key (`orchestration.enabled`) out of a config-shaped object. */
export function readConfigField(source: Record<string, unknown>, key: string): unknown {
	let cursor: unknown = source;
	for (const part of key.split('.')) {
		if (!cursor || typeof cursor !== 'object') return undefined;
		cursor = (cursor as Record<string, unknown>)[part];
	}
	return cursor;
}

/** Writes a dotted key into a config-shaped object, creating the branch as needed. */
export function writeConfigField(target: Record<string, unknown>, key: string, value: unknown): void {
	const parts = key.split('.');
	const last = parts.pop() as string;
	let cursor = target;
	for (const part of parts) {
		const next = cursor[part];
		// Clone rather than mutate: the caller's snapshot of the file must not change
		// under it if the candidate turns out to be invalid.
		cursor[part] = next && typeof next === 'object' && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {};
		cursor = cursor[part] as Record<string, unknown>;
	}
	cursor[last] = value;
}

export type ConfigPatchEntry = { key: string; value: unknown; spec: ConfigFieldSpec };

/**
 * Type-checks a patch against EDITABLE_FIELDS. Unknown keys are refused rather than
 * written: a typo that lands in config.json is a setting that silently does nothing.
 */
export function validateConfigPatch(patch: Record<string, unknown>): ConfigPatchEntry[] {
	const entries: ConfigPatchEntry[] = [];

	for (const [key, raw] of Object.entries(patch)) {
		const spec = EDITABLE_FIELDS[key];
		if (!spec) throw new Error(`Unknown or read-only setting "${key}"`);

		let value = raw;
		if (value === null) {
			if (!spec.nullable) throw new Error(`${key} cannot be null`);
			entries.push({ key, value: null, spec });
			continue;
		}

		switch (spec.kind) {
			case 'boolean':
				if (typeof value !== 'boolean') throw new Error(`${key} must be true or false`);
				break;
			case 'number': {
				if (typeof value === 'string' && value.trim() !== '') value = Number(value);
				if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
				if (spec.integer && !Number.isInteger(value)) throw new Error(`${key} must be a whole number`);
				if (spec.min !== undefined && value < spec.min) throw new Error(`${key} must be >= ${spec.min}`);
				if (spec.max !== undefined && value > spec.max) throw new Error(`${key} must be <= ${spec.max}`);
				break;
			}
			case 'enum':
				if (typeof value !== 'string' || !(spec.values ?? []).includes(value)) {
					throw new Error(`${key} must be one of: ${(spec.values ?? []).join(', ')}`);
				}
				break;
			case 'string': {
				if (typeof value !== 'string') throw new Error(`${key} must be text`);
				const trimmed = value.trim();
				// An emptied text box means "unset", not the empty string.
				if (trimmed === '') {
					if (!spec.nullable) throw new Error(`${key} cannot be empty`);
					value = null;
				} else {
					value = trimmed;
				}
				break;
			}
		}

		entries.push({ key, value, spec });
	}

	return entries;
}

/**
 * Writes a patch into config.json.
 *
 * The candidate is merged and validated *before* anything is written, and the write
 * itself is a rename, so a reader never sees a half-written file and a rejected patch
 * leaves the previous config exactly as it was.
 */
export function saveConfig(
	patch: Record<string, unknown>,
	options: { file?: string } = {},
): {
	config: KanbanConfig;
	raw: RawConfig;
	applied: string[];
	restartRequired: string[];
	replacedBroken: string | null;
} {
	const file = options.file ?? configPath();
	const entries = validateConfigPatch(patch);
	const current = readConfigFile(file);

	// An unparseable file cannot be patched, only replaced — but it is the only copy of
	// whatever somebody meant to write, so it is moved aside instead of destroyed.
	const raw: RawConfig = current.error ? {} : { ...current.raw };
	for (const { key, value } of entries) writeConfigField(raw, key, value);

	const config = validateConfig(mergeConfig(raw as Partial<KanbanConfig>, {}));

	let replacedBroken: string | null = null;
	if (current.error && existsSync(file)) {
		replacedBroken = `${file}.broken`;
		renameSync(file, replacedBroken);
	}

	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
	renameSync(tmp, file);

	return {
		config,
		raw,
		applied: entries.filter((e) => e.spec.hot).map((e) => e.key),
		restartRequired: entries.filter((e) => !e.spec.hot).map((e) => e.key),
		replacedBroken,
	};
}

export function resolveAgent(config: KanbanConfig, name: string | null): { name: string; agent: AgentConfig } {
	const agentName = name ?? config.defaultAgent;
	const agent = config.agents[agentName];
	if (!agent) {
		throw new Error(`Unknown agent "${agentName}". Configured agents: ${Object.keys(config.agents).join(', ')}`);
	}
	return { name: agentName, agent };
}
