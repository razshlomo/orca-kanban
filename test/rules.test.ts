import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BoardRuleError } from '../src/board.ts';
import { loadConfig } from '../src/config.ts';
import { describeCommit, commitCardWork } from '../src/land.ts';
import type { Card, CardState } from '../src/types.ts';
import { parseArgs } from '../src/cli.ts';
import { testBoard } from './helpers.ts';

/** A real git repo with one commit and some unstaged agent output. */
function repoWithLooseWork(): string {
	const repo = mkdtempSync(path.join(tmpdir(), 'landing-'));
	const git = (...args: string[]): void => {
		execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
	};
	git('init', '-q');
	git('config', 'user.email', 't@t');
	git('config', 'user.name', 't');
	writeFileSync(path.join(repo, 'kept.txt'), 'base\n');
	git('add', '-A');
	git('commit', '-qm', 'base');

	// Exactly what an agent leaves: an edit plus a new file it never staged.
	writeFileSync(path.join(repo, 'kept.txt'), 'edited\n');
	writeFileSync(path.join(repo, 'added.js'), 'module.exports = 1;\n');
	return repo;
}

const dirtyCount = (repo: string): number =>
	execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' })
		.split('\n')
		.filter((l) => l.trim() !== '').length;

const commitCount = (repo: string): number =>
	Number(execFileSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());

test('approving commits the work, so Done never means "finished but nothing in the repo"', async () => {
	const repo = repoWithLooseWork();
	const { board } = testBoard();
	const card = board.createCard({ title: 'add a helper', state: 'Review' });
	board.attachSession(card.id, { sessionId: null, worktreeId: null, worktreePath: repo, branch: 'card-branch' });

	assert.equal(dirtyCount(repo), 2, 'the agent left two loose paths');

	const target = board.verdictTarget(card.id);
	assert.ok(target);
	const landing = await commitCardWork(target, loadConfig({}));

	assert.equal(landing.committed, true, describeCommit(landing));
	assert.equal(dirtyCount(repo), 0, 'the worktree is clean afterwards');
	assert.equal(commitCount(repo), 2, 'exactly one new commit');

	if (!landing.committed) throw new Error('unreachable');
	board.recordCommit(card.id, landing.sha);
	assert.equal(board.getCard(card.id)?.commitSha, landing.sha, 'the card points at the work');
});

test('the commit message names the card and carries the agent summary', async () => {
	const repo = repoWithLooseWork();
	const { board } = testBoard();
	const card = board.createCard({ title: 'add a helper', state: 'Review' });
	board.attachSession(card.id, { sessionId: null, worktreeId: null, worktreePath: repo, branch: null });
	board.persistResult(
		board.getCard(card.id) as Card,
		{
			status: 'DONE',
			completionReason: 'result-file',
			sessionId: null,
			runId: board.startRun(card.id, null).id,
			branch: null,
			worktreePath: repo,
			worktreeId: null,
			commitSha: null,
			summary: 'Added the helper and a test for it.',
			error: null,
			agentResponse: null,
			filesChanged: [],
			testsRun: [],
			lint: null,
			typecheck: null,
			concerns: null,
			startedAt: Date.now() - 10,
			finishedAt: Date.now(),
		},
		{ successState: 'Review' },
	);

	await commitCardWork(board.getCard(card.id) as Card, loadConfig({}));
	const message = execFileSync('git', ['-C', repo, 'log', '-1', '--pretty=%B'], { encoding: 'utf8' });

	assert.match(message, /add a helper/);
	assert.match(message, /Added the helper and a test for it\./, 'the summary travels into git history');
	assert.match(message, new RegExp(card.id), 'and the card id is traceable from the commit');
});

test('landing is skipped, not failed, when there is nothing to land', async () => {
	const { board } = testBoard();
	const config = loadConfig({});

	const never = board.createCard({ title: 'never ran', state: 'Review' });
	assert.deepEqual(await commitCardWork(board.getCard(never.id) as Card, config), {
		committed: false,
		reason: 'no-worktree',
	});

	const repo = mkdtempSync(path.join(tmpdir(), 'landing-clean-'));
	execFileSync('git', ['-C', repo, 'init', '-q']);
	const clean = board.createCard({ title: 'clean', state: 'Review' });
	board.attachSession(clean.id, { sessionId: null, worktreeId: null, worktreePath: repo, branch: null });
	assert.deepEqual(await commitCardWork(board.getCard(clean.id) as Card, config), {
		committed: false,
		reason: 'nothing-to-commit',
	});
});

test('landOnApprove off leaves the repository completely alone', async () => {
	const repo = repoWithLooseWork();
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Review' });
	board.attachSession(card.id, { sessionId: null, worktreeId: null, worktreePath: repo, branch: null });

	const outcome = await commitCardWork(board.getCard(card.id) as Card, loadConfig({ landOnApprove: 'off' }));
	assert.deepEqual(outcome, { committed: false, reason: 'disabled' });
	assert.equal(dirtyCount(repo), 2, 'nothing was committed');
	assert.equal(commitCount(repo), 1);
});

test('a refused verdict does not touch the repository', async () => {
	const repo = repoWithLooseWork();
	const { board } = testBoard();
	// Backlog is not reviewable, so the guard must fire BEFORE anything is committed.
	const card = board.createCard({ title: 'x', state: 'Backlog' });
	board.attachSession(card.id, { sessionId: null, worktreeId: null, worktreePath: repo, branch: null });

	assert.throws(() => board.verdictTarget(card.id), BoardRuleError);
	assert.equal(dirtyCount(repo), 2, 'the work is still loose');
	assert.equal(commitCount(repo), 1, 'no commit was made');
});

test('only Review and Blocked cards accept a verdict', () => {
	const { board } = testBoard();
	const allowed: CardState[] = ['Review', 'Blocked'];
	const refused: CardState[] = ['Backlog', 'Ready', 'In Progress', 'Done'];

	for (const state of allowed) {
		const card = board.createCard({ title: state, state });
		assert.ok(board.verdictTarget(card.id), `${state} must accept a verdict`);
	}
	for (const state of refused) {
		const card = board.createCard({ title: state, state });
		assert.throws(() => board.verdictTarget(card.id), BoardRuleError, `${state} must be refused`);
	}
	board.close();
});

test('a running card refuses delete, retry and hold, and says why', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Ready' });
	board.claimCard(card.id, 'worker-1');
	assert.equal(board.getCard(card.id)?.state, 'In Progress');

	for (const attempt of [
		() => board.deleteCard(card.id),
		() => board.retryCard(card.id),
		() => board.snoozeCard(card.id, Date.now() + 1000),
	]) {
		assert.throws(attempt, (err: Error) => err instanceof BoardRuleError && /while it is running/.test(err.message));
	}

	assert.ok(board.getCard(card.id), 'the card survived every refusal');
	board.close();
});

test('a deliberate force can still delete a running card', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Ready' });
	board.claimCard(card.id, 'worker-1');

	assert.equal(board.deleteCard(card.id, { force: true }), true);
	assert.equal(board.getCard(card.id), null);
	board.close();
});

test('a running card refuses the edits its live run is built on, and allows the rest', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Ready', repo: '/tmp/one', maxAttempts: 2 });
	const other = board.createCard({ title: 'dep', state: 'Ready' });
	board.claimCard(card.id, 'worker-1');

	for (const patch of [
		{ repo: '/tmp/two' },
		{ agent: 'codex' },
		{ maxAttempts: 5 },
		{ dependencies: [other.id] },
		{ state: 'Done' as CardState },
	]) {
		assert.throws(
			() => board.updateCard(card.id, patch),
			(err: Error) => err instanceof BoardRuleError && /while it is running/.test(err.message),
			`${Object.keys(patch)[0]} must not change under a live agent`,
		);
	}

	assert.equal(board.getCard(card.id)?.repo, '/tmp/one', 'nothing was written by a refusal');

	// The UI saves the whole card on every edit, so a patch that restates the running
	// values while changing only text has to go through.
	const edited = board.updateCard(card.id, {
		title: 'renamed mid-run',
		description: 'more detail',
		priority: 9,
		repo: '/tmp/one',
		maxAttempts: 2,
		dependencies: [],
	});
	assert.equal(edited?.title, 'renamed mid-run');
	assert.equal(edited?.priority, 9);

	assert.equal(board.updateCard(card.id, { repo: '/tmp/two' }, { force: true })?.repo, '/tmp/two', 'force still wins');
	board.close();
});

test('a card held by hand says so instead of blaming the agent', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Ready' });
	board.claimCard(card.id, 'worker-1');
	board.handToHuman(card.id, 'taken over');

	assert.throws(
		() => board.updateCard(card.id, { agent: 'codex' }),
		(err: Error) => err instanceof BoardRuleError && /holding this card by hand/.test(err.message),
	);
	board.close();
});

test('repointing the repo of a card that already has a worktree is refused in any state', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Review', repo: '/tmp/one' });
	board.attachSession(card.id, {
		sessionId: 'sess-1',
		worktreeId: 'repo::/tmp/wt',
		worktreePath: '/tmp/wt',
		branch: 'kanban/x',
	});

	assert.throws(
		() => board.updateCard(card.id, { repo: '/tmp/two' }),
		(err: Error) => err instanceof BoardRuleError && /worktree is already at \/tmp\/wt/.test(err.message),
	);
	// The branch is what makes it unsafe, so the rest of the card is still editable.
	assert.equal(board.updateCard(card.id, { title: 'renamed' })?.title, 'renamed');
	board.close();
});

test('moving a card out of In Progress is still allowed, as the escape hatch', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Ready' });
	board.claimCard(card.id, 'worker-1');

	const moved = board.moveCard(card.id, 'Ready');
	assert.equal(moved?.state, 'Ready');
	assert.equal(moved?.claimedBy, null, 'and the claim is dropped');
	// Which then unblocks the actions that were refused.
	assert.doesNotThrow(() => board.retryCard(card.id));
	board.close();
});

test('describeCommit reads as a sentence for every outcome', () => {
	assert.match(describeCommit({ committed: true, sha: 'abcdef1234', files: 1 }), /committed abcdef12 \(1 file\)/);
	assert.match(describeCommit({ committed: true, sha: 'abcdef1234', files: 3 }), /3 files/);
	assert.match(describeCommit({ committed: false, reason: 'disabled' }), /landOnApprove is off/);
	assert.match(describeCommit({ committed: false, reason: 'no-worktree' }), /never ran/);
	assert.match(describeCommit({ committed: false, reason: 'nothing-to-commit' }), /already clean/);
	assert.match(describeCommit({ committed: false, reason: 'failed', error: 'boom' }), /commit failed: boom/);
});

test('the committed sha survives a reread, so the UI can link to it', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Review' });

	assert.equal(board.recordCommit('card_nope', 'deadbeef'), null, 'an unknown card is not invented');
	assert.equal(board.recordCommit(card.id, 'deadbeefcafe')?.commitSha, 'deadbeefcafe');
	assert.equal(board.getCard(card.id)?.commitSha, 'deadbeefcafe');
	board.close();
});

test('short flags are parsed, because the usage text promises them', () => {
	// `-m` went into the positionals while only `--` was parsed, so approving with
	// -m "looks right" recorded no comment at all, and rejecting recorded "-m " in
	// front of the reason. Both are silent losses of something a person typed.
	const approve = parseArgs(['card', 'approve', 'card_1', '-m', 'looks right']);
	assert.equal(approve.flags['m'], 'looks right');
	assert.deepEqual(approve._, ['card', 'approve', 'card_1'], 'the message is not a positional');

	// Long flags keep working, including a negative number as a value.
	const long = parseArgs(['card', 'add', 'x', '--priority', '-5', '--force']);
	assert.equal(long.flags['priority'], '-5', 'a negative number is a value, not a flag');
	assert.equal(long.flags['force'], true);

	// A short flag with nothing after it is a boolean, not a swallowed argument.
	assert.equal(parseArgs(['card', 'approve', 'id', '-m']).flags['m'], true);
	assert.equal(parseArgs(['-m', '--force']).flags['m'], true, 'a flag does not eat the next flag');
});
