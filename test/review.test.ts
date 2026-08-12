import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitReviewDiff } from '../src/git.ts';
import { dependencyLines, renderCardPrompt } from '../src/prompt.ts';
import { testBoard } from './helpers.ts';

import type { Board } from '../src/board.ts';

const promptFor = (board: Board, id: string): string => {
	const card = board.getCard(id);
	assert.ok(card);
	return renderCardPrompt(card, {
		resultFileRel: '.orca-kanban/result.json',
		dependencyLines: dependencyLines(card, (x) => board.getCard(x)),
		branch: null,
		worktreePath: null,
		backstory: board.backstoryFor(id),
	});
};

test('the review trail is append-only and keeps the order it was written in', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x' });

	board.addComment(card.id, 'first');
	board.addComment(card.id, 'second');
	board.approveCard(card.id, { comment: 'ship it' });

	const trail = board.commentsForCard(card.id);
	assert.deepEqual(
		trail.map((c) => [c.kind, c.body]),
		[
			['comment', 'first'],
			['comment', 'second'],
			['approved', 'ship it'],
		],
	);
	board.close();
});

test('approving lands the card in Done and records the approval', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Review' });

	const approved = board.approveCard(card.id);
	assert.equal(approved?.state, 'Done');
	assert.equal(board.commentsForCard(card.id).at(-1)?.kind, 'approved');
	board.close();
});

test('approving can land somewhere other than Done when asked', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Review' });

	assert.equal(board.approveCard(card.id, { state: 'Blocked' })?.state, 'Blocked');
	board.close();
});

test('rejecting returns the card to Ready with its retry budget restored', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Review', maxAttempts: 2 });
	// Burn the whole budget, as two failed attempts would.
	board.claimCard(card.id, 'w1');
	board.claimCard(card.id, 'w1');

	const rejected = board.rejectCard(card.id, 'the API shape is wrong');
	assert.equal(rejected?.state, 'Ready');
	assert.equal(rejected?.attemptCount, 0, 'a human asking for changes is not one of the card own failures');
	assert.ok(board.eligibleCards().some((c) => c.id === card.id), 'the card can run again');
	board.close();
});

test('a rejection without a reason is refused', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Review' });

	assert.throws(() => board.rejectCard(card.id, '   '), /reason/);
	assert.equal(board.getCard(card.id)?.state, 'Review', 'the card did not move');
	board.close();
});

test('review actions on a card that does not exist are null, not a crash', () => {
	const { board } = testBoard();
	assert.equal(board.approveCard('card_nope'), null);
	assert.equal(board.rejectCard('card_nope', 'why'), null);
	assert.equal(board.addComment('card_nope', 'hi'), null);
	board.close();
});

test('a fresh card has no backstory, so the prompt stays clean', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x' });

	const prompt = promptFor(board, card.id);
	assert.doesNotMatch(prompt, /Previous attempt/);
	assert.doesNotMatch(prompt, /Review history/);
	board.close();
});

test('a rejected card carries the reviewer reason into the next prompt', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Review' });
	board.rejectCard(card.id, 'mode() must return a number, not an array');

	const prompt = promptFor(board, card.id);
	assert.match(prompt, /CHANGES REQUESTED/);
	assert.match(prompt, /must return a number, not an array/, 'the exact words reach the agent');
	board.close();
});

test('the prompt reports how the previous attempt ended, including its error', () => {
	const { board } = testBoard();
	const card = board.createCard({ title: 'x', state: 'Ready' });
	board.claimCard(card.id, 'w1');
	const run = board.startRun(card.id, 'term_1');
	board.finishRun(run.id, {
		status: 'FAILED',
		commitSha: null,
		summary: 'got half way',
		error: 'typecheck exploded',
	});

	const prompt = promptFor(board, card.id);
	assert.match(prompt, /Attempt 1 ended as FAILED/);
	assert.match(prompt, /got half way/);
	assert.match(prompt, /typecheck exploded/);
	board.close();
});

test('an untracked file is part of the review diff — agents do not commit by default', async () => {
	const repo = mkdtempSync(path.join(tmpdir(), 'review-diff-'));
	const git = (...args: string[]): void => {
		execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
	};

	git('init', '-q');
	git('config', 'user.email', 't@t');
	git('config', 'user.name', 't');
	writeFileSync(path.join(repo, 'kept.txt'), 'original\n');
	git('add', '-A');
	git('commit', '-qm', 'base');

	// Exactly what an agent leaves behind: one edit, one brand new file.
	writeFileSync(path.join(repo, 'kept.txt'), 'edited\n');
	writeFileSync(path.join(repo, 'added.js'), 'module.exports = 1;\n');

	const diff = await gitReviewDiff(repo);
	assert.deepEqual(diff.untracked, ['added.js']);
	assert.match(diff.patch, /edited/, 'the tracked edit is there');
	assert.match(diff.patch, /added\.js/, 'the new file is there too');
	assert.match(diff.patch, /module\.exports = 1;/, 'with its contents');
	assert.equal(diff.truncated, false);
});

test('a huge diff is truncated instead of flooding the reviewer', async () => {
	const repo = mkdtempSync(path.join(tmpdir(), 'review-big-'));
	execFileSync('git', ['-C', repo, 'init', '-q']);
	writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(5000));

	const diff = await gitReviewDiff(repo, { maxBytes: 500 });
	assert.equal(diff.truncated, true);
	assert.match(diff.patch, /diff truncated at 500 bytes/);
});
