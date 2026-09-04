import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildModelCommand } from '../src/agents.ts';
import { DEFAULT_AGENTS } from '../src/config.ts';
import {
	assertModel,
	defaultModelFor,
	loadCatalog,
	ModelError,
	modelMenu,
	parseCatalog,
	resolveChoice,
} from '../src/models.ts';
import { okResult, testBoard, testConfig } from './helpers.ts';
import type { AgentConfig, Card, CatalogModel, ModelChoice } from '../src/types.ts';

/** The shape `omp models --json` really prints, trimmed to what resolution reads. */
const OMP_JSON = JSON.stringify({
	models: [
		{ provider: 'anthropic', id: 'claude-opus-4-5', selector: 'anthropic/claude-opus-4-5', name: 'Claude Opus 4.5' },
		{ provider: 'anthropic', id: 'claude-opus-4-8', selector: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8' },
		{ provider: 'anthropic', id: 'claude-opus-5', selector: 'anthropic/claude-opus-5', name: 'Claude Opus 5' },
		{
			provider: 'anthropic',
			id: 'claude-opus-4-1-20250805',
			selector: 'anthropic/claude-opus-4-1-20250805',
			name: 'Claude 4.1 Opus',
		},
		{ provider: 'anthropic', id: 'claude-haiku-4-5', selector: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5' },
		{ provider: 'cursor', id: 'claude-4.6-opus-max', selector: 'cursor/claude-4.6-opus-max', name: 'Claude Opus 4.6' },
		{ provider: 'openai-codex', id: 'gpt-5.6-sol', selector: 'openai-codex/gpt-5.6-sol', name: 'GPT-5.6-Sol' },
		{ provider: 'cursor', id: 'gpt-5.6-sol-fast', selector: 'cursor/gpt-5.6-sol-fast', name: 'GPT-5.6 Sol Fast' },
	],
});

/** An agent whose catalog is a file, so no test ever shells out to a real agent. */
function agentWithCatalog(body: string, options: { fails?: boolean } = {}): { agent: AgentConfig; calls: () => number } {
	const dir = mkdtempSync(path.join(tmpdir(), 'catalog-'));
	const file = path.join(dir, 'catalog.json');
	const log = path.join(dir, 'calls');
	writeFileSync(file, body, 'utf8');
	writeFileSync(log, '', 'utf8');

	return {
		agent: {
			...(DEFAULT_AGENTS['omp'] as AgentConfig),
			modelsCommand: `echo call >> ${log}; ${options.fails ? 'exit 3' : `cat ${file}`}`,
			modelsRefreshCommand: null,
		},
		calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).length,
	};
}

const choice = (over: Partial<ModelChoice> = {}): ModelChoice => ({
	id: 'opus',
	label: 'Opus',
	match: 'claude-opus',
	providers: ['anthropic'],
	...over,
});

test('the json catalog is read as models, and nested fields do not become models', () => {
	const models = parseCatalog(
		JSON.stringify({ models: [{ provider: 'anthropic', id: 'claude-opus-5', selector: 'anthropic/claude-opus-5', cost: { id: 'nonsense' } }] }),
		'json',
	);

	assert.equal(models.length, 1, 'a model object is a leaf; its cost block is not another model');
	assert.deepEqual(models[0], {
		provider: 'anthropic',
		id: 'claude-opus-5',
		selector: 'anthropic/claude-opus-5',
		label: 'anthropic/claude-opus-5',
	});
});

test('a line catalog takes the id and drops the prose around it', () => {
	// `cursor-agent --list-models` and `opencode models`, verbatim shapes.
	const models = parseCatalog(
		['Available models', '', 'auto - Auto (default)', 'gpt-5.3-codex-low - Codex 5.3 Low', 'opencode/big-pickle'].join('\n'),
		'lines',
	);

	assert.deepEqual(
		models.map((m) => m.selector),
		['auto', 'gpt-5.3-codex-low', 'opencode/big-pickle'],
		'the "Available models" header is not a model',
	);
});

test('unreadable output yields no models rather than an invented one', () => {
	assert.deepEqual(parseCatalog('not json at all', 'json'), []);
	assert.deepEqual(parseCatalog('', 'lines'), []);
});

test('a name resolves to the newest matching model, not the first one listed', () => {
	const catalog = parseCatalog(OMP_JSON, 'json');

	assert.equal(resolveChoice(choice(), catalog).selector, 'anthropic/claude-opus-5', '5 beats 4.8 and 4.5');
	assert.equal(
		resolveChoice(choice({ id: 'haiku', match: 'claude-haiku' }), catalog).selector,
		'anthropic/claude-haiku-4-5',
	);
	// The plain name wins over the variants built on it, and provider preference picks
	// the codex one over cursor's.
	assert.equal(
		resolveChoice(choice({ id: 'sol', match: 'sol', providers: ['openai-codex'] }), catalog).selector,
		'openai-codex/gpt-5.6-sol',
	);
	assert.equal(
		resolveChoice(choice({ id: 'sol', match: 'sol', providers: [] }), catalog).selector,
		'openai-codex/gpt-5.6-sol',
		'shortest id wins the tie, so -fast never gets picked by accident',
	);
});

test('a dated snapshot is never what a moving name resolves to', () => {
	const dated = parseCatalog(
		JSON.stringify({
			models: [{ provider: 'anthropic', id: 'claude-opus-4-1-20250805', selector: 'anthropic/claude-opus-4-1-20250805' }],
		}),
		'json',
	);

	assert.equal(resolveChoice(choice(), dated).selector, null, 'a pin cannot answer for the family name');
});

test('a pinned choice resolves only to that exact model', () => {
	const catalog = parseCatalog(OMP_JSON, 'json');
	const pinned = choice({ selector: 'anthropic/claude-opus-4-5', match: '' });

	assert.equal(resolveChoice(pinned, catalog).selector, 'anthropic/claude-opus-4-5', 'the pin is honoured exactly');
	assert.equal(
		resolveChoice(choice({ selector: 'anthropic/claude-opus-9', match: '' }), catalog).selector,
		null,
		'a pin to something withdrawn is unavailable, not silently upgraded',
	);
});

test('an unreleased name stays in the menu and explains itself', async () => {
	const { board } = testBoard();
	const { agent } = agentWithCatalog(OMP_JSON);
	const config = testConfig({ agents: { ...DEFAULT_AGENTS, omp: agent } });

	const menu = await modelMenu({ config, store: board, agentName: 'omp' });
	const astra = menu.entries.find((e) => e.choice.id === 'astra');
	const opus = menu.entries.find((e) => e.choice.id === 'opus');

	assert.equal(astra?.selector, null);
	assert.match(String(astra?.reason), /not in omp's catalog yet/i);
	assert.equal(opus?.selector, 'anthropic/claude-opus-5');
	assert.equal(opus?.isDefault, true, 'the default is marked, so the menu says what a new card gets');
	board.close();
});

test('a name starts working the day the provider ships it, with no config change', async () => {
	const { board } = testBoard();
	// Before: exactly the catalog omp reported, which had no astra in it.
	const before = agentWithCatalog(OMP_JSON);
	const config = testConfig({ agents: { ...DEFAULT_AGENTS, omp: before.agent } });

	await assert.rejects(
		() => assertModel({ config, store: board, agentName: 'omp', model: 'astra' }),
		ModelError,
		'unavailable while the provider has not shipped it',
	);

	// After: the same shipped menu entry, against a catalog that now has it. This is
	// the real selector omp reported once `omp models refresh` picked it up.
	const after = agentWithCatalog(
		JSON.stringify({
			models: [
				{ provider: 'openai-codex', id: 'gpt-6-astra', selector: 'openai-codex/gpt-6-astra', name: 'GPT-6-Astra' },
				{ provider: 'openai-codex', id: 'gpt-5.6-sol', selector: 'openai-codex/gpt-5.6-sol', name: 'GPT-5.6-Sol' },
			],
		}),
	);
	const resolved = await assertModel({
		config: testConfig({ agents: { ...DEFAULT_AGENTS, omp: after.agent } }),
		store: board,
		agentName: 'omp',
		model: 'astra',
		refresh: true,
	});

	assert.equal(resolved.selector, 'openai-codex/gpt-6-astra', 'the same name now resolves');
	board.close();
});

test('the catalog is fetched once and then read from the board', async () => {
	const { board } = testBoard();
	const { agent, calls } = agentWithCatalog(OMP_JSON);

	const first = await loadCatalog({ agentName: 'omp', agent, store: board });
	const second = await loadCatalog({ agentName: 'omp', agent, store: board });

	assert.equal(first.models.length, second.models.length);
	assert.equal(calls(), 1, 'the second read is the cache, not another subprocess');

	const forced = await loadCatalog({ agentName: 'omp', agent, store: board, refresh: true });
	assert.equal(calls(), 2, '--refresh really re-reads');
	assert.equal(forced.stale, false);
	board.close();
});

test('a failed fetch falls back to the last catalog instead of refusing the card', async () => {
	const { board } = testBoard();
	const { agent } = agentWithCatalog(OMP_JSON);
	await loadCatalog({ agentName: 'omp', agent, store: board });

	const broken = { ...agent, modelsCommand: 'echo nonsense; exit 3' };
	const after = await loadCatalog({ agentName: 'omp', agent: broken, store: board, refresh: true });

	assert.ok(after.models.length > 0, 'the models did not vanish because the binary broke');
	assert.equal(after.stale, true, 'and the caller is told the copy is old');
	board.close();
});

test('with no cache at all, a broken catalog is an error and not an empty menu', async () => {
	const { board } = testBoard();
	const { agent } = agentWithCatalog(OMP_JSON, { fails: true });

	await assert.rejects(
		() => loadCatalog({ agentName: 'omp', agent, store: board }),
		(err: Error) => err instanceof ModelError && /could not read the model catalog/i.test(err.message),
	);
	board.close();
});

test('a model outside the menu is refused, and the menu is named', async () => {
	const { board } = testBoard();
	const { agent } = agentWithCatalog(OMP_JSON);
	const config = testConfig({ agents: { ...DEFAULT_AGENTS, omp: agent } });

	await assert.rejects(
		() => assertModel({ config, store: board, agentName: 'omp', model: 'gpt-9' }),
		(err: Error) => {
			assert.ok(err instanceof ModelError);
			assert.match(err.message, /not in the model menu/);
			assert.ok(err.available.includes('opus'), 'the refusal says what would work');
			return true;
		},
	);
	board.close();
});

test('a model in the menu but not in the catalog is refused with what to do about it', async () => {
	const { board } = testBoard();
	const { agent } = agentWithCatalog(OMP_JSON);
	const config = testConfig({ agents: { ...DEFAULT_AGENTS, omp: agent } });

	await assert.rejects(
		() => assertModel({ config, store: board, agentName: 'omp', model: 'astra' }),
		(err: Error) => {
			assert.ok(err instanceof ModelError);
			assert.match(err.message, /may not be released yet/);
			assert.match(err.message, /kanban models --refresh/);
			// Everything the fixture catalog can actually answer for right now.
			assert.deepEqual(err.available, ['opus', 'haiku', 'sol']);
			return true;
		},
	);
	board.close();
});

test('an agent that cannot be told its model refuses the request and names one that can', async () => {
	const { board } = testBoard();
	const { agent } = agentWithCatalog(OMP_JSON);
	const config = testConfig({ agents: { ...DEFAULT_AGENTS, omp: agent } });

	await assert.rejects(
		() => assertModel({ config, store: board, agentName: 'claude', model: 'opus' }),
		(err: Error) => {
			assert.ok(err instanceof ModelError);
			assert.match(err.message, /cannot be told which model/);
			assert.match(err.message, /\bomp\b/, 'it points at an agent that can');
			return true;
		},
	);
	board.close();
});

test('a good model resolves to the concrete one the agent will be launched on', async () => {
	const { board } = testBoard();
	const { agent } = agentWithCatalog(OMP_JSON);
	const config = testConfig({ agents: { ...DEFAULT_AGENTS, omp: agent } });

	const resolved = await assertModel({ config, store: board, agentName: 'omp', model: 'opus' });
	assert.equal(resolved.selector, 'anthropic/claude-opus-5');
	assert.equal(resolved.choice.id, 'opus');
	board.close();
});

test('only an agent that can take a model gets the default', () => {
	const config = testConfig();

	assert.equal(defaultModelFor(config, null), 'opus', 'the configured default agent can, so new cards get Opus');
	assert.equal(defaultModelFor(config, 'omp'), 'opus');
	assert.equal(defaultModelFor(config, 'claude'), null, 'and a claude card keeps behaving as it always did');
	assert.equal(defaultModelFor(config, 'nonsense'), null);
});

test('the launch command carries the resolved model, quoted', () => {
	const agent = DEFAULT_AGENTS['omp'] as AgentConfig;
	const command = buildModelCommand(agent, {
		model: 'anthropic/claude-opus-5',
		promptFile: '/tmp/wt/.orca-kanban/prompt.md',
		promptFileRel: '.orca-kanban/prompt.md',
		prompt: 'do the work',
	});

	assert.match(String(command), /--model anthropic\/claude-opus-5/, 'the selector, not the alias');
	assert.match(String(command), /@\.orca-kanban\/prompt\.md/, 'and the prompt is delivered with it');

	const quoted = buildModelCommand(agent, {
		model: "evil'; rm -rf /",
		promptFile: '/tmp/p',
		promptFileRel: 'p',
		prompt: 'x',
	});
	assert.doesNotMatch(String(quoted), /; rm -rf \/$/, 'a model name cannot escape into the shell');

	assert.equal(
		buildModelCommand(DEFAULT_AGENTS['claude'] as AgentConfig, {
			model: 'opus',
			promptFile: '/tmp/p',
			promptFileRel: 'p',
			prompt: 'x',
		}),
		null,
		'an agent with no modelCommand has no way to run one',
	);
});

test('catalog entries survive a round trip through the board', () => {
	const { board } = testBoard();
	const models: CatalogModel[] = [
		{ provider: 'anthropic', id: 'claude-opus-5', selector: 'anthropic/claude-opus-5', label: 'Claude Opus 5' },
	];

	assert.equal(board.modelCatalog('omp'), null, 'nothing cached to begin with');
	board.saveModelCatalog('omp', models);
	assert.deepEqual(board.modelCatalog('omp')?.models, models);

	board.saveModelCatalog('omp', []);
	assert.deepEqual(board.modelCatalog('omp')?.models, [], 'a re-read replaces rather than appends');
	board.close();
});

test('a finished run records the alias and the version it ran on', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'on opus', state: 'Ready', model: 'opus' });
	const run = board.startRun(card.id, 'term_x');

	board.persistResult(
		board.getCard(card.id) as Card,
		okResult(run.id, { model: 'opus', modelSelector: 'anthropic/claude-opus-5' }),
		{ successState: 'Review' },
	);

	const details = JSON.parse(String(board.runsForCard(card.id)[0]?.details ?? '{}')) as Record<string, unknown>;
	assert.equal(details['model'], 'opus', 'what was asked for');
	assert.equal(
		details['modelSelector'],
		'anthropic/claude-opus-5',
		'and what actually ran, because the alias will mean something else next month',
	);
	board.close();
});
