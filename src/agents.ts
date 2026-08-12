import type { AgentConfig } from './types.ts';

/**
 * POSIX single-quote quoting, used only on the fallback path where a shell string
 * is handed to `orca terminal create --command`.
 */
export function shellQuote(value: string): string {
	if (value === '') return "''";
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export type PromptVars = {
	/** Absolute path to the rendered prompt file. */
	promptFile: string;
	/** Prompt path relative to the worktree root. */
	promptFileRel: string;
	/** Raw prompt text. */
	prompt: string;
};

/**
 * Builds the fallback shell command for an agent Orca cannot launch natively.
 *
 * The primary path never comes here: `orca worktree create --agent <id> --prompt`
 * lets Orca own the launch, which is what keeps `worktree ps` able to report the
 * agent's state and final message.
 */
export function buildFallbackCommand(agent: AgentConfig, vars: PromptVars): string | null {
	if (!agent.fallbackCommand) return null;

	return agent.fallbackCommand
		.replaceAll('{{promptFile}}', shellQuote(vars.promptFile))
		.replaceAll('{{promptFileRel}}', shellQuote(`@${vars.promptFileRel}`))
		.replaceAll('{{prompt}}', shellQuote(vars.prompt));
}
