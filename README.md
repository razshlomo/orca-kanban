# Orca Kanban

Kanban-driven **sequential** agent execution for Orca ADE.

One card = one agent session = one git worktree. Exactly one card runs at a time, and
**the board is re-read from storage before every single selection** — so cards you add,
delete, reprioritise, or block while an agent is working take effect immediately.

There is deliberately **no queue**. The loop is:

```
while running:
    card = board.getNextEligibleCard()   # fresh SQLite read, every iteration
    if card is None:
        waitForBoardChangeOrPoll()       # stay idle, never exit
        continue
    result = executeOneCard(card)        # fresh Orca worktree + fresh agent session
    board.persistResult(card, result)
    # loop again from the board, never from a snapshot
```

---

## How it works

Orca already owns most of the primitives, so this project uses them rather than
reimplementing them:

| Concern | Owner |
| --- | --- |
| Worktree + branch per card | `orca worktree create` |
| Agent launch **and prompt delivery** | `orca worktree create --agent omp --prompt …` |
| "Is the agent finished?" | `orca worktree ps` → `agents[].state === 'done'` |
| Final agent response | `orca worktree ps` → `agents[].lastAssistantMessage` |
| Board columns / progress text | `orca worktree set --workspace-status … --comment …` |
| Task + Dispatch provenance | `orca orchestration task-create` / `dispatch` |
| Session cleanup | `orca orchestration worker-release`, else `orca terminal close` |
| **Scheduling** | this project (Orca explicitly does not schedule) |
| priority, board order, dependencies, retries, run history, atomic claim | this project (SQLite) |

Card outcome (`DONE` / `BLOCKED` / `FAILED` / `NEEDS_REVIEW`) comes from a small JSON
file the agent writes as its last action. Orca reports *liveness*, not verdicts, so the
file is the only way to distinguish "blocked" from "needs review".

### Card states → Orca board columns

The SQLite board is authoritative; each card is mirrored onto its Orca worktree so it
appears in the right column of Orca's own workspace board. Every state change mirrors —
the scheduler's own transitions, and manual moves from the CLI, the UI and the API — so
the two boards cannot drift. Cards that have never run have no worktree yet, so they
exist only on the SQLite board until their first attempt.

| Card state | Orca `workspaceStatus` |
| --- | --- |
| Backlog | `backlog` |
| Ready | `ready` |
| In Progress | `in-progress` |
| Review | `in-review` |
| Done | `completed` |
| Blocked | `blocked` |

Orca's built-in columns are `todo` / `in-progress` / `in-review` / `completed`; it also
accepts custom ids, which is why `backlog`, `ready`, and `blocked` work. Remap them with
`orcaStatusMap` if you prefer the built-ins.

---

## Install

Requirements: the Orca desktop app running (`orca status`), Node ≥ 22.5, and the agent
CLI you want (`omp`, `codex`, `claude`, `cursor`, …) on `PATH`.

```bash
git clone https://github.com/razshlomo/orca-kanban.git ~/.orca-kanban
cd ~/.orca-kanban
npm install                     # typescript, for `npm run typecheck` only — runtime has zero deps
cp config.example.json config.json   # then set "defaultRepo"
./integrations/install.sh       # `kanban` on PATH + agent skill + AGENTS.md pointer
kanban doctor
```

`install.sh` is idempotent. It writes a `kanban` wrapper to `~/bin` (or `~/.local/bin`),
copies the skill to `~/.claude/skills/orca-kanban/` — which **omp and Claude Code both
read** — and appends a pointer block to `~/.codex/AGENTS.md` and `~/AGENTS.md` for codex
and cursor.

### Agent integration

Once installed, saying *"add to the kanban"*, *"add a card"*, *"kanban this"*,
*"put this on the board"*, or *"break this into cards"* makes the agent use the board.

`create a ticket` / `FR` / `Jira` deliberately do **not** trigger it, so it never fights
a Jira workflow.

Claude Code users can install it as a plugin instead of running the script:

```
/plugin marketplace add razshlomo/orca-kanban
```

**Worker guard.** The scheduler launches agents as card workers, and those workers load
the same skill. To stop a running card from editing the board it is being executed from,
the CLI refuses board writes whenever `.orca-kanban/card.json` exists in the working
directory or any parent, exiting with code 3. Reads (`card list`, `card show`, `status`)
still work, and a human can override with `--force`.

`doctor` verifies the Orca runtime, the agent mapping, the repo, and orchestration:

```
orca runtime:   reachable (v1.4.179)
default agent:  omp -> orca --agent omp
default repo:   /Users/you/src/your-repo
success state:  Review
orca board:     mirroring
orchestration:  available
repo resolved:  a1b2c3d4-… /Users/you/src/your-repo
```

Create `~/.orca-kanban/config.json` (JSON, matching the documented shape 1:1):

```json
{
  "enabled": true,
  "autoRun": false,
  "pollIntervalMs": 2000,
  "defaultAgent": "omp",
  "defaultRepo": "/Users/you/src/your-repo",
  "maxAttempts": 2,
  "successState": "Review",
  "agents": {
    "omp": { "orcaAgentId": "omp" },
    "codex": { "orcaAgentId": "codex" }
  }
}
```

A nested `{ "kanban": { … }, "agents": { … } }` layout is also accepted.

Then start the board and scheduler:

```bash
kanban serve                # http://localhost:7420
kanban serve --auto-run     # …and start picking up cards immediately
```

### Configuring OMP (and other agents)

`omp` is a first-class Orca agent id, so Orca launches it and delivers the prompt:

```json
"agents": { "omp": { "orcaAgentId": "omp" } }
```

Orca also knows `claude`, `codex`, `cursor`, `grok`, `opencode`, `pi`, and others. To add
one, name its Orca agent id:

```json
"agents": { "codex": { "orcaAgentId": "codex" } }
```

For an agent Orca cannot launch natively, supply a shell fallback. Placeholders:
`{{promptFile}}`, `{{promptFileRel}}`, `{{prompt}}`.

```json
"agents": {
  "mytool": { "orcaAgentId": "mytool", "fallbackCommand": "mytool --yes {{promptFileRel}}" }
}
```

Per-card override: `--agent codex` on `card add`, or the Agent selector in the UI.

---

## Creating cards

```bash
kanban card add "Add rate limiting to /login" \
  --description "Limit to 5 attempts per minute per IP." \
  --acceptance "429 after 5 attempts; unit test covers the boundary" \
  --priority 20 \
  --state Ready \
  --deps card_ab12cd34 \
  --repo /Users/you/src/api \
  --agent omp \
  --max-attempts 2
```

Other commands:

```bash
kanban card list [--state Ready]   # ✓ marks eligible cards
kanban card show <id>              # card + full run history
kanban card move <id> Ready
kanban card retry <id>
kanban card rm <id>
kanban status
kanban recover
kanban run [--once]
```

Cards default to **Backlog**. Only **Ready** cards are ever executed, so Backlog is your
staging area. The UI (`+ Card`, then drag) and the HTTP API do the same thing.

### Eligibility

A card runs only when **all** of these hold:

- `state == Ready`
- not already claimed
- every id in `dependencies` is a card in state `Done`
- `attemptCount < maxAttempts`

An unknown dependency id keeps the card ineligible on purpose — a typo blocks the card
rather than silently letting it run.

### Prioritisation

1. `priority` (higher first)
2. `order` (lower first — drag to reorder)
3. `createdAt` (older first)

> With `successState: "Review"` (the default) a finished card stops at Review and never
> reaches Done, so **dependent cards stay blocked until you move the dependency to Done**.
> Use `"successState": "Done"` for unattended dependency chains.

---

## How auto-run behaves

`autoRun` decides whether the loop *picks cards up*; the loop itself stays alive either
way, so a paused scheduler resumes without a restart.

| Control | CLI / API | Effect |
| --- | --- | --- |
| Start auto-run | `POST /api/scheduler/start` | loop starts and begins picking cards |
| Pause auto-run | `POST /api/scheduler/pause` | finishes nothing new; loop stays alive |
| Stop after current card | `POST /api/scheduler/stop-after-current` | current card completes, then auto-run turns off |
| Stop current card | `POST /api/scheduler/stop-current` | aborts now: interrupts the agent and closes the session |
| Run exactly one card | `kanban run --once` | single iteration, then exit |
| Enable/disable | `POST /api/scheduler/autorun {"enabled":false}` | toggle |

When nothing is eligible the scheduler logs `scheduler_idle` and **waits** — it does not
exit. It wakes on a board change in-process, and otherwise polls every
`pollIntervalMs`, so a card added later is picked up automatically.

Timing knobs: Orca reports no agent for the first seconds after launch, so
`startupGraceMs` (default 12 s) suppresses early samples and `doneConfirmations`
(default 2) requires repeated `done` samples. `cardTimeoutMs` (default 45 min) is the
hard ceiling per attempt.

---

## Reviewing a card

With the default `successState: "Review"` a finished card **stops** and waits for a
human. Nothing advances it on its own, because eligibility requires `state == Ready`.

Look at what the agent actually produced:

```bash
kanban card diff <id>          # the full patch, new files included
kanban card open <id>          # open those changes as diffs in Orca
kanban card open <id> --session  # jump to the agent's own terminal tab
```

`card diff` exists because `git diff` alone is misleading here: agents do not commit by
default, so their work is usually **untracked** and invisible to a plain diff. The patch
is measured from the merge-base and renders new files as additions.

Then decide:

```bash
kanban card approve <id> -m "matches the spec"
kanban card reject  <id> -m "mode() must return a number, not an array"
kanban card comment <id> "a question that is not a verdict"
```

| Action | Card goes to | Effect |
| --- | --- | --- |
| `approve` | Done | Verdict recorded in the review trail. |
| `reject` | Ready | Retry budget restored, **and your reason is injected into the next agent's prompt**. |
| `comment` | unchanged | A note on the trail; the next agent reads it too. |

A rejection **requires** a reason, and refuses without one. That reason is the whole
mechanism: a rejected card gets a brand-new agent session with no memory, so the words
you write are the only thing that travels. The next prompt gains:

```
Previous attempt on this card:
Attempt 1 ended as DONE.
What that attempt reported: …

Review history, oldest first. The most recent CHANGES REQUESTED is why this card
came back to you — address it specifically:
* [CHANGES REQUESTED] human: mode() must return a number, not an array
```

The trail lives in `card_comments`, is append-only, and is visible in the UI card panel
beside an inline diff and the two "open in Orca" buttons.

### Plan first, then implement

To put a human decision *before* the work, use two cards and a dependency — no special
feature needed. The implementation card is ineligible until you approve the plan:

```bash
PLAN=$(kanban card add "Plan: statistics helpers" \
  --description "Produce a plan only. Write it to PLAN.md. Do not write implementation code." \
  --state Ready --priority 20 --repo /path/to/repo | awk '{print $1}')

kanban card add "Implement the approved plan" \
  --description "PLAN.md was reviewed and approved by a human. Treat it as the spec." \
  --state Ready --priority 10 --deps "$PLAN" --repo /path/to/repo
```

Run the board: the plan card executes, lands in Review, and the scheduler then reports
`no eligible cards` — it will not implement anything until you move the plan card to
Done.

> **Approving means landing the artifact.** Every card gets a *fresh worktree from the
> base branch*, so an uncommitted `PLAN.md` sitting in the planner's worktree is
> invisible to the next card. Commit it (and merge it to the base branch) as part of
> approving, or the implementer is told to follow a spec it cannot read.

---

## Recovering and retrying cards

A card that fails is returned to **Ready** while `attemptCount < maxAttempts`, and moves
to **Blocked** once the budget is gone. Every attempt is kept in `card_runs`.

Retry by hand (clears the error and restores the budget):

```bash
kanban card retry <id>     # or the Retry button in the card panel
```

### Crash recovery

On startup (`serve`, `run`, or `recover`) every card left in **In Progress** is
reconciled against Orca's live state — nothing is left stranded:

| Orca still reports | Action |
| --- | --- |
| an agent `working` or `done`, not interrupted | **adopt** — re-attach to the original run so its result file still counts |
| nothing for that worktree | **requeue** to Ready if retries remain |
| nothing, and retries exhausted (or `recoveryPolicy: "blocked"`) | **block**, with the reason on the card |

The abandoned run is marked `INTERRUPTED`, the reason is written to `lastError`, a
`card_recovered` event is logged, and a stale "running" scheduler row is cleared.

```bash
kanban recover        # or POST /api/scheduler/recover
```

---

## UI

`kanban serve` → <http://localhost:7420>

Six columns with drag-and-drop, card create/edit/delete, priority and order,
dependencies, agent and repo per card, retry, run history, live scheduler status with the
current card and Orca session id, and all five scheduler controls. The auto-run button is
a toggle that reflects the scheduler's real state rather than a fixed label.

Selecting a card opens a review panel: an inline diff of what the agent produced,
**Open changes in Orca** and **Open session** buttons, a comment box, **Approve** and
**Request changes**, and the card's append-only review trail.

It is otherwise intentionally minimal: Orca's own workspace board already shows each
card's column, progress comment, and agent, so this UI only adds what Orca has no
columns for.

---

## HTTP API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/state` | board + scheduler + eligible ids + recent events |
| GET/POST | `/api/cards` | list / create |
| PATCH/DELETE | `/api/cards/:id` | edit / delete |
| POST | `/api/cards/:id/move` | `{ "state": "Ready", "order": 3 }` |
| POST | `/api/cards/:id/retry` | restore retry budget |
| GET | `/api/cards/:id/runs` | run history |
| POST | `/api/cards/:id/approve` | accept the work → Done |
| POST | `/api/cards/:id/reject` | send it back → Ready, reason required |
| GET/POST | `/api/cards/:id/comments` | read or append to the review trail |
| GET | `/api/cards/:id/diff` | the card patch, untracked files included |
| POST | `/api/cards/:id/open` | open `changes` or `session` in Orca |
| POST | `/api/cards/reorder` | `{ "ids": [...] }` |
| POST | `/api/scheduler/{start,pause,autorun,stop-after-current,stop-current,run-once,recover}` | controls |

---

## Storage

SQLite at `~/.orca-kanban/board.sqlite` (WAL, `busy_timeout`), overridable with
`ORCA_KANBAN_DB`. `ORCA_KANBAN_HOME` relocates everything.

- `cards` — the board, plus `worktree_id`, `orca_task_id`, `orca_dispatch_id`
- `card_runs` — append-only history (status, commit, summary, error, details)
- `events` — the event log the UI shows
- `scheduler_state` — singleton row with run state and `board_revision`

Claiming is a single guarded `UPDATE … WHERE state='Ready' AND claimed_by IS NULL AND
attempt_count < max_attempts AND <deps Done>` inside `BEGIN IMMEDIATE`. SQLite decides
the winner, so multiple workers are safe — verified with 8 concurrent processes racing
one card: exactly one wins.

Prompt/result handshake files live in `<worktree>/.orca-kanban/` (added to
`.git/info/exclude` so the worktree never looks dirty) and are archived to
`~/.orca-kanban/runs/<runId>/` when the card settles.

---

## Logging

JSON lines to stderr and `~/.orca-kanban/scheduler.log`, every line carrying `cardId`,
`sessionId`, and `runId` where known:

`card_selected` · `card_claimed` · `session_started` · `agent_started` · `agent_idle` ·
`card_completed` · `card_blocked` · `card_failed` · `retry_scheduled` · `scheduler_idle` ·
`card_recovered` · `session_closed`

---

## Tests

```bash
npm test          # 109 tests
npm run typecheck
node scripts/smoke.ts /path/to/repo   # live: real Orca, real worktrees, real agents
```

The suite includes the dynamic-scheduling proof: board `A(10)`, `B(1)`; `C(20)` inserted
**while A is running**; expected `A → C → B`. It also covers cards blocked, deleted, or
reprioritised mid-run, dependency gating, claim atomicity across OS processes, and crash
recovery. `scripts/smoke.ts` reproduces the same scenario against real OMP agents.

---

## Known Orca limitations and compromises

1. **Orca does not schedule.** Its own docs state a Run "never schedules or places
   workers", and `coordinator-start` is retired. The loop had to be built here.
2. **Orca's task store cannot represent this board.** Its tasks have no `priority`, no
   board order, no `acceptanceCriteria` field, no retry counters, and its statuses are
   `pending/ready/dispatched/completed/failed/blocked` — no Backlog or Review. Hence the
   SQLite sidecar, linked by `orca_task_id` / `orca_dispatch_id`.
3. **`worker-release` only settles `worker-start` dispatches.** A low-level `dispatch`
   returns `dispatch_not_found`; the executor falls back to `terminal close`. (This leaked
   three terminals in the first live run and is now covered by a regression test.)
4. **`terminal wait --for exit` is not usable for agents** — `--command` runs inside an
   interactive shell that outlives the command. `tui-idle` also reports idle while the
   shell is still at its prompt before the agent takes over. Native
   `worktree ps` agent state avoids both traps.
5. **Orca reports liveness, not verdicts.** `agents[].state` has no notion of blocked vs
   needs-review, so the four-way outcome needs the result file. If an agent finishes
   without writing it, the status is recovered from `lastAssistantMessage`, and failing
   that the card is `FAILED` with an explicit reason.
6. **Agents do not commit by default.** `commitSha` is null unless the card asks for a
   commit; uncommitted changes are noted in `concerns`.
7. **Orchestration is experimental** and must stay enabled in Settings → Experimental.
   If it is off, provenance is skipped with a warning and execution continues.
8. **Every Orca call is a CLI round trip** (~0.4–1 s), which is why the board itself is
   local SQLite rather than RPC — the scheduler re-reads it on every iteration and the UI
   polls it every 1.5 s.
9. **Orchestration Run binding is per-terminal.** A daemon has no Orca terminal, so every
   call passes `--run <id>` explicitly.
10. **Custom board columns** (`backlog`, `ready`, `blocked`) are accepted by the CLI, but
    to see them as real columns you may need to configure them in Orca's board settings;
    otherwise remap via `orcaStatusMap`.
11. **A rejected card gets a *new* worktree, not its old one.** Orca de-duplicates the
    worktree name (`…-<cardId>-2`), so the second attempt starts from the base branch and
    the first attempt's uncommitted work stays behind. The agent is not flying blind — it
    receives the previous summary and your reason in the prompt — but it rebuilds rather
    than edits. The abandoned worktree is parked in a `superseded` column so it stops
    looking like live work; its files are left alone for you to inspect or delete.
12. **A workspace status cannot be cleared, only set.** `orca worktree set` takes
    `--workspace-status <id>` and nothing that means "none", so retiring a card uses a
    custom `superseded` id rather than an empty one. Passing an empty value silently
    changes nothing.
13. **Agent artifacts must be committed to cross a card boundary.** A file written but not
    committed is invisible to the next card, since each card gets a fresh worktree from
    the base branch.

---

## License

MIT — see [LICENSE](LICENSE).
