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

/**
 * Builds the launch command for a card that names a model.
 *
 * This is not a fallback: it is the only way a model can be delivered, because
 * `orca worktree create` accepts `--agent` and `--prompt` and has no model option at
 * all. Orca still tracks an agent started this way — `worktree ps` reports
 * `agents[].state` for any terminal running a known agent — so the completion watch,
 * the take-over detection and the final message all keep working.
 *
 * `{{model}}` receives the resolved selector (`anthropic/claude-opus-5`), never the
 * alias the card stores, so what runs is exactly what `kanban models` showed.
 */
export function buildModelCommand(agent: AgentConfig, vars: PromptVars & { model: string }): string | null {
	if (!agent.modelCommand) return null;

	return agent.modelCommand
		.replaceAll('{{model}}', shellQuote(vars.model))
		.replaceAll('{{promptFile}}', shellQuote(vars.promptFile))
		.replaceAll('{{promptFileRel}}', shellQuote(`@${vars.promptFileRel}`))
		.replaceAll('{{prompt}}', shellQuote(vars.prompt));
}
