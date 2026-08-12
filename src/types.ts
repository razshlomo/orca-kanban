/**
 * Shared types for the Orca Kanban scheduler.
 *
 * Design note: no TS `enum`/`namespace`/parameter-properties anywhere in this
 * project, because Node runs these .ts files with type-stripping only
 * (no transformation). Const objects + union types instead.
 */

export const CARD_STATES = [
  'Backlog',
  'Ready',
  'In Progress',
  'Review',
  'Done',
  'Blocked',
] as const;

export type CardState = (typeof CARD_STATES)[number];

export function isCardState(v: unknown): v is CardState {
  return typeof v === 'string' && (CARD_STATES as readonly string[]).includes(v);
}

/** Status the agent reports for a single card attempt. */
export const AGENT_STATUSES = ['DONE', 'BLOCKED', 'FAILED', 'NEEDS_REVIEW'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export function isAgentStatus(v: unknown): v is AgentStatus {
  return typeof v === 'string' && (AGENT_STATUSES as readonly string[]).includes(v);
}

/** Terminal status of a CardRun row. */
export type RunStatus = AgentStatus | 'INTERRUPTED' | 'TIMEOUT' | 'RUNNING';

export type Card = {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  state: CardState;
  /** Higher wins. */
  priority: number;
  /** Lower wins; user-controlled ordering within a column. */
  order: number;
  dependencies: string[];
  /** Orca repo selector or absolute path; falls back to config.defaultRepo. */
  repo: string | null;
  agent: string | null;
  createdAt: number;
  updatedAt: number;

  /**
   * Epoch ms before which this card must not run. `null` means runnable now.
   * This is how "look at Y again in a week" is expressed.
   */
  notBefore: number | null;
  /**
   * When set, reaching Done re-arms the card `repeatEveryMs` into the future
   * instead of leaving it finished — a recurring check that keeps one history.
   */
  repeatEveryMs: number | null;

  claimedAt: number | null;
  claimedBy: string | null;

  sessionId: string | null;
  branch: string | null;
  worktreePath: string | null;
  commitSha: string | null;
  /** Orca worktree id (`<repoId>::<path>`) — this card's card on Orca's own board. */
  worktreeId: string | null;
  /** Orca orchestration Task/Dispatch ids, when provenance is enabled. */
  orcaTaskId: string | null;
  orcaDispatchId: string | null;

  attemptCount: number;
  maxAttempts: number;

  lastResult: string | null;
  lastError: string | null;
  lastAgentSummary: string | null;
};

export type CardInput = {
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  state?: CardState;
  priority?: number;
  order?: number;
  dependencies?: string[];
  repo?: string | null;
  agent?: string | null;
  maxAttempts?: number;
  notBefore?: number | null;
  repeatEveryMs?: number | null;
  id?: string;
};

export type CardRun = {
  id: string;
  cardId: string;
  sessionId: string | null;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  commitSha: string | null;
  summary: string | null;
  error: string | null;
  /** Free-form JSON blob: tests, lint, files changed, raw agent tail. */
  details: string | null;
};

/** One entry in a card's append-only review trail. */
export type CardComment = {
	id: string;
	cardId: string;
	/** `comment` is a plain note; `approved` and `rejected` are review verdicts. */
	kind: 'comment' | 'approved' | 'rejected';
	author: string;
	body: string;
	createdAt: number;
};

/**
 * Everything a fresh agent needs to know about what already happened on its card:
 * the reviewer's words, and how the last attempt ended. Without this a rejected
 * card re-runs blind and repeats the mistake that got it sent back.
 */
export type CardBackstory = {
	comments: CardComment[];
	previousAttempt: {
		attempt: number;
		status: string;
		summary: string | null;
		error: string | null;
	} | null;
};

/** What the agent wrote to its result file, if anything. */
export type AgentResultFile = {
  status: AgentStatus;
  summary?: string;
  filesChanged?: string[];
  testsRun?: string[];
  lint?: string;
  typecheck?: string;
  concerns?: string;
};

/** Everything the executor collected for one attempt. */
export type ExecutionResult = {
  status: AgentStatus | 'TIMEOUT';
  /**
   * How the executor learned the agent had finished.
   *   agent-done   - Orca reported agents[].state === 'done' (native, preferred)
   *   result-file  - the agent's result JSON appeared and parsed
   *   interrupted  - Orca reported the agent was interrupted
   *   gone         - the worktree/agent vanished from Orca
   *   timeout      - cardTimeoutMs elapsed
   *   stopped      - operator aborted the card
   */
  completionReason: 'agent-done' | 'result-file' | 'interrupted' | 'gone' | 'timeout' | 'stopped';
  sessionId: string | null;
  runId: string;
  branch: string | null;
  worktreePath: string | null;
  worktreeId: string | null;
  commitSha: string | null;
  summary: string | null;
  error: string | null;
  /** Orca's own `lastAssistantMessage` for the agent — the final response. */
  agentResponse: string | null;
  filesChanged: string[];
  testsRun: string[];
  lint: string | null;
  typecheck: string | null;
  concerns: string | null;
  startedAt: number;
  finishedAt: number;
};

export type AgentConfig = {
  /**
   * Orca's own agent id, passed to `orca worktree create --agent <id>`.
   * Orca ships support for omp (oh-my-pi), claude, codex, cursor, grok, opencode,
   * pi, droid and more, so the prompt is delivered by Orca itself.
   */
  orcaAgentId: string;
  /**
   * Fallback only, for an agent this Orca build does not know: the shell command
   * used with `terminal create --command`. `{{promptFile}}` / `{{promptFileRel}}`
   * / `{{prompt}}` are substituted.
   */
  fallbackCommand: string | null;
};

export type KanbanConfig = {
  enabled: boolean;
  autoRun: boolean;
  pollIntervalMs: number;
  /**
   * Hard ceiling on cards executing at once, board-wide. Enforced inside the claim
   * transaction, so no number of daemons, UI clicks or `run --once` calls can exceed
   * it. 1 keeps execution strictly sequential.
   */
  maxConcurrent: number;
  defaultAgent: string;
  maxAttempts: number;
  /** Where a successful card lands. */
  successState: 'Review' | 'Done';
  /**
   * What approving a card does with the work sitting in its worktree.
   *
   * Agents do not commit, so `off` leaves an approved card reading Done while the
   * repository has nothing — the work is loose files. `commit` puts it on the card's
   * own branch, which is preserved and reviewable without touching the base branch.
   */
  landOnApprove: 'commit' | 'off';
  /** Orca repo selector or path used when a card does not name one. */
  defaultRepo: string | null;
  /** Base ref for each card's worktree; null uses the repo default. */
  baseBranch: string | null;
  /** Repo setup-hook policy for created worktrees. */
  setupPolicy: 'run' | 'skip' | 'inherit';
  /** Remove the Orca worktree after a card completes successfully. */
  removeWorktreeOnSuccess: boolean;
  /** Close the card's Orca agent terminal once the card settles. */
  closeSessionWhenDone: boolean;
  /**
   * Mirror card state onto the Orca worktree's workspaceStatus so each card shows
   * up in the correct column of Orca's own workspace board.
   */
  mirrorToOrcaBoard: boolean;
  /** Card state -> Orca workspaceStatus id. */
  orcaStatusMap: Record<CardState, string>;
  /** Ignore Orca's agent state until the agent has had time to register. */
  startupGraceMs: number;
  /** How often to sample Orca's native agent state. */
  agentPollIntervalMs: number;
  /** Consecutive `done` samples required before a card is settled. */
  doneConfirmations: number;
  /** Hard ceiling for one card attempt. */
  cardTimeoutMs: number;
  /** Identity used when claiming cards. */
  workerId: string;
  /**
   * After Orca reports the agent done, how long to keep waiting for the result file
   * before believing it. The prompt asks the agent to write that file last, and Orca
   * reports `done` between steps, so a short wait here is the difference between a
   * correct DONE and a card that fails with its work already finished.
   */
  resultGraceMs: number;
  /** HTTP port for the board API + UI. */
  port: number;
  /** Recovery policy for cards found stranded in "In Progress". */
  recoveryPolicy: 'ready' | 'blocked';
  /** Register each card run as an Orca orchestration Task + Dispatch. */
  orchestration: {
    enabled: boolean;
    objective: string;
    runId: string | null;
  };
  agents: Record<string, AgentConfig>;
};

export type SchedulerRunState = 'stopped' | 'idle' | 'running' | 'paused' | 'stopping';

export type SchedulerStatus = {
  runState: SchedulerRunState;
  autoRun: boolean;
  currentCardId: string | null;
  currentRunId: string | null;
  currentSessionId: string | null;
  /**
   * Every card the owning scheduler is executing. `currentCardId` above is the
   * oldest of these, so single-slot readers see no change.
   */
  inFlight: Array<{ cardId: string; runId: string; sessionId: string | null }>;
  startedAt: number | null;
  lastCardFinishedAt: number | null;
  cardsExecuted: number;
  stopAfterCurrent: boolean;
};

export type BoardEvent =
  | 'card_selected'
  | 'card_claimed'
  | 'session_started'
  | 'agent_started'
  | 'agent_idle'
  | 'card_completed'
  | 'card_blocked'
  | 'card_failed'
  | 'retry_scheduled'
  | 'scheduler_idle'
  | 'card_recovered'
  | 'session_closed'
  | 'board_changed'
  | 'scheduler_state';
