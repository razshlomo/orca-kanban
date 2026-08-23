---
name: orca-kanban
description: >
  Put work on the Orca Kanban board so agents execute it one card at a time.
  Use whenever the user says "add to the kanban", "add a card", "kanban this",
  "put this on the board", "queue this", "add these as cards", "break this into
  cards", "what's on the board", "run the board", "start auto-run", or asks to
  reprioritise, block, retry, or check the status of kanban cards. Also use when
  the user describes several pieces of work and wants them executed
  sequentially by agents rather than done right now in this session. Do NOT use
  for Jira/FR tickets (use the Jira skills instead), and do NOT use it to add or
  edit cards while you are yourself running as a Kanban card.
license: MIT
---

# Orca Kanban

The board is a local SQLite board that drives **sequential** agent execution: one
card at a time, each in its own Orca worktree with a fresh agent session. The
scheduler re-reads the board before every pick, so edits take effect immediately.

The interface is the `kanban` CLI.

## Before anything else: are you a card?

If the current directory (or any parent) contains `.orca-kanban/card.json`, then
**you are the agent executing that card**. In that case:

- Work only on your own card.
- Never add, move, delete, reprioritise, or retry cards.
- Put follow-up work in your final summary and in the `concerns` field of your
  result file. The human will turn it into cards.

The CLI enforces this and will refuse board writes with exit code 3. Do not pass
`--force` to get around it.

Check quickly when unsure:

```bash
kanban status
```

## Do not hijack "ticket"

"create a ticket", "open an FR", "Jira" → those mean **Jira**, not this board. Use
the Jira skills. Only use this skill for the Kanban board.

## Adding cards

Default to **Backlog**. Backlog is the staging area; nothing in Backlog ever runs.
Only add straight to `Ready` when the user says run it / start it / make it ready.

```bash
kanban card add "<short imperative title>" \
  --description "<what and why, enough for a fresh agent with no context>" \
  --acceptance "<observable, checkable outcome>" \
  --priority 10 \
  --repo /abs/path/to/repo
```

Useful flags: `--state Ready`, `--deps card_a,card_b`, `--agent omp|codex|claude`,
`--max-attempts 2`.

Rules for good cards:

- **One card = one agent session.** If it cannot plausibly be finished in a single
  session, split it.
- **Acceptance criteria are the contract.** Write something a test or a command can
  confirm. Avoid "works correctly".
- **Description must stand alone.** The executing agent sees only the card, not this
  conversation. Include file paths, endpoints, and constraints.
- **Never invent a repo.** Use the repo the user is working in, or leave `--repo`
  off to use the configured default.

### Several pieces of work

Create one card per piece and wire the order with dependencies — do not write one
fat card:

```bash
A=$(kanban card add "Add users table migration" --acceptance "migration applies and rolls back" | awk '{print $1}')
kanban card add "Expose GET /users" --deps "$A" --acceptance "returns 200 with a JSON array"
```

A card is eligible only when every dependency is in **Done**.

> Note: with the default `successState: "Review"` a finished card stops at Review,
> so dependents stay blocked until someone moves it to Done. For unattended
> chains the board must be configured with `successState: "Done"` — mention this
> rather than silently changing config.

## Reading the board

```bash
kanban card list              # ✓ marks eligible cards
kanban card list --state Ready
kanban card show <id>        # card plus full run history
kanban status                # scheduler state, current card, eligible ids
```

## Running the board

```bash
kanban serve                 # board UI on http://localhost:7420
kanban run --once            # execute exactly one card, then stop
kanban run                   # foreground loop until Ctrl+C
kanban service install       # run it in the background, from login onwards
kanban service status        # where it runs, whether it is up, and its log
```

Only one scheduler may watch a board. `serve`, `run`, `run --once` and `recover` are
refused (exit 5) while another one is alive, because two loops drive the same agent
sessions. Check `kanban status` first; stop the other one before starting yours.

Auto-run controls live in the UI, or:

```bash
curl -XPOST localhost:7420/api/scheduler/start                 # start auto-run
curl -XPOST localhost:7420/api/scheduler/pause                 # stop picking up new cards
curl -XPOST localhost:7420/api/scheduler/stop-after-current    # finish current, then stop
curl -XPOST localhost:7420/api/scheduler/stop-current          # abort the running card now
```

Tell the user which one you used and why. Prefer `run --once` when they only want
to see it work.

## Fixing stuck work

```bash
kanban card move <id> Ready      # or Backlog | Blocked | Review | Done
kanban card retry <id>           # clears the error, restores retry budget
kanban recover                   # reconcile cards stranded In Progress
```

A failed card returns to Ready while attempts remain, then lands in Blocked with
the reason on the card. Read it before retrying:

```bash
kanban card show <id>
```

## States

`Backlog` → `Ready` → `In Progress` → `Review` → `Done`, plus `Blocked`.

Each card is mirrored onto its Orca worktree, so it also appears in the matching
column of Orca's own workspace board.

## Deferring and repeating

When the user wants something looked at later, or on a cycle, put it on the board
with a schedule instead of leaving a reminder in prose:

```bash
kanban card add "Check the status of Y" --state Ready --not-before 7d
kanban card add "Weekly dependency audit" --state Ready --every 1w
kanban card snooze <id> 1w        # defer something already on the board
```

Durations are `30m`, `2h`, `7d`, `1w`, or a date like `2026-08-19`. A held card
stays in Ready and simply is not eligible until it is due, so nothing runs early.
A card created with `--every` re-arms itself each time it reaches Done.

**A schedule needs `--state Ready`.** A date on a Backlog card does nothing: Backlog
is never picked up, so the card stays parked even after the date passes. Ready plus
`--not-before` is what makes it wake by itself.

`kanban card list` says why a Ready card is not running — `(due in 7d)`,
`(waiting on card_x)`, `(no retries left)` — so check there before assuming a card
is stuck.

## A card a human is holding

`kanban card takeover <id>` interrupts a running agent and hands its session to the
person at the keyboard; `kanban card takeback <id>` gives it back to the board. While a
card is held it stays In Progress, keeps its slot, and **nothing** settles it — no result
file, no idle check, no timeout.

Never take a card back that you did not take over, and never assume a card sitting in
In Progress is stuck: check `kanban status` first, which names every held card.

## Finishing with the branch

Approving commits on the card's own branch and stops there — nothing is published. Two
ways a finished card ends, and picking the right one matters:

- `kanban card land <id>` — merges into the base branch (`--no-ff`), then removes the
  branch and worktree. For cards that produced **code**.
- `kanban card drop <id>` — deletes the branch and worktree, keeps the card, its summary
  and its trail. For cards that produced an **answer**: a "verify"/"confirm"/"check" card
  leaves notes like `FINDINGS.md` in its worktree, and those do not belong in the
  repository. Refused unless `--force` when the base branch lacks those commits.

`kanban status` lists every Done card still carrying a branch, so nothing is forgotten.

Never land on a hunch: landing is refused, with a reason, when the card is not Done, the
repository is on another branch, the base branch is dirty, the worktree has loose files,
or `verifyCommand` fails. Read the reason rather than retrying. There is deliberately no
automatic merge on approve.

## Reopening an agent conversation

A finished card's Orca terminal is closed, but its conversation is not gone: OMP stores
sessions per worktree, so `kanban card resume <id>` reopens that card's history in a new
terminal. Use it when the human asks what an agent actually did, instead of guessing from
the diff.

## Review is the human's call, not yours

A finished card stops in **Review**. `kanban card approve` and `kanban card reject`
represent a human's verdict — never run them to clear your own work, or work you
just asked an agent to do. You may help the human review:

```bash
kanban card diff <id>            # the patch, including files the agent never staged
kanban card open <id>            # open those changes as diffs in Orca
kanban card comment <id> "…"     # add a note without deciding anything
```

If the user says to approve or reject, pass their words through verbatim with
`-m`, because a rejection reason is injected into the next agent's prompt and is
the only thing that survives into the retry.

## Reporting back

After changing the board, tell the user exactly what changed: the card ids, their
states, and what will run next. Do not claim a card succeeded — the agent that runs
it decides that, and the result shows up in `kanban card show`.
