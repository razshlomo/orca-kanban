import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildFallbackCommand } from './agents.ts';
import { kanbanHome, resolveAgent } from './config.ts';
import { excludeLocally, gitSnapshot } from './git.ts';
import { CONTROL_DIR as GUARD_CONTROL_DIR, MARKER_FILE } from './guard.ts';
import { dependencyLines, renderCardPrompt } from './prompt.ts';
import { slugify } from './text.ts';
import type { Logger } from './logger.ts';
import type { OrcaApi, OrcaWorktreeStatus } from './orca.ts';
import type { OrchestrationApi } from './orchestration.ts';
import type { AgentResultFile, AgentStatus, Card, CardBackstory, ExecutionResult, KanbanConfig } from './types.ts';
import { isAgentStatus } from './types.ts';

export type ResumeTarget = {
	/** Orca worktree that already exists for this card. */
	worktreeId: string;
	worktreePath: string;
	branch: string | null;
	sessionId: string | null;
	/** Result file of the interrupted run, so its outcome is still honoured. */
	runId: string;
};

export type ExecuteContext = {
	runId: string;
	/** Aborted by "stop current card". */
	signal: AbortSignal;
	log: Logger;
	/** Called as soon as the Orca session exists, so the board can persist it. */
	onSession?: (info: {
		sessionId: string | null;
		worktreeId: string | null;
		worktreePath: string | null;
		branch: string | null;
		orcaTaskId?: string | null;
		orcaDispatchId?: string | null;
	}) => void;
	/** Set when re-attaching to a card whose worktree survived a restart. */
	resume?: ResumeTarget;
};

export type CardExecutor = (card: Card, ctx: ExecuteContext) => Promise<ExecutionResult>;

/**
 * Board column for a worktree an attempt abandoned. Orca cannot clear a status —
 * `worktree set` only takes an id — but it accepts ids beyond its own defaults, so
 * this parks superseded attempts outside "In Progress" without deleting their files.
 */
const SUPERSEDED_STATUS = 'superseded';

/** Directory inside a worktree holding the prompt + result handshake files. */
const CONTROL_DIR = GUARD_CONTROL_DIR;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0 || signal.aborted) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(() => {
		signal.removeEventListener('abort', onAbort);
		resolve();
	}, ms);
	function onAbort(): void {
		clearTimeout(timer);
		resolve();
	}
	signal.addEventListener('abort', onAbort, { once: true });
	return promise;
}

/**
 * Reads the agent's result file, tolerating a partially written one.
 *
 * A live probe caught the file existing while the agent was still writing it, so
 * "exists" is never enough — it must parse and carry a valid status.
 */
export function readResultFile(file: string): AgentResultFile | null {
	if (!existsSync(file)) return null;
	try {
		const raw = readFileSync(file, 'utf8').trim();
		if (raw === '') return null;
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		const obj = parsed as Record<string, unknown>;
		const status = typeof obj['status'] === 'string' ? obj['status'].trim().toUpperCase() : '';
		if (!isAgentStatus(status)) return null;

		return {
			status,
			summary: typeof obj['summary'] === 'string' ? obj['summary'] : undefined,
			filesChanged: Array.isArray(obj['filesChanged']) ? obj['filesChanged'].map(String) : undefined,
			testsRun: Array.isArray(obj['testsRun']) ? obj['testsRun'].map(String) : undefined,
			lint: typeof obj['lint'] === 'string' ? obj['lint'] : undefined,
			typecheck: typeof obj['typecheck'] === 'string' ? obj['typecheck'] : undefined,
			concerns: typeof obj['concerns'] === 'string' ? obj['concerns'] : undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Last-resort status recovery when the agent finished without writing its result
 * file: look for a bare status token in the final message Orca captured.
 */
export function statusFromText(text: string | null): AgentStatus | null {
	if (!text) return null;
	const lines = text.split('\n').map((l) => l.trim());
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i];
		if (!line) continue;
		const bare = line
			.replace(/^[*\->\s#`]+/, '')
			.replace(/[.*`_\s]+$/, '')
			.toUpperCase();
		if (isAgentStatus(bare)) return bare;
	}
	return null;
}

export type OrcaExecutorDeps = {
	orca: OrcaApi;
	config: KanbanConfig;
	lookupCard: (id: string) => Card | null;
	/** Reviewer comments and the last attempt, so a card sent back knows why. */
	lookupBackstory?: (id: string) => CardBackstory;
	orchestration: OrchestrationApi;
};

type CompletionOutcome = {
	reason: ExecutionResult['completionReason'];
	/** Orca's final agent message, when it reported one. */
	agentResponse: string | null;
	interrupted: boolean;
};

/**
 * Runs exactly one card in a fresh Orca session and reports what happened.
 *
 * Native-first by design:
 *  - `orca worktree create --agent <id> --prompt <text>` creates the worktree, the
 *    branch, the agent session, and delivers the prompt in one call.
 *  - completion comes from Orca's own agent lifecycle (`worktree ps` ->
 *    `agents[].state === 'done'`), not from scraping terminal output.
 *  - the agent's final response is Orca's `lastAssistantMessage`.
 *  - the card's four-way outcome (DONE/BLOCKED/FAILED/NEEDS_REVIEW) comes from the
 *    result file, because Orca reports liveness, not verdicts.
 */
export function createOrcaExecutor(deps: OrcaExecutorDeps): CardExecutor {
	const { orca, config, lookupCard, lookupBackstory, orchestration } = deps;

	return async function executeOneCard(card: Card, ctx: ExecuteContext): Promise<ExecutionResult> {
		const startedAt = Date.now();
		const base: ExecutionResult = {
			status: 'FAILED',
			completionReason: 'timeout',
			sessionId: null,
			runId: ctx.runId,
			branch: null,
			worktreePath: null,
			worktreeId: null,
			commitSha: null,
			summary: null,
			error: null,
			agentResponse: null,
			filesChanged: [],
			testsRun: [],
			lint: null,
			typecheck: null,
			concerns: null,
			startedAt,
			finishedAt: startedAt,
		};

		const repoSelector = card.repo ?? config.defaultRepo;
		if (!repoSelector && !ctx.resume) {
			return {
				...base,
				status: 'BLOCKED',
				completionReason: 'gone',
				error: 'No repo configured for this card and kanban.defaultRepo is unset.',
				finishedAt: Date.now(),
			};
		}

		const { name: agentName, agent } = resolveAgent(config, card.agent);
		const resuming = ctx.resume !== undefined;

		let sessionId: string | null = ctx.resume?.sessionId ?? null;
		let worktreeId: string | null = ctx.resume?.worktreeId ?? null;
		let worktreePath: string | null = ctx.resume?.worktreePath ?? null;
		let branch: string | null = ctx.resume?.branch ?? null;
		let createdWorktree = false;
		let orcaTaskId: string | null = card.orcaTaskId;
		let orcaDispatchId: string | null = card.orcaDispatchId;

		// The result file is keyed by run id; a resumed card keeps the original one.
		const effectiveRunId = ctx.resume?.runId ?? ctx.runId;

		try {
			if (!resuming) {
				const repo = await orca.resolveRepo(repoSelector as string);

				// The prompt has to exist before the worktree, because Orca delivers it
				// as part of agent-first creation.
				const resultFileRel = path.join(CONTROL_DIR, `result-${effectiveRunId}.json`);
				const prompt = renderCardPrompt(card, {
					resultFileRel,
					dependencyLines: dependencyLines(card, lookupCard),
					branch: null,
					worktreePath: null,
					...(lookupBackstory ? { backstory: lookupBackstory(card.id) } : {}),
				});

				const name = `kanban-${slugify(card.title, 28)}-${card.id.replace(/^card_/, '')}`;
				const wt = await orca.worktreeCreate({
					repoSelector: `id:${repo.id}`,
					name,
					baseBranch: config.baseBranch,
					comment: `Kanban ${card.id}: running`,
					agentId: agent.orcaAgentId,
					prompt,
					setup: config.setupPolicy,
				});

				worktreeId = wt.id;
				worktreePath = wt.path;
				branch = wt.branch.replace(/^refs\/heads\//, '') || null;
				sessionId = wt.agentTerminalHandle ?? null;
				createdWorktree = true;

				// A rejected card gets a brand-new worktree (Orca de-duplicates the name), so
				// the previous attempt's worktree would otherwise sit in Orca's "In Progress"
				// column for ever. Orca has no way to clear a status, but it accepts arbitrary
				// ids, so park the old one in `superseded`: out of the way, files still there.
				if (card.worktreeId && card.worktreeId !== worktreeId) {
					try {
						await orca.worktreeSet({
							selector: `id:${card.worktreeId}`,
							workspaceStatus: SUPERSEDED_STATUS,
							comment: `Kanban ${card.id}: superseded by attempt ${card.attemptCount}`,
						});
					} catch {
						// Cosmetic only — never fail a card because an old worktree is gone.
					}
				}

				// Keep the handshake dir out of git without touching a tracked .gitignore.
				mkdirSync(path.join(worktreePath, CONTROL_DIR), { recursive: true });
				await excludeLocally(worktreePath, `${CONTROL_DIR}/`);

				// Marks this worktree as "a card is running here" so the kanban CLI can
				// refuse board edits made by the card's own agent.
				writeFileSync(
					path.join(worktreePath, CONTROL_DIR, MARKER_FILE),
					JSON.stringify({ cardId: card.id, runId: ctx.runId, title: card.title, startedAt }, null, 2),
					'utf8',
				);

				// Orca launches the agent itself; this only covers agents it cannot.
				if (!sessionId) {
					const promptFile = path.join(worktreePath, CONTROL_DIR, `prompt-${effectiveRunId}.md`);
					writeFileSync(promptFile, prompt, 'utf8');
					const command = buildFallbackCommand(agent, {
						promptFile,
						promptFileRel: path.join(CONTROL_DIR, `prompt-${effectiveRunId}.md`),
						prompt,
					});
					if (!command) {
						throw new Error(
							`Orca did not return an agent terminal for agent "${agentName}" and no fallbackCommand is configured.`,
						);
					}
					const terminal = await orca.terminalCreate({
						worktreeSelector: `path:${worktreePath}`,
						title: `KANBAN ${card.id}`,
						command,
					});
					sessionId = terminal.handle;
				}

				ctx.log.event('session_started', {
					cardId: card.id,
					runId: ctx.runId,
					sessionId,
					worktreeId,
					worktreePath,
					branch,
					agent: agentName,
					orcaAgentId: agent.orcaAgentId,
				});

				// Register the run as a real Orca Task + Dispatch so this work is visible
				// in Orca's orchestration state instead of running beside it.
				if (config.orchestration.enabled && sessionId) {
					try {
						await orchestration.ensureRun(config.orchestration.objective);
						orcaTaskId = await orchestration.createTask({
							spec: `Kanban card ${card.id}: ${card.title}\n\n${card.description}`.trim(),
							title: card.title.slice(0, 80),
						});
						orcaDispatchId = await orchestration.dispatch({ taskId: orcaTaskId, handle: sessionId });
					} catch (err) {
						ctx.log.warn('orchestration registration failed; continuing without provenance', {
							cardId: card.id,
							runId: ctx.runId,
							error: (err as Error).message,
						});
					}
				}
			} else {
				ctx.log.event('session_started', {
					cardId: card.id,
					runId: ctx.runId,
					sessionId,
					worktreeId,
					worktreePath,
					branch,
					resumed: true,
				});
			}

			ctx.onSession?.({ sessionId, worktreeId, worktreePath, branch, orcaTaskId, orcaDispatchId });

			ctx.log.event('agent_started', {
				cardId: card.id,
				runId: ctx.runId,
				sessionId,
				agent: agentName,
				resumed: resuming,
			});

			if (!worktreePath) throw new Error('No worktree path resolved for this card.');

			const resultFile = path.join(worktreePath, CONTROL_DIR, `result-${effectiveRunId}.json`);
			const before = await gitSnapshot(worktreePath);
			if (!branch) branch = before.branch;

			// ------------------------------------------------------- wait for done
			const completion = await waitForAgent({
				orca,
				config,
				worktreeId,
				worktreePath,
				resultFile,
				signal: ctx.signal,
				log: ctx.log,
				cardId: card.id,
				runId: ctx.runId,
				startedAt,
			});

			ctx.log.event('agent_idle', {
				cardId: card.id,
				runId: ctx.runId,
				sessionId,
				completionReason: completion.reason,
				interrupted: completion.interrupted,
			});

			// ----------------------------------------------------------- collect
			const result = readResultFile(resultFile);
			const after = await gitSnapshot(worktreePath);

			let status: AgentStatus | 'TIMEOUT';
			let error: string | null = null;

			if (result) {
				status = result.status;
			} else if (completion.reason === 'stopped') {
				status = 'FAILED';
				error = 'Stopped by operator before the agent reported a result.';
			} else if (completion.reason === 'timeout') {
				status = 'TIMEOUT';
				error = `Card exceeded cardTimeoutMs (${config.cardTimeoutMs}ms) without a reported result.`;
			} else if (completion.reason === 'interrupted') {
				status = 'FAILED';
				error = 'Orca reported the agent session was interrupted.';
			} else {
				const fallback = statusFromText(completion.agentResponse);
				if (fallback) {
					status = fallback;
					error = `Agent did not write ${path.join(CONTROL_DIR, `result-${effectiveRunId}.json`)}; status recovered from its final message.`;
				} else {
					status = 'FAILED';
					error = `Agent session ended (${completion.reason}) without writing its result file.`;
				}
			}

			const commitSha = after.head && after.head !== before.head ? after.head : null;
			const concerns = [result?.concerns, after.dirty && !commitSha ? 'Worktree has uncommitted changes.' : null]
				.filter(Boolean)
				.join(' ');

			archiveRunFiles(effectiveRunId, worktreePath, effectiveRunId);

			// Settle the Orca Task to match the card outcome.
			if (config.orchestration.enabled && orcaTaskId) {
				try {
					await orchestration.updateTask({
						taskId: orcaTaskId,
						status: status === 'DONE' || status === 'NEEDS_REVIEW' ? 'completed' : status === 'BLOCKED' ? 'blocked' : 'failed',
						result: { cardId: card.id, status, summary: result?.summary ?? null, commitSha },
					});
				} catch {
					// Provenance is best-effort; the board remains authoritative.
				}
			}

			return {
				...base,
				status,
				completionReason: completion.reason,
				sessionId,
				branch,
				worktreePath,
				worktreeId,
				commitSha,
				summary: result?.summary ?? null,
				error,
				agentResponse: completion.agentResponse,
				filesChanged: result?.filesChanged ?? after.changedFiles,
				testsRun: result?.testsRun ?? [],
				lint: result?.lint ?? null,
				typecheck: result?.typecheck ?? null,
				concerns: concerns || null,
				finishedAt: Date.now(),
			};
		} catch (err) {
			return {
				...base,
				status: 'FAILED',
				completionReason: 'gone',
				sessionId,
				branch,
				worktreePath,
				worktreeId,
				error: `Execution error: ${(err as Error).message}`,
				finishedAt: Date.now(),
			};
		} finally {
			await closeSession({
				orca,
				orchestration,
				config,
				log: ctx.log,
				card,
				runId: ctx.runId,
				sessionId,
				aborted: ctx.signal.aborted,
				orcaDispatchId,
			});

			if (createdWorktree && config.removeWorktreeOnSuccess && worktreePath) {
				try {
					await orca.worktreeRemove(`path:${worktreePath}`);
				} catch (err) {
					ctx.log.warn('failed to remove worktree', {
						cardId: card.id,
						runId: ctx.runId,
						error: (err as Error).message,
					});
				}
			}
		}
	};
}

/**
 * Ends the card's Orca session.
 *
 * `worker-release` is preferred over `terminal close` when the run was dispatched:
 * Orca archives the worker's output first and only closes a terminal it can prove
 * belongs to that settled Dispatch.
 */
async function closeSession(args: {
	orca: OrcaApi;
	orchestration: OrchestrationApi;
	config: KanbanConfig;
	log: Logger;
	card: Card;
	runId: string;
	sessionId: string | null;
	aborted: boolean;
	orcaDispatchId: string | null;
}): Promise<void> {
	const { orca, orchestration, config, log, card, runId, sessionId, aborted, orcaDispatchId } = args;
	if (!sessionId || !config.closeSessionWhenDone) return;

	try {
		if (aborted) await orca.terminalSend({ handle: sessionId, interrupt: true });

		// worker-release only settles dispatches created by `worker-start`; a
		// low-level `dispatch` has no worker resource, so always verify and fall back.
		const released =
			config.orchestration.enabled && orcaDispatchId ? await orchestration.releaseWorker(orcaDispatchId) : false;

		if (!released) await orca.terminalClose({ handle: sessionId, tab: true });
		log.event('session_closed', { cardId: card.id, runId, sessionId });
	} catch (err) {
		log.warn('failed to close orca session', {
			cardId: card.id,
			runId,
			sessionId,
			error: (err as Error).message,
		});
	}
}

/**
 * Moves the prompt/result handshake out of the worktree into run history and clears
 * the card marker, so the worktree stops counting as "a card is running here".
 */
function archiveRunFiles(runId: string, worktreePath: string, effectiveRunId: string): void {
	const dir = path.join(kanbanHome(), 'runs', runId);
	const promptFile = path.join(worktreePath, CONTROL_DIR, `prompt-${effectiveRunId}.md`);
	const resultFile = path.join(worktreePath, CONTROL_DIR, `result-${effectiveRunId}.json`);
	const markerFile = path.join(worktreePath, CONTROL_DIR, MARKER_FILE);
	try {
		mkdirSync(dir, { recursive: true });
		if (existsSync(promptFile)) renameSync(promptFile, path.join(dir, 'prompt.md'));
		if (existsSync(resultFile)) renameSync(resultFile, path.join(dir, 'result.json'));
		if (existsSync(markerFile)) rmSync(markerFile, { force: true });
	} catch {
		// History is a convenience; never fail a card over it.
	}
}

/** Finds this card's worktree in a `worktree ps` snapshot. */
function findWorktree(
	rows: OrcaWorktreeStatus[],
	worktreeId: string | null,
	worktreePath: string | null,
): OrcaWorktreeStatus | null {
	return (
		rows.find((r) => (worktreeId && r.worktreeId === worktreeId) || (worktreePath && r.path === worktreePath)) ?? null
	);
}

/**
 * Blocks until Orca says the card's agent is finished.
 *
 * Guards, all learned from observed behaviour:
 *  1. `startupGraceMs` — Orca reports no agent at all for the first seconds after
 *     launch, so an early sample must not be read as "done".
 *  2. `doneConfirmations` — require repeated `done` samples before settling.
 *  3. A parsed result file short-circuits everything, since it is proof.
 */
async function waitForAgent(args: {
	orca: OrcaApi;
	config: KanbanConfig;
	worktreeId: string | null;
	worktreePath: string | null;
	resultFile: string;
	signal: AbortSignal;
	log: Logger;
	cardId: string;
	runId: string;
	startedAt: number;
}): Promise<CompletionOutcome> {
	const { orca, config, worktreeId, worktreePath, resultFile, signal, log, cardId, runId, startedAt } = args;
	const deadline = startedAt + config.cardTimeoutMs;

	let doneHits = 0;
	let sawAgent = false;
	let lastMessage: string | null = null;
	let missingRows = 0;
	/** When Orca first insisted the agent was done, while no result file existed yet. */
	let doneSince: number | null = null;

	while (true) {
		if (signal.aborted) return { reason: 'stopped', agentResponse: lastMessage, interrupted: false };
		if (readResultFile(resultFile)) return { reason: 'result-file', agentResponse: lastMessage, interrupted: false };
		if (Date.now() >= deadline) return { reason: 'timeout', agentResponse: lastMessage, interrupted: false };

		let rows: OrcaWorktreeStatus[];
		try {
			rows = await orca.worktreePs();
		} catch (err) {
			log.warn('worktree ps failed; retrying', { cardId, runId, error: (err as Error).message });
			await sleep(config.agentPollIntervalMs, signal);
			continue;
		}

		const row = findWorktree(rows, worktreeId, worktreePath);

		if (!row) {
			// A worktree that vanishes has been deleted or archived out from under us.
			missingRows += 1;
			if (missingRows >= 3) return { reason: 'gone', agentResponse: lastMessage, interrupted: false };
			await sleep(config.agentPollIntervalMs, signal);
			continue;
		}
		missingRows = 0;

		// Prefer the agent Orca is tracking; fall back to the newest reported one.
		const agentInfo = row.agents.find((a) => a.state !== null) ?? row.agents[0] ?? null;
		if (agentInfo?.lastAssistantMessage) lastMessage = agentInfo.lastAssistantMessage;

		if (agentInfo?.state) sawAgent = true;

		if (agentInfo?.interrupted) {
			return { reason: 'interrupted', agentResponse: lastMessage, interrupted: true };
		}

		const withinGrace = Date.now() - startedAt < config.startupGraceMs;

		if (agentInfo?.state === 'done' && (sawAgent || !withinGrace)) {
			doneHits += 1;
			if (doneHits >= config.doneConfirmations) {
				// "done" is NOT proof the agent finished: the prompt tells it to write the
				// result file as the very last thing, and Orca reports done between steps.
				// Observed in the wild: done at 14:37:36, file written at 14:39:51 — the
				// old code failed the card and threw away six minutes of real work.
				if (doneSince === null) {
					doneSince = Date.now();
					log.event('agent_idle', {
						cardId,
						runId,
						completionReason: 'awaiting-result-file',
						graceMs: config.resultGraceMs,
					});
				}
				if (Date.now() - doneSince >= config.resultGraceMs) {
					return { reason: 'agent-done', agentResponse: lastMessage, interrupted: false };
				}
			}
		} else if (agentInfo?.state === 'working') {
			// It was not finished after all — drop the countdown entirely.
			doneHits = 0;
			doneSince = null;
		} else if (!withinGrace && row.agents.length === 0 && row.liveTerminalCount === 0) {
			// No agent and no terminals left: the session ended without reporting.
			return { reason: 'gone', agentResponse: lastMessage, interrupted: false };
		}

		await sleep(config.agentPollIntervalMs, signal);
	}
}
