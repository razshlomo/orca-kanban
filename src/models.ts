import { execFile } from 'node:child_process';
import type { AgentConfig, CatalogModel, KanbanConfig, ModelChoice } from './types.ts';

/**
 * How long a cached catalog is trusted before it is re-read from the agent. Model
 * catalogs change when a provider ships something, not by the minute, and the fetch
 * costs seconds of subprocess time — so half a day of staleness is the right trade,
 * with `kanban models --refresh` for the day a release lands.
 */
export const CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 60_000;

/**
 * A model that cannot be honoured: not in the menu, not in the agent's catalog, or an
 * agent that cannot be told which model to use at all.
 *
 * Separate type so every surface can answer in its own currency — the CLI exits 4, the
 * API answers 409, and the executor blocks the card with the reason on it — instead of
 * a bad model name surfacing later as a mystery timeout.
 */
export class ModelError extends Error {
	readonly agent: string;
	readonly model: string;
	/** Model aliases that WOULD work for this agent right now. */
	readonly available: string[];

	constructor(message: string, details: { agent: string; model: string; available?: string[] }) {
		super(message);
		this.name = 'ModelError';
		this.agent = details.agent;
		this.model = details.model;
		this.available = details.available ?? [];
	}
}

/** Where fetched catalogs are kept between processes. Implemented by `Board`. */
export type CatalogStore = {
	modelCatalog(agent: string): { models: CatalogModel[]; fetchedAt: number } | null;
	saveModelCatalog(agent: string, models: CatalogModel[]): void;
};

/**
 * An agent can be asked for a model only if it can both launch with one and say which
 * models exist. Without the catalog there is no way to refuse a wrong name, and a card
 * silently running on the wrong model is worse than a card that refuses to start.
 */
export function agentSupportsModels(agent: AgentConfig): boolean {
	return agent.modelCommand !== null && agent.modelsCommand !== null;
}

/** Dated snapshots (`claude-opus-4-1-20250805`) are pins, not the moving family name. */
const DATED = /-20\d{6}$/;

/** One model per line, id first: `auto - Auto (default)`, `openai/gpt-5`. */
const LINE_ID = /^\s*([A-Za-z0-9][\w./:+-]*)\s*(?:[-–—]\s+\S.*)?$/;

function fromJson(node: unknown, out: CatalogModel[]): void {
	if (Array.isArray(node)) {
		for (const item of node) fromJson(item, out);
		return;
	}
	if (!node || typeof node !== 'object') return;

	const obj = node as Record<string, unknown>;
	const selector = typeof obj['selector'] === 'string' ? obj['selector'] : null;
	const id = typeof obj['id'] === 'string' ? obj['id'] : null;

	if (selector ?? id) {
		const full = selector ?? (id as string);
		const provider =
			typeof obj['provider'] === 'string' ? obj['provider'] : full.includes('/') ? full.split('/')[0] : '';
		out.push({
			provider: provider as string,
			id: id ?? (full.split('/').pop() as string),
			selector: full,
			label: typeof obj['name'] === 'string' ? obj['name'] : full,
		});
		// A model object is a leaf: descending into its `cost`/`input` fields would
		// invent models out of nested ids.
		return;
	}

	for (const value of Object.values(obj)) fromJson(value, out);
}

/**
 * Reads an agent's catalog output into models.
 *
 * Tolerant on purpose: these are other people's CLIs, and a header line, a blank line
 * or an extra field is not a reason to refuse every card. What is NOT tolerated is
 * inventing a model — anything unrecognisable is dropped, so the catalog only ever
 * under-reports, and an unknown alias is refused rather than passed through.
 */
export function parseCatalog(raw: string, format: AgentConfig['modelsFormat']): CatalogModel[] {
	const models: CatalogModel[] = [];

	if (format === 'json') {
		try {
			fromJson(JSON.parse(raw) as unknown, models);
		} catch {
			return [];
		}
	} else {
		for (const line of raw.split('\n')) {
			const match = LINE_ID.exec(line);
			const id = match?.[1];
			if (!id) continue;
			models.push({
				provider: id.includes('/') ? (id.split('/')[0] as string) : '',
				id: id.split('/').pop() as string,
				selector: id,
				label: id,
			});
		}
	}

	const seen = new Set<string>();
	return models.filter((m) => {
		if (seen.has(m.selector)) return false;
		seen.add(m.selector);
		return true;
	});
}

function runCommand(command: string): Promise<{ stdout: string; error: string | null }> {
	const { promise, resolve } = Promise.withResolvers<{ stdout: string; error: string | null }>();
	execFile(
		'/bin/sh',
		['-c', command],
		{ timeout: FETCH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
		(err, stdout, stderr) => {
			const reason = err ? (String(stderr).trim() || err.message).split('\n')[0] : null;
			resolve({ stdout: String(stdout), error: reason ?? null });
		},
	);
	return promise;
}

/**
 * The agent's model catalog, from cache when it is fresh enough.
 *
 * A failed fetch falls back to a stale cache rather than refusing the card: the models
 * did not disappear because the binary hiccuped. Only with no cache at all does this
 * throw, because then nothing can be verified.
 */
export async function loadCatalog(args: {
	agentName: string;
	agent: AgentConfig;
	store: CatalogStore;
	refresh?: boolean;
}): Promise<{ models: CatalogModel[]; fetchedAt: number; stale: boolean }> {
	const { agentName, agent, store, refresh } = args;
	if (!agent.modelsCommand) {
		throw new ModelError(`Agent "${agentName}" cannot list models, so no model can be checked for it.`, {
			agent: agentName,
			model: '',
		});
	}

	const cached = store.modelCatalog(agentName);
	if (!refresh && cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS && cached.models.length > 0) {
		return { ...cached, stale: false };
	}

	if (refresh && agent.modelsRefreshCommand) await runCommand(agent.modelsRefreshCommand);

	const { stdout, error } = await runCommand(agent.modelsCommand);
	const models = parseCatalog(stdout, agent.modelsFormat);

	if (models.length === 0) {
		if (cached && cached.models.length > 0) return { ...cached, stale: true };
		throw new ModelError(
			`Could not read the model catalog for "${agentName}" via \`${agent.modelsCommand}\`` +
				`${error ? `: ${error}` : ' (it printed nothing recognisable)'}`,
			{ agent: agentName, model: '' },
		);
	}

	store.saveModelCatalog(agentName, models);
	return { models, fetchedAt: Date.now(), stale: false };
}

/**
 * Orders matching models newest-first.
 *
 * Version numbers are compared position by position (`opus-5` beats `opus-4-8`), and a
 * tie goes to the shortest id — which is how the plain family name wins over the
 * `-fast`, `-high` and `-max` variants built on it.
 */
function compareNewest(a: CatalogModel, b: CatalogModel): number {
	const left = (a.id.match(/\d+/g) ?? []).map(Number);
	const right = (b.id.match(/\d+/g) ?? []).map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
		const diff = (right[i] ?? -1) - (left[i] ?? -1);
		if (diff !== 0) return diff;
	}
	return a.id.length - b.id.length;
}

/**
 * What one menu entry means in this catalog today: the concrete model it resolves to,
 * and everything it matched, so `kanban models` can show why.
 */
export function resolveChoice(
	choice: ModelChoice,
	catalog: CatalogModel[],
): { selector: string | null; candidates: CatalogModel[] } {
	if (choice.selector) {
		const pinned = catalog.find((m) => m.selector === choice.selector);
		return { selector: pinned?.selector ?? null, candidates: pinned ? [pinned] : [] };
	}

	const needle = choice.match.toLowerCase();
	const candidates = catalog
		.filter((m) => m.selector.toLowerCase().includes(needle))
		.filter((m) => !DATED.test(m.id))
		.filter((m) => choice.providers.length === 0 || choice.providers.includes(m.provider))
		.sort(compareNewest);

	return { selector: candidates[0]?.selector ?? null, candidates };
}

export type MenuEntry = {
	choice: ModelChoice;
	/** Concrete model this alias runs today, or null when nothing matches yet. */
	selector: string | null;
	candidates: number;
	/** Why it cannot be used, for the disabled option's tooltip. */
	reason: string | null;
	isDefault: boolean;
};

/**
 * The whole menu resolved against one agent, including the entries that do not work.
 *
 * An unavailable entry is kept and explained rather than hidden: a model announced but
 * not shipped is exactly what somebody is about to ask for, and "Astra — not in the
 * catalog yet" is a better answer than a menu that silently lacks it.
 */
export async function modelMenu(args: {
	config: KanbanConfig;
	store: CatalogStore;
	agentName?: string | null;
	refresh?: boolean;
}): Promise<{ agent: string; entries: MenuEntry[]; fetchedAt: number | null; stale: boolean; error: string | null }> {
	const { config, store, refresh } = args;
	const agentName = args.agentName ?? config.defaultAgent;
	const agent = config.agents[agentName];

	const blank = (reason: string): MenuEntry[] =>
		config.models.choices.map((choice) => ({
			choice,
			selector: null,
			candidates: 0,
			reason,
			isDefault: choice.id === config.models.default,
		}));

	if (!agent) {
		return { agent: agentName, entries: blank(`No agent "${agentName}" is configured`), fetchedAt: null, stale: false, error: null };
	}
	if (!agentSupportsModels(agent)) {
		const reason = `Agent "${agentName}" cannot be launched with a model`;
		return { agent: agentName, entries: blank(reason), fetchedAt: null, stale: false, error: null };
	}

	let catalog: { models: CatalogModel[]; fetchedAt: number; stale: boolean };
	try {
		catalog = await loadCatalog({ agentName, agent, store, ...(refresh === undefined ? {} : { refresh }) });
	} catch (err) {
		return {
			agent: agentName,
			entries: blank('The model catalog could not be read'),
			fetchedAt: null,
			stale: false,
			error: (err as Error).message,
		};
	}

	const entries = config.models.choices.map((choice) => {
		const { selector, candidates } = resolveChoice(choice, catalog.models);
		return {
			choice,
			selector,
			candidates: candidates.length,
			reason: selector ? null : `Not in ${agentName}'s catalog yet (${catalog.models.length} models)`,
			isDefault: choice.id === config.models.default,
		};
	});

	return { agent: agentName, entries, fetchedAt: catalog.fetchedAt, stale: catalog.stale, error: null };
}

/**
 * Resolves the model a card asks for, or refuses it.
 *
 * Called on every path that can set a model — create, edit, and once more immediately
 * before launch, because the menu, the agent and the catalog can all change between
 * writing a card and running it.
 */
export async function assertModel(args: {
	config: KanbanConfig;
	store: CatalogStore;
	agentName: string;
	model: string;
	refresh?: boolean;
}): Promise<{ selector: string; choice: ModelChoice }> {
	const { config, store, agentName, model, refresh } = args;
	const agent = config.agents[agentName];
	if (!agent) {
		throw new ModelError(`No agent "${agentName}" is configured, so its models cannot be checked.`, {
			agent: agentName,
			model,
		});
	}

	const ids = config.models.choices.map((c) => c.id);
	const choice = config.models.choices.find((c) => c.id.toLowerCase() === model.trim().toLowerCase());
	if (!choice) {
		throw new ModelError(`"${model}" is not in the model menu (have: ${ids.join(', ')}).`, {
			agent: agentName,
			model,
			available: ids,
		});
	}

	if (!agentSupportsModels(agent)) {
		throw new ModelError(
			`Agent "${agentName}" cannot be told which model to use — it has no modelCommand/modelsCommand configured. ` +
				`Use an agent that can (${Object.entries(config.agents)
					.filter(([, a]) => agentSupportsModels(a))
					.map(([name]) => name)
					.join(', ') || 'none configured'}), or leave the model unset.`,
			{ agent: agentName, model },
		);
	}

	const catalog = await loadCatalog({ agentName, agent, store, ...(refresh === undefined ? {} : { refresh }) });
	const { selector } = resolveChoice(choice, catalog.models);

	if (!selector) {
		const workable = config.models.choices
			.filter((c) => resolveChoice(c, catalog.models).selector !== null)
			.map((c) => c.id);
		throw new ModelError(
			`"${choice.id}" matches no model in ${agentName}'s catalog` +
				`${choice.selector ? ` (pinned to ${choice.selector})` : ` (looking for "${choice.match}")`}. ` +
				`It may not be released yet — try: kanban models --refresh. Working now: ${workable.join(', ') || 'none'}.`,
			{ agent: agentName, model: choice.id, available: workable },
		);
	}

	return { selector, choice };
}

/**
 * The model a brand-new card gets. Applied at creation so the card says which model it
 * runs, instead of that answer living in config and changing under queued cards.
 *
 * Null for an agent that cannot take one, which is what keeps a claude or codex card
 * working exactly as it did before models existed.
 */
export function defaultModelFor(config: KanbanConfig, agentName: string | null): string | null {
	const agent = config.agents[agentName ?? config.defaultAgent];
	if (!agent || !agentSupportsModels(agent)) return null;
	return config.models.default;
}
