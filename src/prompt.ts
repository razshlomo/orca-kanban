import type { Card } from './types.ts';

export type PromptContext = {
	/** Where the agent must write its machine-readable outcome, relative to the worktree. */
	resultFileRel: string;
	/** Dependency cards resolved to "id — title (state)" lines. */
	dependencyLines: string[];
	branch: string | null;
	worktreePath: string | null;
};

/**
 * Renders the single-card execution prompt.
 *
 * The closing "write your outcome to <file>" contract is what makes completion
 * detection reliable: the executor reads that file instead of pattern-matching
 * the agent's TUI output.
 */
export function renderCardPrompt(card: Card, ctx: PromptContext): string {
	const dependencies = ctx.dependencyLines.length > 0 ? ctx.dependencyLines.join('\n') : 'None.';
	const acceptance = card.acceptanceCriteria.trim() || 'Not specified — use your judgement and state your assumptions.';
	const description = card.description.trim() || '(no description provided)';

	const location: string[] = [];
	if (ctx.worktreePath) location.push(`Working directory: ${ctx.worktreePath}`);
	if (ctx.branch) location.push(`Branch: ${ctx.branch}`);

	return `You are working on exactly one Kanban card.

Card ID: ${card.id}
Title: ${card.title}
${location.length > 0 ? `\n${location.join('\n')}\n` : ''}
Description:
${description}

Acceptance criteria:
${acceptance}

Dependencies:
${dependencies}

Instructions:

* Work only on this card.
* Inspect the existing repository before changing code.
* Follow repository conventions and existing AGENTS.md/instructions.
* Implement the smallest correct solution.
* Run the relevant tests.
* Run lint/typecheck where applicable.
* Do not start or select another Kanban card.
* If blocked, explain the blocker precisely.
* Before finishing, summarize files changed, tests run, and remaining concerns.

Return one status:
DONE
BLOCKED
FAILED
NEEDS_REVIEW

Report your outcome by writing this JSON file as the very last thing you do:

  ${ctx.resultFileRel}

with exactly these keys:

{
  "status": "DONE | BLOCKED | FAILED | NEEDS_REVIEW",
  "summary": "what you did, in a few sentences",
  "filesChanged": ["path/one", "path/two"],
  "testsRun": ["command -> result"],
  "lint": "result or empty string",
  "typecheck": "result or empty string",
  "concerns": "remaining risks, or empty string"
}

Write that file even when you are blocked or failing — it is how the board learns
your outcome. Write it once, at the end, after all other work is complete.
`;
}

/** Human-readable dependency lines for the prompt. */
export function dependencyLines(card: Card, lookup: (id: string) => Card | null): string[] {
	return card.dependencies.map((id) => {
		const dep = lookup(id);
		return dep ? `* ${dep.id} — ${dep.title} (${dep.state})` : `* ${id} — (unknown card, not on the board)`;
	});
}
