import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import type { AgentConfig, CardState, KanbanConfig } from './types.ts';

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
 */
export const DEFAULT_AGENTS: Record<string, AgentConfig> = {
	omp: { orcaAgentId: 'omp', fallbackCommand: 'omp --auto-approve {{promptFileRel}}' },
	codex: { orcaAgentId: 'codex', fallbackCommand: null },
	claude: { orcaAgentId: 'claude', fallbackCommand: null },
	cursor: { orcaAgentId: 'cursor', fallbackCommand: null },
	opencode: { orcaAgentId: 'opencode', fallbackCommand: null },
	pi: { orcaAgentId: 'pi', fallbackCommand: null },
};

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
};

export function configPath(): string {
	return process.env.ORCA_KANBAN_CONFIG ?? path.join(kanbanHome(), 'config.json');
}

/**
 * Reads config.json and layers it over DEFAULT_CONFIG.
 *
 * Both a flat object and a `{ kanban: {...}, agents: {...} }` shape are accepted so
 * the documented YAML-style layout maps 1:1 onto JSON.
 */
export function loadConfig(overrides: Partial<KanbanConfig> = {}): KanbanConfig {
	const file = configPath();
	let onDisk: Partial<KanbanConfig> = {};

	if (existsSync(file)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
			if (parsed && typeof parsed === 'object') {
				const raw = parsed as Record<string, unknown>;
				const nested = raw['kanban'];
				onDisk = { ...(nested && typeof nested === 'object' ? nested : {}), ...raw } as Partial<KanbanConfig>;
				delete (onDisk as Record<string, unknown>)['kanban'];
			}
		} catch (err) {
			throw new Error(`Invalid config at ${file}: ${(err as Error).message}`);
		}
	}

	const agents: Record<string, AgentConfig> = { ...DEFAULT_AGENTS };
	for (const source of [onDisk.agents, overrides.agents]) {
		for (const [name, cfg] of Object.entries(source ?? {})) {
			agents[name] = { ...(agents[name] ?? { orcaAgentId: name, fallbackCommand: null }), ...cfg };
		}
	}

	const merged: KanbanConfig = {
		...DEFAULT_CONFIG,
		...onDisk,
		...overrides,
		orcaStatusMap: { ...DEFAULT_ORCA_STATUS_MAP, ...onDisk.orcaStatusMap, ...overrides.orcaStatusMap },
		orchestration: { ...DEFAULT_CONFIG.orchestration, ...onDisk.orchestration, ...overrides.orchestration },
		agents,
	};

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

	return merged;
}

export function resolveAgent(config: KanbanConfig, name: string | null): { name: string; agent: AgentConfig } {
	const agentName = name ?? config.defaultAgent;
	const agent = config.agents[agentName];
	if (!agent) {
		throw new Error(`Unknown agent "${agentName}". Configured agents: ${Object.keys(config.agents).join(', ')}`);
	}
	return { name: agentName, agent };
}
