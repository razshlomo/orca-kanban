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
and cursor. Pass `--service` to also install the background service (see
[Settings and the background service](#settings-and-the-background-service)).

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

Every field above is also editable from the UI (**Settings**) or the API, so config.json
is a starting point rather than the only way in — see
[Settings and the background service](#settings-and-the-background-service).

Then start the board and scheduler:

```bash
kanban serve                # http://localhost:7420
kanban serve --auto-run     # …and start picking up cards immediately
kanban service install      # …or run it in the background, from login onwards
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

`resultGraceMs` (default 3 min) is the one worth understanding. Orca reports an agent
as `done` between steps, and the prompt asks the agent to write its result file **last**,
so `done` is not proof of finishing. After a confirmed `done` with no result file the
executor keeps watching for that file, and an agent that returns to `working` cancels the
countdown entirely. Seen in the wild before this existed: Orca said done at 14:37:36, the
agent wrote a perfectly good `status: DONE` at 14:39:51, and the card was failed twice
with its work already complete.

---

## Which column starts automatically

Only **Ready**. This is the one rule to keep in mind:

| Column | Picked up by auto-run? |
| --- | --- |
| Backlog | **never** — it is the parking column |
| Ready | yes, as soon as it is eligible |
| In Progress / Review / Done / Blocked | no |

So a **scheduled card belongs in Ready, not Backlog**. A date on a Backlog card does
nothing: the card stays parked even when the date has passed, because eligibility
requires `Ready`. That is deliberate — parking a card must mean it cannot start.

`kanban card snooze` therefore leaves the card in **Ready** and uses `notBefore` to
hold it there. It wakes by itself when due, with nobody moving it between columns:

```
kanban card add "Weekly dependency audit" --state Ready --not-before 7d --every 1w
```

### Why a Ready card is sitting still

A held card looks identical to a runnable one, so both `card list` and the UI now say
the reason:

```
card_b0c4a533  Ready  P0     0/2  Weekly dependency audit  (due in 7d)
card_38757046  Ready  P0     0/2  Ship the API             (waiting on card_0649d0b3)
card_dc6bd0c8  Ready  P0     1/1  Flaky migration          (no retries left)
```

A `✓` marks a card that is genuinely runnable right now. `kanban status` also reports
`next due`, which is when the loop will next wake up on its own.

### "auto-run on" with nothing running

The scheduler row is stored in SQLite, so it outlives the process that wrote it — a
`kanban run` that exited, or a daemon that crashed, both used to leave `status`
claiming *idle, auto-run on* while nothing was watching the board. It now checks the
owning pid and its heartbeat:

```
scheduler: not running (scheduler process 73348 is gone) · start it with: kanban serve
```

The UI shows the same as a red **not running** pill.

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
| `approve` | Done | **Commits the work on the card branch**, records the sha, files the verdict. |
| `reject` | Ready | Retry budget restored, **and your reason is injected into the next agent's prompt**. |
| `comment` | unchanged | A note on the trail; the next agent reads it too. |

### Approving lands the work

Agents do not commit, so their changes are usually loose files in a worktree. Approving
therefore **commits them on the card's own branch** and stores the sha on the card —
otherwise the board reads Done while the repository has nothing, which is exactly what
happened before this existed. Merging into the base branch stays yours (a merge, a PR, a
cherry-pick), because that is the step that can break somebody else's build.

```json
{ "landOnApprove": "commit" }
```

Set it to `"off"` to leave the worktree untouched. The commit message carries the card
title, the agent's own summary, and the card id. The card panel warns while work is
uncommitted, and shows the short sha once it is committed.

### Landing a card on the base branch

Approving publishes nothing. It commits on the card's own branch and stops, so a finished
card leaves a branch behind — and those accumulate quietly until something says so:

```
$ kanban status
unlanded:  9 Done cards still carrying a branch
  card_18374d02 · kanban-verify-the-slack-cost-alerts-18374d02 · land or drop it
```

Cards come in two kinds, and only one of them has anything to merge:

| Kind of card | What the deliverable is | How it ends |
| --- | --- | --- |
| Code — "add a divide function" | the branch | `kanban card land <id>` |
| A question — "confirm the alert self-silenced" | the answer, already on the board | `kanban card drop <id>` |

That second row is most cards, in practice. An investigation agent leaves notes in its
worktree — typically `FINDINGS.md` — and merging those would push scratch notes into the
repository. Several such cards write the *same* filenames, so merging the second one is
a conflict by construction. Dropping keeps the card, its summary and its whole review
trail, and throws away only the branch.

```bash
kanban card land <id>                 # merge --no-ff into the base branch, then dispose
kanban card land <id> --keep-branch   # merge, leave the branch and worktree alone
kanban card drop <id>                 # delete branch + worktree, keep the card and trail
kanban card drop <id> --force         # ... even though the base branch lacks those commits
```

**Landing is never automatic.** There is no `landOnApprove: "merge"`, on purpose: the
board runs no tests of its own (a card reaches Review because an agent said it was
finished), cards branch from the base when they *start*, so a card approved days later
would land stale work, and every other board action is recoverable while a pushed merge
is public history.

What it refuses, and why — the same sentence from the CLI, the API and the button's
tooltip:

| Refusal | Meaning |
| --- | --- |
| `not-done` | only an approved card can be landed |
| `held-by-you` | you have taken this card by hand; take it back first |
| `nothing-committed` | the card produced no commit |
| `worktree-dirty` | loose files the merge would leave behind, named |
| `base-not-checked-out` | the repository is on another branch — it is never switched under you |
| `base-dirty` | your own uncommitted work would be mixed in |
| `nothing-to-merge` | the base branch already has it |
| `verify-failed` | the gate below failed; its output is included |
| `conflict` | the merge was aborted, nothing changed, the files are named |
| `already-landed` | it has a merge sha already |

A conflict leaves **nothing** behind: the merge is aborted, `HEAD` does not move, and the
branch is not disposed of, so retrying after a rebase is safe.

Because the board itself never runs tests, one setting can insist on evidence before the
shared branch changes. It runs inside the *card's* worktree, and its output is shown on
failure:

```json
{ "verifyCommand": "npm test" }
```

Dropping a branch the base does not contain is refused once and needs `--force` (the UI
asks for confirmation), because that is the case where dropping destroys work. After
landing, dropping is free.

### The board refuses what makes no sense

Validation lives in the board, so the CLI, the API and the UI all get it:

| Action | Allowed when | Otherwise |
| --- | --- | --- |
| `approve` / `reject` | card is **Review** or **Blocked** | 409, exit 4 — a card with no result has nothing to judge |
| `delete` / `retry` / `snooze` | card is not **In Progress** | 409 — stop the card first, or `--force` to delete anyway |
| `run-once` | a slot is free | 409 naming how many are busy |

A refused verdict is checked **before** anything is committed, so a rejected approval
cannot leave a commit behind. In the UI every button that cannot apply is disabled with the
reason as its tooltip, rather than failing when pressed.

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

## How many cards run at once

`maxConcurrent` (default **1**) is a hard ceiling on cards executing at the same
time, board-wide:

```json
{ "maxConcurrent": 3 }
```

That goes in **`~/.orca-kanban/config.json`** — create the file if it does not exist.
Config is read once at startup, so restart the board afterwards:

```
omp hub restart kanban-board
```

For a single run instead of permanently: `kanban run --max-concurrent 3`.

Two things enforce it, and the second is the one that matters:

1. The scheduler loop fills at most `maxConcurrent` slots, starting a new card the
   moment any lane frees rather than waiting for the whole batch.
2. **The claim itself refuses to exceed it.** The count lives inside the same
   `BEGIN IMMEDIATE` transaction that moves a card `Ready -> In Progress`:

```sql
AND (SELECT COUNT(*) FROM cards WHERE state = 'In Progress') < :maxConcurrent
```

So the limit holds across *processes*, not just inside one loop. Two daemons, a UI
click and a `kanban run --once` racing for the last slot cannot all win — SQLite picks
one. Without that guard a second `kanban serve --auto-run` would silently double your
agent count.

`kanban status` shows the occupancy and every lane:

```
slots:     2/3 in flight
  running: card_5eb1d168 · session term_03bc4a5c…
  running: card_1a6ba9dd · session term_e14bdd7a…
```

Stop one lane without touching the others:

```bash
curl -XPOST localhost:7420/api/scheduler/stop-current -d '{"cardId":"card_5eb1d168"}'
```

The UI card panel has the same control as **Stop this card now**, and the header shows
`n/N slots`.

> Raising this multiplies real agents against real repos. Each card still gets its own
> worktree, so they do not fight over files, but they do share your machine, your API
> quota, and any service the tests talk to.

---

## Scheduling work for later

A card can be held until a moment in the future. `notBefore` is checked by the same
eligibility query that gates state, claims, retries and dependencies — so nothing runs
early, and no cron is involved:

```bash
# look at this in a week
kanban card add "Check the status of Y" --state Ready --not-before 7d

# or defer something already on the board
kanban card snooze card_ab12cd34 1w
kanban card snooze card_ab12cd34 2026-08-19
```

Durations are `30m`, `2h`, `7d`, `1w`, or compound `1w2d`; a bare number means minutes.
Anything unparseable is an error rather than a silently wrong date. A held card sits in
**Ready** with a `due in 6d` tag, and `kanban status` reports the next wake-up:

```
next due:  in 7d (8/19/2026, 2:39:01 PM)
```

### Recurring checks

`--every <duration>` makes a card re-arm itself instead of finishing. When it reaches
Done — whether a human approved it or `successState: "Done"` finished it unattended —
it returns to **Ready** with a fresh retry budget and its next due time:

```bash
kanban card add "Weekly dependency audit" --state Ready --every 1w \
  --description "Check for outdated dependencies and report what changed."
```

All occurrences share one card, so `card_runs` accumulates the whole series and
`kanban card show` reads as a history of that recurring job. Set the interval later from
the UI's **Repeat every** field, or clear it by patching `repeatEveryMs` to null.

> For work that does not belong on the board at all, Orca has its own scheduler:
> `orca automations create --trigger cron|rrule --prompt … --provider omp`. Use the board
> when you want the run tracked, reviewable and dependency-aware; use an automation for
> fire-and-forget prompts.

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

Six columns with drag-and-drop, live scheduler status, and all five scheduler controls.
The auto-run button is a toggle that reflects the scheduler's real state rather than a
fixed label, and every control that cannot apply is disabled with the reason as its
tooltip.

### The card panel

Selecting a card opens a panel with a fixed header, a scrolling body, and one action bar
that never scrolls away. Four collapsible sections keep it short, and the one that matters
for the card's state is open when it opens:

| Section | Holds | Open by default |
| --- | --- | --- |
| The work | title, description, acceptance criteria | always |
| How it runs | priority, order, tries, repo, agent, dependencies, schedule, retry/stop/delete | no |
| Review | agent summary, diff, **Resume conversation**, verdict, review trail | when the card is in Review or Blocked |
| Runs and technical | run history, worktree, session, commit | no |

### Taking a running card by hand

Sometimes an agent is going the wrong way and you want the keyboard, mid-turn, without
losing its conversation or its worktree. **Take over** does that:

```
kanban card takeover <id>      # interrupt the agent and take its session
kanban card takeback <id>      # give supervision back to the board
```

Pressing **Esc** in the agent terminal does the same thing, when Orca reports the agent
(see the limitation below). Either way the card enters one clear mode:

| While the card is yours | |
| --- | --- |
| Column | stays **In Progress** — nothing was judged, so nothing moves |
| Slot | **stays held**: you occupy the lane you are working in |
| Terminal | never closed |
| Result file | ignored |
| Idle / timeout | **no clock at all** — it is yours until you hand it back |
| Delete / Hold / Retry | still refused, because the agent and worktree are live |
| Editing the card text | allowed |

The card shows a purple left border, a `yours 5m` tag, and a `1 yours` count in the
header, because a held card only moves when you come back to it.

**Take back** restarts the board’s watch on the same live session, reusing the original
run — so the agent’s result file is still the one the board is waiting for. It is the same
code path crash recovery uses, which is why it works two minutes later or after an Orca
restart, when no watch loop exists at all.

Recovery never touches a held card. It reports it and stops:

```
inspected 0 · adopted 0 · requeued 0 · blocked 0 · held 1
```

**Two limitations worth knowing.**

The Esc gesture needs Orca to report the agent for that worktree. Orca tracks agents it
launched into a pane; for some worktrees it reports `agents: []` with a live terminal, and
there the board cannot see an interrupt at all — such cards settle purely by result file,
as they always have. **Take over from the board works either way**, because it writes the
marker itself instead of waiting to be told.

Any interrupt hands the card over, including one you did not cause — a rate limit, a
crashed tool. That is better than the old behaviour (marked FAILED, terminal closed,
evidence gone), but such a card waits for you rather than retrying. The header count and
`kanban status` are what stop it going unnoticed.
### Reopening the agent conversation

A card's Orca terminal closes when the card settles (`closeSessionWhenDone`), because one
dead terminal per card would bury Orca. The conversation is not lost: OMP keys its session
store by working directory, and every card runs in its own worktree.

So **Resume conversation** in the card panel opens a fresh Orca terminal in that worktree
running `omp --continue`, which reopens that card's history and no other:

```
kanban card resume <id>
```

Configured per agent, so a different CLI can be resumed its own way:

```json
{ "agents": { "omp": { "resumeCommand": "omp --continue" } } }
```

Set it to `null` for an agent with no resume story — the button then disables itself and
says which agent lacks one. Defaults ship for `omp`, `claude` and `codex`.

### How long has this been waiting

`stateChangedAt` records the moment a card last changed column, which `updatedAt` cannot:
renaming a card bumps `updatedAt` but tells you nothing about how long a review has been
sitting. Cards in **Review** and **Blocked** therefore show their age, and those two
columns sort oldest-first so the longest wait is on top:

```
card_18374d02  Review  P10  1/2  Verify the Slack cost alerts fired  (waiting 53m)
```
**One Save.** It persists everything editable, schedule included — there is no separate
"save the repeat" or "apply the hold". The button is disabled until something actually
changes, then reads `Unsaved changes` → `Saving…` → `Saved`, and a failure shows the
server's reason in the same place. **Revert** restores the card as the board has it.

Unsaved work is safe: the 1.5s poll refuses to redraw a panel with pending edits, and
switching cards, closing the panel, or reloading the page asks first. Verdicts report
through the same footer, so there is one place to look for "did that work".

It is otherwise intentionally minimal: Orca's own workspace board already shows each
card's column, progress comment, and agent, so this UI only adds what Orca has no
columns for.

---

## Settings and the background service

The board can configure itself and run itself. **Settings** in the header opens one
panel with both halves: the service manager on top, every editable `config.json` field
below.

```bash
kanban service install                 # run it in the background from now on
kanban service install --no-autostart  # install it, but start it by hand
kanban service status                  # manager, unit path, pid, log
kanban service restart | stop | start
kanban service autostart off           # keep the unit, stop starting it at login
kanban service uninstall
```

### It is a per-user agent, not a system daemon

On macOS this is a **LaunchAgent** in `~/Library/LaunchAgents/co.orca.kanban.plist`,
bootstrapped into `gui/<uid>`; on Linux a systemd **user** unit in
`~/.config/systemd/user/`. Not a LaunchDaemon, and not a system unit — the scheduler
drives Orca through its CLI, and Orca is a desktop app living in your login session. A
system-context daemon cannot reach it, so every `worktree create` would fail.

Two consequences worth knowing:

- **PATH is captured at install time.** launchd starts jobs with a bare `PATH` and no
  shell profile, so the unit carries the `PATH` of the shell that installed it. Install
  from a normal terminal, or the service will not find `orca`, `omp`, `claude`.
- **The interpreter is pinned to a stable path.** `process.execPath` resolves to a
  version-pinned real path (`…/Cellar/node/26.6.0/bin/node`), which the next upgrade
  deletes. If `PATH` holds a symlink to the same binary (`/opt/homebrew/bin/node`), that
  is what gets written into the unit instead.

### "Always on" is one switch, deliberately

launchd starts a `KeepAlive` job at load whether `RunAtLoad` is set or not, so "restart
forever but do not start at login" is not a state the manager can hold. One checkbox:

| Always on | Effect |
| --- | --- |
| on | starts at login, comes back after a crash |
| off | installed and idle; `kanban service start` runs it, a crash leaves it down |

This is separate from `autoRun`. The service decides whether the **board** is up;
`autoRun` decides whether **cards** are picked up. Keeping them apart is deliberate:
otherwise logging in would silently start agents.

### Only one scheduler, ever

A second scheduler is refused rather than tolerated. The port already stopped a second
`serve`, but nothing stopped `kanban run` beside it, and two loops on one board both
drive the same agent sessions — both settling the same card, both closing the same
terminal. The board's claim transaction caps concurrent *cards*, not concurrent
*watchers*:

```
$ kanban run --once
Refusing to run "run": another scheduler is already watching this board (pid 40413).
…
  stop it:  kanban service stop
```

`serve`, `run`, `run --once` and `recover` all check first, and exit `5`. The check is
the same pid + heartbeat liveness test `kanban status` uses, so a crashed owner never
blocks a restart — which is what makes an always-on service safe to kill and respawn.

### Settings that need a restart, and ones that do not

Nearly everything applies in place: the executor asks for `config.cardTimeoutMs` per
card, the loop for `config.maxConcurrent` per pass, so writing the value is the whole of
applying it. Two are captured once at boot and say so instead of pretending — `port`
(bound) and `orchestration.enabled` (client constructed). The panel tags them
**needs restart**, then **pending restart** once saved, and the board itself carries the
pending list until it restarts.

**Restart board** exits and lets the manager start the replacement, then the panel polls
until the new process answers. It refuses while a card is running rather than
interrupting an agent's turn — unless you confirm.

### A broken config cannot lock you out

`serve` no longer dies on an unusable `config.json`; it starts on defaults, says so in
the header and in Settings, and lets you write a clean file from the UI. The alternative
under a service manager is a 10-second crash loop with no UI to fix it from. The
unreadable original is moved to `config.json.broken` rather than overwritten.

Patches are validated as a whole candidate *before* anything is written, and written by
rename — so a rejected setting changes neither the file nor the running board, and no
reader ever sees a half-written config. `enabled: false` keeps the board up with pickup
paused, for the same reason: the switch that turns it back on lives in that UI.

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
| POST | `/api/cards/:id/land` | merge into the base branch; 409 with the reason if refused |
| POST | `/api/cards/:id/drop` | delete branch + worktree; `{ "force": true }` to discard unlanded commits |
| GET | `/api/cards/:id/landable` | whether landing is possible right now, and why not |
| POST | `/api/cards/:id/open` | open `changes` or `session` in Orca |
| POST | `/api/cards/:id/snooze` | `{ "until": "7d" }` — hold the card until due |
| POST | `/api/cards/reorder` | `{ "ids": [...] }` |
| POST | `/api/scheduler/{start,pause,autorun,stop-after-current,stop-current,run-once,recover}` | controls; `stop-current` takes an optional `{ "cardId": … }` |
| GET | `/api/config` | every editable setting, its value, and whether it needs a restart |
| PATCH | `/api/config` | `{ "maxConcurrent": 2 }` — validated, then written to config.json |
| GET | `/api/service` | service manager state: installed, running, pid, always-on |
| POST | `/api/service/{install,uninstall,start,stop,restart,autostart}` | manage the background service |

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

JSON lines to `~/.orca-kanban/scheduler.log`, and to stderr unless a service manager is
running the board (in which case stderr is already redirected into the same log). Every
line carries `cardId`, `sessionId`, and `runId` where known:

`card_selected` · `card_claimed` · `session_started` · `agent_started` · `agent_idle` ·
`card_completed` · `card_blocked` · `card_failed` · `retry_scheduled` · `scheduler_idle` ·
`card_recovered` · `session_closed`

The log rotates at 8 MB, keeping one previous file — a board that runs for months as a
service would otherwise grow without limit.

---

## Tests

```bash
npm test          # 248 tests
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
