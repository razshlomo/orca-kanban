/**
 * Live end-to-end smoke test: real Orca, real worktrees, real OMP agents.
 *
 * Reproduces the dynamic-scheduling scenario against actual agents:
 *   board starts as A(priority 10) and B(priority 1)
 *   while A is running, C(priority 20) is inserted
 *   expected execution order: A -> C -> B
 *
 * Usage: node scripts/smoke.ts <repoPathOrSelector>
 */
import { once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.ts';

const repo = process.argv[2] ?? '/tmp/kanban-probe';

// Isolated home so the smoke run never touches a real board.
const home = mkdtempSync(path.join(tmpdir(), 'orca-kanban-smoke-'));
process.env['ORCA_KANBAN_HOME'] = home;
process.env['ORCA_KANBAN_CONFIG'] = path.join(home, 'config.json');

writeFileSync(
	path.join(home, 'config.json'),
	JSON.stringify(
		{
			defaultRepo: repo,
			defaultAgent: 'omp',
			// Done (not Review) so dependency gating can be exercised end to end.
			successState: 'Done',
			autoRun: false,
			maxAttempts: 1,
			pollIntervalMs: 1000,
			agentPollIntervalMs: 3000,
			startupGraceMs: 12000,
			doneConfirmations: 2,
			cardTimeoutMs: 8 * 60 * 1000,
			mirrorToOrcaBoard: true,
			removeWorktreeOnSuccess: false,
			closeSessionWhenDone: true,
			orchestration: { enabled: true, objective: 'Orca Kanban smoke test', runId: null },
		},
		null,
		2,
	),
);

const app = createApp();
const executed: string[] = [];

console.log(`smoke home:  ${home}`);
console.log(`repo:        ${repo}`);
console.log(`agent:       ${app.config.defaultAgent} -> orca --agent ${app.config.agents['omp']?.orcaAgentId}\n`);

const status = await app.orca.status();
if (!status.runtimeReachable) {
	console.error('Orca runtime is not reachable — start the Orca app first.');
	process.exit(1);
}

const a = app.board.createCard({
	title: 'smoke A',
	state: 'Ready',
	priority: 10,
	description: 'Create a file named smoke-a.txt whose only contents are the single letter A.',
	acceptanceCriteria: 'smoke-a.txt exists in the repo root and contains exactly A',
});
const b = app.board.createCard({
	title: 'smoke B',
	state: 'Ready',
	priority: 1,
	description: 'Create a file named smoke-b.txt whose only contents are the single letter B.',
	acceptanceCriteria: 'smoke-b.txt exists in the repo root and contains exactly B',
});

console.log(`created ${a.id} "smoke A" priority 10`);
console.log(`created ${b.id} "smoke B" priority 1\n`);

let inserted: string | null = null;

app.scheduler.on('card_started', (payload: { card: { id: string; title: string } }) => {
	console.log(`▶ started   ${payload.card.id} "${payload.card.title}"`);

	// Insert a higher-priority card WHILE A is running. A queue-based scheduler
	// would still run B next; a board-driven one must pick C.
	if (payload.card.title === 'smoke A' && !inserted) {
		const c = app.board.createCard({
			title: 'smoke C',
			state: 'Ready',
			priority: 20,
			description: 'Create a file named smoke-c.txt whose only contents are the single letter C.',
			acceptanceCriteria: 'smoke-c.txt exists in the repo root and contains exactly C',
		});
		inserted = c.id;
		console.log(`  ↳ inserted ${c.id} "smoke C" priority 20 while A is still running`);
	}
});

app.scheduler.on('card_finished', (payload: { card: { id: string; title: string; state: string }; result: { status: string; completionReason: string; commitSha: string | null; worktreePath: string | null } }) => {
	executed.push(payload.card.title);
	console.log(
		`✔ finished  ${payload.card.id} "${payload.card.title}" -> ${payload.result.status} ` +
			`(${payload.result.completionReason}) state=${payload.card.state}`,
	);
	if (payload.result.worktreePath) console.log(`             worktree: ${payload.result.worktreePath}`);
});

const idle = once(app.scheduler, 'idle');
app.scheduler.start({ autoRun: true });
await idle;
await app.scheduler.stop();

console.log(`\nexecution order: ${executed.join(' -> ')}`);
const expected = ['smoke A', 'smoke C', 'smoke B'];
const ok = executed.join(',') === expected.join(',');
console.log(ok ? '✅ PASS — the board was re-read and C preempted B' : `❌ FAIL — expected ${expected.join(' -> ')}`);

console.log('\nfinal board:');
for (const card of app.board.listCards()) {
	console.log(
		`  ${card.id}  ${card.state.padEnd(8)} ${card.lastResult ?? '—'}  ` +
			`${card.branch ?? '—'}  ${card.commitSha?.slice(0, 8) ?? 'no commit'}`,
	);
	if (card.lastAgentSummary) console.log(`      summary: ${card.lastAgentSummary.slice(0, 160)}`);
	if (card.lastError) console.log(`      error:   ${card.lastError.slice(0, 200)}`);
}

app.close();
process.exit(ok ? 0 : 1);
