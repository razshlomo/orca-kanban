import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';
import { describeResume, resumeCardSession } from '../src/resume.ts';
import type { OrcaTerminal } from '../src/orca.ts';
import type { Card } from '../src/types.ts';
import { testBoard } from './helpers.ts';

const ui = readFileSync(path.join(import.meta.dirname, '..', 'ui', 'index.html'), 'utf8');
const script = ui.slice(ui.indexOf('<script>') + '<script>'.length, ui.lastIndexOf('</script>'));

// ---------------------------------------------------------------- finding 1

test('a state change is recorded, and an ordinary edit is not mistaken for one', async () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Backlog' });
	assert.equal(card.stateChangedAt, card.createdAt, 'a new card enters its state when created');

	// The whole point: updatedAt moves on any edit, so it cannot answer "how long has this
	// been waiting for me". stateChangedAt must ignore edits that leave the column alone.
	await new Promise((r) => setTimeout(r, 1050));
	board.updateCard(card.id, { title: 'renamed' });
	const renamed = board.getCard(card.id) as Card;
	assert.equal(renamed.stateChangedAt, card.stateChangedAt, 'renaming is not a state change');
	assert.ok(renamed.updatedAt > card.updatedAt, 'though it does touch updatedAt');

	board.moveCard(card.id, 'Ready');
	const moved = board.getCard(card.id) as Card;
	assert.ok(moved.stateChangedAt > renamed.stateChangedAt, 'moving columns is');
	board.close();
});

test('every path that moves a card stamps the state change', async () => {
	const { board } = testBoard();
	const stamps: Record<string, boolean> = {};

	const claimed = board.createCard({ title: 'claim', state: 'Ready' });
	await new Promise((r) => setTimeout(r, 1050));
	board.claimCard(claimed.id, 'w');
	stamps.claim = (board.getCard(claimed.id) as Card).stateChangedAt > claimed.stateChangedAt;

	const retried = board.createCard({ title: 'retry', state: 'Blocked' });
	await new Promise((r) => setTimeout(r, 1050));
	board.retryCard(retried.id);
	stamps.retry = (board.getCard(retried.id) as Card).stateChangedAt > retried.stateChangedAt;

	const snoozed = board.createCard({ title: 'snooze', state: 'Backlog' });
	await new Promise((r) => setTimeout(r, 1050));
	board.snoozeCard(snoozed.id, Date.now() + 60_000);
	stamps.snooze = (board.getCard(snoozed.id) as Card).stateChangedAt > snoozed.stateChangedAt;

	assert.deepEqual(stamps, { claim: true, retry: true, snooze: true });
	board.close();
});

// ---------------------------------------------------------------- finding 2

/** Records what would be launched, so the test never spawns a real terminal. */
function fakeOrca(): { calls: Array<Record<string, unknown>>; api: { terminalCreate: (o: Record<string, unknown>) => Promise<OrcaTerminal> } } {
	const calls: Array<Record<string, unknown>> = [];
	return {
		calls,
		api: {
			terminalCreate: async (o) => {
				calls.push(o);
				return { handle: 'term_resumed' } as OrcaTerminal;
			},
		},
	};
}

test('resuming reopens the agent in the card own worktree, which is what holds the transcript', async () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'ran already', state: 'Review' });
	board.attachSession(card.id, {
		sessionId: 'term_dead',
		worktreeId: 'wt_1',
		worktreePath: '/tmp/wt',
		branch: 'b',
	});

	const orca = fakeOrca();
	const outcome = await resumeCardSession(board.getCard(card.id) as Card, loadConfig({}), orca.api as never);

	assert.deepEqual(outcome, { resumed: true, sessionId: 'term_resumed', command: 'omp --continue' });
	// The worktree is the key: omp stores sessions per working directory, so launching
	// anywhere else would start a brand new conversation instead of reopening this one.
	assert.equal(orca.calls[0]?.['worktreeSelector'], 'id:wt_1');
	assert.equal(orca.calls[0]?.['command'], 'omp --continue');
	board.close();
});

test('resuming falls back to the worktree path when there is no id', async () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Review' });
	board.attachSession(card.id, { sessionId: null, worktreeId: null, worktreePath: '/tmp/wt', branch: null });

	const orca = fakeOrca();
	await resumeCardSession(board.getCard(card.id) as Card, loadConfig({}), orca.api as never);
	assert.equal(orca.calls[0]?.['worktreeSelector'], 'path:/tmp/wt');
	board.close();
});

test('resuming refuses with a reason rather than opening a useless terminal', async () => {
	const { board } = testBoard();
	const orca = fakeOrca();

	const neverRan = board.createCard({ title: 'never ran', state: 'Backlog' });
	const noWorktree = await resumeCardSession(board.getCard(neverRan.id) as Card, loadConfig({}), orca.api as never);
	assert.deepEqual(noWorktree, { resumed: false, reason: 'no-worktree', detail: 'no worktree' });
	assert.match(describeResume(noWorktree), /never run/);

	const ran = board.createCard({ title: 'x', state: 'Review', agent: 'cursor' });
	board.attachSession(ran.id, { sessionId: null, worktreeId: 'wt', worktreePath: '/tmp/wt', branch: null });
	const noCommand = await resumeCardSession(board.getCard(ran.id) as Card, loadConfig({}), orca.api as never);
	assert.equal(noCommand.resumed, false);
	assert.match(describeResume(noCommand), /cursor has no resume command/);

	assert.equal(orca.calls.length, 0, 'nothing was launched in either case');
	board.close();
});

test('the agents that can resume are exactly the ones with a command', () => {
	const config = loadConfig({});
	const resumable = Object.entries(config.agents)
		.filter(([, a]) => a.resumeCommand)
		.map(([n]) => n);

	assert.deepEqual(resumable.sort(), ['claude', 'codex', 'omp']);
	assert.equal(config.agents['omp']?.resumeCommand, 'omp --continue');
});

// ---------------------------------------------------------------- finding 3

test('an agent summary renders as prose, with bullets after a lead-in line', () => {
	const prose = new Function(
		'esc',
		`${script.slice(script.indexOf('function prose'), script.indexOf('/** Compact'))}; return prose;`,
	)((s: string) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string));

	// The shape almost every summary uses: a lead-in, then a list. Treating the lead-in as
	// part of the paragraph left the bullets as raw "- " text.
	assert.equal(prose('Changed:\n- a.ts\n- b.ts'), '<p>Changed:</p><ul><li>a.ts</li><li>b.ts</li></ul>');
	assert.equal(prose('One.\n\nTwo.'), '<p>One.</p><p>Two.</p>');
	assert.equal(prose('Flag `x_y` is on.'), '<p>Flag <code>x_y</code> is on.</p>');
	assert.equal(prose(''), '');

	// Never trust agent output as markup.
	assert.equal(prose('<img src=x onerror=alert(1)>'), '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
});

test('the summary is styled as text, not as a machine-output block', () => {
	assert.match(ui, /class="prose" data-scroll="summary"/, 'it gets the prose treatment');
	assert.match(ui, /\.prose \{[^}]*line-height: 1\.55/, 'and a readable line height');
	assert.ok(
		!ui.includes('<label>What the agent said</label><pre'),
		'the old monospace <pre> rendering is gone',
	);
});

// ---------------------------------------------------------------- finding 4

test('the panel only touches the DOM when the markup actually changed', () => {
	// Rewriting innerHTML on every 1.5s poll destroyed every child, which threw away the
	// scroll position inside the agent summary — the reported "scroll doesn't work".
	assert.match(script, /if \(bodyEl\.innerHTML !== nextBody\)/);
	assert.match(script, /if \(headEl\.innerHTML !== nextHead\)/);
});

test('a redraw that is needed restores the reader scroll position', () => {
	assert.match(script, /querySelectorAll\('\[data-scroll\]'\)/, 'positions are captured');
	assert.match(script, /el\.scrollTop = top/, 'and put back');
	// Every long block a person actually reads must be marked.
	for (const key of ['summary', 'error', 'diff']) {
		assert.ok(ui.includes(`data-scroll="${key}"`), `${key} must survive a redraw`);
	}
});

test('revert forces a redraw, because typing does not change the markup', () => {
	// An input's value PROPERTY changes on typing while its attribute does not, so the
	// innerHTML comparison cannot see edits and would skip the discard.
	const revert = script.slice(script.indexOf('function revertCard'), script.indexOf('async function retryCard'));
	assert.match(revert, /panelBody"\)\.innerHTML = ""/);
});

// ---------------------------------------------------------------- finding 5

test('a taken port is a sentence and an exit code, not a stack trace', async () => {
	const blocker = createServer(() => {});
	await new Promise<void>((r) => blocker.listen(0, () => r()));
	const port = (blocker.address() as { port: number }).port;

	const home = mkdtempSync(path.join(tmpdir(), 'port-'));
	try {
		const run = spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'src', 'cli.ts'), 'serve', '--port', String(port)], {
			env: { ...process.env, ORCA_KANBAN_HOME: home },
			encoding: 'utf8',
			timeout: 60_000,
		});

		assert.equal(run.status, 1, 'it fails cleanly');
		assert.match(run.stderr, new RegExp(`Port ${port} is already in use`));
		assert.ok(!run.stderr.includes('EADDRINUSE'), 'the raw errno is not the user-facing message');
		assert.ok(!run.stderr.includes('at Server.'), 'and no stack trace');
		assert.ok(!run.stdout.includes('Orca Kanban board:'), 'no success banner for a board that never started');

		// The real damage this could do: claiming a healthy board's scheduler row and then
		// dying, so `kanban status` reports the scheduler dead.
		const db = openDb(path.join(home, 'board.sqlite'));
		const row = db.prepare('SELECT owner_pid FROM scheduler_state WHERE id = 1').get() as { owner_pid: number | null };
		assert.equal(row.owner_pid, null, 'a serve that never bound must not claim ownership');
		db.close();
	} finally {
		blocker.close();
	}
});
