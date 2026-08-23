import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BoardRuleError } from '../src/board.ts';
import { loadConfig } from '../src/config.ts';
import {
	describeDrop,
	describeLanding,
	dropCardBranch,
	landCard,
	planLanding,
	type DropOutcome,
	type LandOutcome,
	type LandRefusal,
} from '../src/land.ts';
import type { Card } from '../src/types.ts';
import { testBoard } from './helpers.ts';

const git = (repo: string, ...args: string[]): string =>
	execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/**
 * A repository shaped like a real card run: a base branch in the main working tree,
 * and the card's work committed on its own branch in a separate worktree.
 */
function repoWithCardBranch(options: { file?: string; content?: string } = {}): {
	main: string;
	worktree: string;
	branch: string;
} {
	const main = mkdtempSync(path.join(tmpdir(), 'land-main-'));
	git(main, 'init', '-q', '-b', 'main');
	git(main, 'config', 'user.email', 't@t');
	git(main, 'config', 'user.name', 't');
	writeFileSync(path.join(main, 'base.txt'), 'base\n');
	git(main, 'add', '-A');
	git(main, 'commit', '-qm', 'base');

	const branch = 'kanban-card-work';
	const worktree = path.join(mkdtempSync(path.join(tmpdir(), 'land-wt-')), 'card');
	git(main, 'worktree', 'add', '-q', '-b', branch, worktree);
	writeFileSync(path.join(worktree, options.file ?? 'added.js'), options.content ?? 'module.exports = 1;\n');
	git(worktree, 'add', '-A');
	git(worktree, 'commit', '-qm', 'card work');

	return { main, worktree, branch };
}

/** A Done card pointing at that branch, as approving would leave it. */
function doneCard(repo: { main: string; worktree: string; branch: string }): { board: ReturnType<typeof testBoard>['board']; card: Card } {
	const { board } = testBoard();
	const card = board.createCard({ title: 'add a helper', state: 'Done' });
	board.attachSession(card.id, {
		sessionId: null,
		worktreeId: null,
		worktreePath: repo.worktree,
		branch: repo.branch,
	});
	board.recordCommit(card.id, git(repo.worktree, 'rev-parse', 'HEAD'));
	return { board, card: board.getCard(card.id) as Card };
}

/** Removes the worktree the way the app does, but without Orca. */
const removeWorktree = async (p: string): Promise<void> => {
	git(path.dirname(p), 'worktree', 'prune');
	execFileSync('git', ['-C', p, 'worktree', 'remove', '--force', p], { stdio: 'ignore' });
};

const worktreeRemover = (main: string) => ({
	removeWorktree: async (p: string): Promise<void> => {
		execFileSync('git', ['-C', main, 'worktree', 'remove', '--force', p], { stdio: 'ignore' });
	},
});

const commitCount = (repo: string): number => Number(git(repo, 'rev-list', '--count', 'HEAD'));
const headParents = (repo: string): number => git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(/\s+/).length - 1;
const branches = (repo: string): string[] => git(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);
const refused = (outcome: LandOutcome): LandRefusal => {
	if (outcome.landed) throw new Error('expected a refusal, but it landed');
	return outcome.reason;
};

test('landing merges the card branch into the base branch and disposes of it', async () => {
	const repo = repoWithCardBranch();
	const { board, card } = doneCard(repo);

	const outcome = await landCard(card, loadConfig({}), worktreeRemover(repo.main));
	assert.equal(outcome.landed, true, describeLanding(outcome));
	if (!outcome.landed) throw new Error('unreachable');

	assert.equal(outcome.plan.base, 'main');
	// --no-ff on purpose: the card boundary has to stay visible in the history.
	assert.equal(headParents(repo.main), 2, 'a merge commit, not a fast-forward');
	assert.ok(existsSync(path.join(repo.main, 'added.js')), 'the work is actually on main');
	assert.equal(outcome.disposed, true);
	assert.ok(!branches(repo.main).includes(repo.branch), 'the branch is gone');
	assert.ok(!existsSync(repo.worktree), 'the worktree is gone');

	const landed = board.recordLanding(card.id, outcome.sha, outcome.plan.base, outcome.disposed);
	assert.equal(landed?.landedSha, outcome.sha);
	assert.ok(landed?.landedAt);
	// The card keeps its history but no longer claims a branch that does not exist.
	assert.equal(landed?.branch, null);
	assert.equal(landed?.worktreePath, null);
	assert.match(
		board.commentsForCard(card.id).map((m: { body: string }) => m.body).join('\n'),
		/Landed on main/,
		'the trail says where the work went',
	);
});

test('disposal is reported from what is true, not from who managed to do it', async () => {
	const repo = repoWithCardBranch();
	const { card } = doneCard(repo);

	// Exactly what Orca does: `worktree rm` takes the branch with the worktree, and then
	// reports a failure anyway. Trusting the exit codes said "branch kept" for a branch
	// that no longer existed, and sent the reader off to drop it.
	const orcaLike = {
		removeWorktree: async (p: string): Promise<void> => {
			execFileSync('git', ['-C', repo.main, 'worktree', 'remove', '--force', p], { stdio: 'ignore' });
			execFileSync('git', ['-C', repo.main, 'branch', '-D', repo.branch], { stdio: 'ignore' });
			throw new Error('orca said it failed');
		},
	};

	const outcome = await landCard(card, loadConfig({}), orcaLike);
	assert.equal(outcome.landed, true, describeLanding(outcome));
	if (!outcome.landed) throw new Error('unreachable');
	assert.equal(outcome.disposed, true, 'the branch is gone, so say so');
	assert.match(describeLanding(outcome), /branch and worktree removed/);
});

test('--keep-branch lands the work and leaves the branch alone', async () => {
	const repo = repoWithCardBranch();
	const { card } = doneCard(repo);

	const outcome = await landCard(card, loadConfig({}), worktreeRemover(repo.main), { keepBranch: true });
	assert.equal(outcome.landed, true, describeLanding(outcome));
	assert.equal(headParents(repo.main), 2);
	assert.ok(branches(repo.main).includes(repo.branch), 'the branch survives');
	assert.ok(existsSync(repo.worktree), 'and so does the worktree');
});

test('only an approved card can be landed', async () => {
	const repo = repoWithCardBranch();
	const { board, card } = doneCard(repo);
	board.moveCard(card.id, 'Review');

	const outcome = await planLanding(board.getCard(card.id) as Card, loadConfig({}));
	assert.equal(refused(outcome), 'not-done');
	assert.equal(commitCount(repo.main), 1, 'nothing was merged');
});

test('a card you are holding by hand is not landed underneath you', async () => {
	const repo = repoWithCardBranch();
	const { board, card } = doneCard(repo);
	board.moveCard(card.id, 'In Progress');
	board.handToHuman(card.id, 'taken');
	// Landing reads the card, not the lane, so the state is put back deliberately.
	board.moveCard(card.id, 'Done');

	assert.equal(refused(await planLanding(board.getCard(card.id) as Card, loadConfig({})), ), 'held-by-you');
});

test('a card with nothing committed has nothing to land', async () => {
	const repo = repoWithCardBranch();
	const { board } = testBoard();
	const card = board.createCard({ title: 'no commit', state: 'Done' });
	board.attachSession(card.id, {
		sessionId: null,
		worktreeId: null,
		worktreePath: repo.worktree,
		branch: repo.branch,
	});

	assert.equal(refused(await planLanding(board.getCard(card.id) as Card, loadConfig({}))), 'nothing-committed');
});

test('loose files in the card worktree block the merge that would leave them behind', async () => {
	const repo = repoWithCardBranch();
	const { card } = doneCard(repo);
	writeFileSync(path.join(repo.worktree, 'forgotten.txt'), 'not committed\n');

	const outcome = await planLanding(card, loadConfig({}));
	assert.equal(refused(outcome), 'worktree-dirty');
	assert.match(describeLanding(outcome), /forgotten\.txt/, 'it names the file');
});

test('a dirty base branch is refused, because the merge would mix in your work', async () => {
	const repo = repoWithCardBranch();
	const { card } = doneCard(repo);
	writeFileSync(path.join(repo.main, 'mine.txt'), 'work in progress\n');

	assert.equal(refused(await planLanding(card, loadConfig({}))), 'base-dirty');
	assert.equal(commitCount(repo.main), 1, 'nothing was merged');
});

test('a repository sitting on another branch is never switched underneath you', async () => {
	const repo = repoWithCardBranch();
	const { card } = doneCard(repo);
	git(repo.main, 'checkout', '-q', '-b', 'something-else');

	const outcome = await planLanding(card, loadConfig({}));
	assert.equal(refused(outcome), 'base-not-checked-out');
	assert.match(describeLanding(outcome), /something-else/, 'it says where the repository actually is');
});

test('landing twice is refused, not repeated', async () => {
	const repo = repoWithCardBranch();
	const { board, card } = doneCard(repo);

	const first = await landCard(card, loadConfig({}), worktreeRemover(repo.main), { keepBranch: true });
	assert.equal(first.landed, true, describeLanding(first));
	if (!first.landed) throw new Error('unreachable');
	board.recordLanding(card.id, first.sha, 'main', false);

	const again = await landCard(board.getCard(card.id) as Card, loadConfig({}), worktreeRemover(repo.main));
	assert.equal(refused(again), 'already-landed');
	assert.equal(headParents(repo.main), 2, 'still exactly one merge');
});

test('work the base branch already contains reports nothing to merge', async () => {
	const repo = repoWithCardBranch();
	const { card } = doneCard(repo);
	git(repo.main, 'merge', '-q', '--no-ff', '-m', 'landed by hand', repo.branch);

	assert.equal(refused(await planLanding(card, loadConfig({}))), 'nothing-to-merge');
});

test('a conflict changes nothing and says which file disagreed', async () => {
	const repo = repoWithCardBranch({ file: 'shared.txt', content: 'from the card\n' });
	const { card } = doneCard(repo);
	// The same file, edited differently on the base branch after the card branched.
	writeFileSync(path.join(repo.main, 'shared.txt'), 'from main\n');
	git(repo.main, 'add', '-A');
	git(repo.main, 'commit', '-qm', 'main edits the same file');
	const before = git(repo.main, 'rev-parse', 'HEAD');

	const outcome = await landCard(card, loadConfig({}), worktreeRemover(repo.main));
	assert.equal(refused(outcome), 'conflict');
	assert.match(describeLanding(outcome), /shared\.txt/);
	// The important part: no half-finished merge left for the next command to trip on.
	assert.equal(git(repo.main, 'rev-parse', 'HEAD'), before, 'HEAD did not move');
	assert.equal(git(repo.main, 'status', '--porcelain'), '', 'the working tree is clean');
	assert.ok(branches(repo.main).includes(repo.branch), 'and the branch was not disposed of');
});

test('a failing verify command stops the merge and keeps its output', async () => {
	const repo = repoWithCardBranch();
	const { card } = doneCard(repo);

	const outcome = await landCard(
		card,
		loadConfig({ verifyCommand: 'echo "3 tests failed" && exit 1' }),
		worktreeRemover(repo.main),
	);
	assert.equal(refused(outcome), 'verify-failed');
	assert.match(describeLanding(outcome), /3 tests failed/, 'the reader sees why');
	assert.equal(commitCount(repo.main), 1, 'nothing was merged');
});

test('a passing verify command lands the work and is reported as the gate', async () => {
	const repo = repoWithCardBranch();
	const { card } = doneCard(repo);

	// Proves it runs in the CARD worktree, not the base: this file only exists there.
	const outcome = await landCard(
		card,
		loadConfig({ verifyCommand: 'test -f added.js' }),
		worktreeRemover(repo.main),
	);
	assert.equal(outcome.landed, true, describeLanding(outcome));
	if (!outcome.landed) throw new Error('unreachable');
	assert.equal(outcome.verified, true);
	assert.equal(headParents(repo.main), 2);
});

test('dropping refuses to throw away commits the base branch does not have', async () => {
	const repo = repoWithCardBranch();
	const { card } = doneCard(repo);

	const outcome = await dropCardBranch(card, loadConfig({}), worktreeRemover(repo.main));
	assert.equal(outcome.dropped, false);
	if (outcome.dropped) throw new Error('unreachable');
	assert.equal(outcome.reason, 'unlanded');
	assert.equal(outcome.unlandedCommits, 1);
	assert.match(describeDrop(outcome), /1 commit the base branch does not/);
	assert.ok(existsSync(repo.worktree), 'nothing was removed');
});

test('forcing a drop discards the work deliberately and keeps the card', async () => {
	const repo = repoWithCardBranch();
	const { board, card } = doneCard(repo);
	board.addComment(card.id, 'the answer was yes', { author: 'human' });

	const outcome = await dropCardBranch(card, loadConfig({}), worktreeRemover(repo.main), { force: true });
	assert.equal(outcome.dropped, true, describeDrop(outcome));
	assert.ok(!existsSync(repo.worktree));
	assert.ok(!branches(repo.main).includes(repo.branch));
	assert.match(describeDrop(outcome), /discarding 1 unlanded commit/);

	const dropped = board.recordDrop(card.id, describeDrop(outcome));
	assert.equal(dropped?.branch, null);
	assert.equal(dropped?.worktreePath, null);
	assert.equal(dropped?.state, 'Done', 'the card itself is untouched');
	// The whole point of dropping rather than deleting: the answer survives.
	assert.match(board.commentsForCard(card.id).map((m: { body: string }) => m.body).join('\n'), /the answer was yes/);
});

test('after landing, dropping needs no force at all', async () => {
	const repo = repoWithCardBranch();
	const { board, card } = doneCard(repo);

	const landed = await landCard(card, loadConfig({}), worktreeRemover(repo.main), { keepBranch: true });
	assert.equal(landed.landed, true, describeLanding(landed));
	if (!landed.landed) throw new Error('unreachable');
	board.recordLanding(card.id, landed.sha, 'main', false);

	const outcome = await dropCardBranch(board.getCard(card.id) as Card, loadConfig({}), worktreeRemover(repo.main));
	assert.equal(outcome.dropped, true, describeDrop(outcome));
	if (!outcome.dropped) throw new Error('unreachable');
	assert.equal(outcome.unlandedCommits, 0);
});

test('a running card and a held card both refuse to have their branch dropped', () => {
	const { board } = testBoard();
	const running = board.createCard({ title: 'running', state: 'In Progress' });
	assert.throws(() => board.assertDroppable(board.getCard(running.id) as Card), BoardRuleError);

	board.handToHuman(running.id, 'taken');
	board.moveCard(running.id, 'Done');
	assert.throws(() => board.assertDroppable(board.getCard(running.id) as Card), /holding this card by hand/);
});

test('a card with no branch has nothing to drop', async () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'never ran', state: 'Done' });

	const outcome = await dropCardBranch(board.getCard(card.id) as Card, loadConfig({}), {
		removeWorktree: async () => {
			throw new Error('should not be called');
		},
	});
	assert.equal(outcome.dropped, false);
	if (outcome.dropped) throw new Error('unreachable');
	assert.equal(outcome.reason, 'nothing-to-drop');
});

test('unlandedCards is what makes forgotten branches visible', () => {
	const { board } = testBoard();
	const withBranch = board.createCard({ title: 'has a branch', state: 'Done' });
	board.attachSession(withBranch.id, { sessionId: null, worktreeId: null, worktreePath: '/tmp/x', branch: 'b' });
	const plain = board.createCard({ title: 'never ran', state: 'Done' });
	const ready = board.createCard({ title: 'not finished', state: 'Ready' });
	board.attachSession(ready.id, { sessionId: null, worktreeId: null, worktreePath: '/tmp/y', branch: 'c' });

	const ids = board.unlandedCards().map((c) => c.id);
	assert.deepEqual(ids, [withBranch.id], 'only finished work that still carries a branch');
	assert.ok(!ids.includes(plain.id));
	assert.ok(!ids.includes(ready.id));

	board.recordLanding(withBranch.id, 'deadbeefdeadbeef', 'main', false);
	assert.deepEqual(board.unlandedCards().map((c) => c.id), [], 'landing takes it off the list');
});

test('every refusal reads as a sentence, so no state is a dead end', () => {
	const reasons: LandRefusal[] = [
		'not-done',
		'held-by-you',
		'no-branch',
		'nothing-committed',
		'worktree-dirty',
		'already-landed',
		'no-main-worktree',
		'no-base-branch',
		'base-not-checked-out',
		'base-dirty',
		'nothing-to-merge',
		'verify-failed',
		'conflict',
		'failed',
	];
	for (const reason of reasons) {
		const text = describeLanding({ landed: false, reason, detail: 'x' } as LandOutcome);
		assert.ok(text.length > 12, `${reason} needs a real explanation, got "${text}"`);
		assert.ok(!/undefined|\[object/.test(text), `${reason} leaked a placeholder: ${text}`);
	}

	const drops: DropOutcome[] = [
		{ dropped: false, reason: 'nothing-to-drop' },
		{ dropped: false, reason: 'unlanded', unlandedCommits: 2 },
		{ dropped: false, reason: 'failed', detail: 'boom' },
	];
	for (const outcome of drops) {
		const text = describeDrop(outcome);
		assert.ok(text.length > 12 && !/undefined|\[object/.test(text), `weak text: ${text}`);
	}

	assert.match(
		describeLanding({ landed: true, sha: 'abcdef1234567', plan: { mainWorktree: '/m', branch: 'b', base: 'main', standing: { ahead: 1, behind: 0, merged: false } }, disposed: true, verified: false }),
		/merged abcdef12 into main \(branch and worktree removed\)/,
	);
});

test('the merge message names the card, so history explains itself', async () => {
	const repo = repoWithCardBranch();
	const { board, card } = doneCard(repo);

	const outcome = await landCard(board.getCard(card.id) as Card, loadConfig({}), worktreeRemover(repo.main));
	assert.equal(outcome.landed, true, describeLanding(outcome));

	const message = git(repo.main, 'log', '-1', '--pretty=%B');
	assert.match(message, /Land add a helper into main/);
	assert.match(message, new RegExp(`Landed from Kanban ${card.id}`));
});

void removeWorktree;
