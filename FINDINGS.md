# Card review findings — 2026-08-13

Five findings. Four reported, one hit while reproducing them. Each has the evidence that
proves it, the cause, the decision taken, and how the fix was verified.

All five are fixed and covered by tests: 175 total, 12 of them new here.

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | No sense of when a card entered its current state | medium | fixed |
| 2 | Agent session is closed with no way back to it | high | fixed |
| 3 | Agent summary is hard to read | medium | fixed |
| 4 | Scroll inside the panel resets every 1.5s | high | fixed |
| 5 | A port collision crashes with a stack trace, after starting the scheduler | medium | fixed |

---

## 1. No sense of when a card entered its current state

**Reported:** "it is hard to understand when card moved to the state lately (when i want to
review)."

**Evidence.** A card carries `createdAt` and `updatedAt`, and `updatedAt` moves on *any*
edit — renaming the title bumps it, so it cannot answer "how long has this been waiting for
me". Nothing recorded the moment a card changed column.

**Cause.** No `state_changed_at` column. The `events` table has `card_moved` rows, but they
are an append-only audit log, not indexed for this, and cards moved before the log existed
have none.

**Decision.** Add `stateChangedAt`, set on every state transition — claim, move, retry,
verdict, snooze-with-state, recovery. Surface it as a relative age wherever a card's state
is shown, and sort the Review column by it so the card waiting longest is on top.

---

## 2. Agent session is closed with no way back to it

**Reported:** "the session is closed (tab closed in orca) once the ticket is done/review
without easy ability to review the session. not sure just keeping it is the right solution.
maybe option to resume the same session? we need to consider."

**Evidence.** `closeSessionWhenDone` defaults to `true`, so `executor.ts` closes the Orca
terminal once the card settles. The panel's **Open session** button is then permanently
disabled with "The session is closed; open the changes instead" — the diff survives, the
conversation appears not to.

It does survive. OMP keys its session store by working directory:

```
~/.omp/agent/sessions/-orca-workspaces-…-kanban-verify-the-slack-cost-alerts-18374d02/
  2026-08-13T13-11-49-277Z_019ffb40-….jsonl   127 KB
```

That directory name is the card's own worktree path, slugified, and the transcript is intact
after the tab closed. `omp --continue` resumes the newest session for the current directory,
and `omp --resume <id>` picks a specific one.

**Decision.** Keeping tabs open is the wrong fix — it clutters Orca with one dead terminal
per card, which is why `closeSessionWhenDone` exists. Instead, add **Resume session**: open a
fresh Orca terminal in the card's worktree running `omp --continue`. The conversation comes
back with full history, on demand, and nothing is kept open that nobody is reading.

This also means a closed session is no longer a dead end during review, which was the real
complaint.

---

## 3. Agent summary is hard to read

**Reported:** "card in review - agent summary is hard to read."

**Evidence.** The summary rendered in the same `<pre>` used for file paths and session ids:
11px, muted grey, monospace, wrapped at 220px tall. Agent summaries are prose — often several
paragraphs with `-` bullets and backticked identifiers — and that treatment fights every one
of those.

**Decision.** Give the summary its own block: body font at 12px, line-height 1.55, normal text
colour, bullets kept as list-like lines, inline `code` spans styled, and a taller cap with a
**Show more** toggle rather than a hard clip. Keep `<pre>` for the things that really are
machine strings.

---

## 4. Scroll inside the panel resets every 1.5s

**Reported:** "the text summary text box scroll doesn't work."

**Evidence.** It scrolls, then loses the position:

```
set pre.scrollTop = 150   (scrollHeight 412, clientHeight 218)
2.2s later                → scrollTop 0
```

**Cause.** `renderPanel` rewrites `#panelBody.innerHTML` on every 1.5s poll. The container's
own `scrollTop` survives, but every child is destroyed and rebuilt, so any scroll position
inside a `<pre>` or `<textarea>` is lost. Reading anything longer than the box is impossible.

**Decision.** Stop redrawing when nothing changed: build a signature of the card, its runs and
its comments, and skip the DOM write when it matches the last render. When a redraw is
genuinely needed, preserve the scroll position of the summary block and the panel body. This
also removes ~40 needless DOM rebuilds a minute.

---

## 5. A port collision crashes with a stack trace, after starting the scheduler

**Found while reproducing the above**, when a second board hit the port of one already
running.

My first reading of this was wrong and is worth recording: the hub's log is cumulative
across restarts, so I saw a success banner followed by `EADDRINUSE` and concluded the banner
printed before the bind. It does not — it is already inside the `listen` callback, and that
banner belonged to an earlier, successful run. A clean reproduction shows no banner at all:

```
node:events:505
    throw er; // Unhandled 'error' event
Error: listen EADDRINUSE: address already in use :::7420
    at Server.setupListenHandle [as _listen2] (node:net:2245:16)
    … 8 more lines of Node internals
```

Two real problems remain:

1. **No `error` handler on the server.** A taken port produces an unhandled `error` event and
   twelve lines of Node internals, when the useful message is one sentence.
2. **The scheduler starts before the bind is known to have succeeded.** `server.listen` is
   called, then `scheduler.start()` runs, and only then does the bind failure arrive on the
   next tick. That start writes `owner_pid` into `scheduler_state`. So a `serve` that never
   bound can stamp its pid over a healthy board's, and `kanban status` then reports the
   scheduler as dead because that pid is gone. The liveness check added earlier makes this
   visible rather than silent, but the write should not happen at all.

**Decision.** Bind first and wait for the result. On success, start the scheduler and print
the banner. On `EADDRINUSE`, print one sentence naming the port and exit non-zero without
touching the database.

---

## Verification

Measured against the running board, not asserted.

| # | Before | After |
| --- | --- | --- |
| 1 | `updatedAt` only, which any edit moves | tiles read `waiting 53m`, panel head `Review · 53m ago`, Review sorted longest-first (53m above 48m); a rename leaves the stamp alone, a move advances it |
| 2 | **Open session** permanently disabled once closed | **Resume conversation** launched `omp --continue` in the card's worktree; the session directory still holds **exactly one** transcript, so it continued rather than forked |
| 3 | 11px muted monospace `<pre>` | `ui-sans-serif`, line-height 18.6px, paragraphs and bullets, inline `code`, scrollable |
| 4 | `scrollTop 150 → 0` within 2.2s | `scrollTop 89` held through 5s, then a real wheel gesture and a further 3.5s |
| 5 | 12 lines of Node internals, `owner_pid` stamped | one sentence, exit 1, `owner_pid` left `null` |

Each guard was mutation-checked: pointing the trigger at the wrong column, restoring the
unconditional `innerHTML` rewrite, and removing OMP's resume command each fail the
matching test.

## Left alone deliberately

- **Keeping agent terminals open.** Rejected in favour of resume; see finding 2.
- **The board scrolling horizontally below ~1100px.** Six columns need the width, and
  horizontal scroll is the normal kanban pattern. The card panel itself never scrolls
  sideways at any width tested.
- **`state_changed_at` for cards that moved before it existed.** Seeded from
  `updated_at`, so their age is approximate. Exact from here on.
