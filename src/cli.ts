#!/usr/bin/env node
import { createApp } from './app.ts';
import { BoardRuleError, schedulerLiveness } from './board.ts';
import { gitReviewDiff } from './git.ts';
import { describeLanding, landCardWork } from './land.ts';
import { describeResume, resumeCardSession } from './resume.ts';
import { formatRelative, parseDueAt, parseDuration } from './text.ts';
import { assertBoardWritable, CardWorkerGuardError } from './guard.ts';
import { createHttpServer } from './server.ts';
import { isCardState, type CardInput, type CardState } from './types.ts';

const USAGE = `orca-kanban — Kanban-driven sequential agent execution for Orca

Usage:
  orca-kanban serve [--port <n>] [--auto-run] [--max-concurrent <n>]
                                                 Start the board API + UI (and the scheduler)
  orca-kanban run [--once] [--max-concurrent <n>] Run the scheduler loop in the foreground
  orca-kanban card add <title> [options]         Create a card
  orca-kanban card list [--state <state>]        List cards
  orca-kanban card show <id>                     Show one card and its run history
  orca-kanban card move <id> <state>             Move a card between columns
  orca-kanban card rm <id>                       Delete a card
  orca-kanban card retry <id>                    Return a failed/blocked card to Ready
  orca-kanban card approve <id> [-m <text>]      Accept the work; card lands in Done
  orca-kanban card reject <id> -m <text>         Send it back to Ready with the reason
  orca-kanban card comment <id> <text>           Add a note to the card's review trail
  orca-kanban card diff <id>                     Show the card's changes, untracked included
  orca-kanban card open <id> [--session]         Open the changes (or session) in Orca
  orca-kanban card takeover <id>                 Interrupt the agent and take its session
  orca-kanban card takeback <id>                 Give the session back to the board
  orca-kanban card resume <id>                   Reopen the agent's conversation for a card
  orca-kanban recover                            Reconcile cards stranded In Progress
  orca-kanban status                             Show board + scheduler status
  orca-kanban doctor                             Check Orca connectivity and config

Card options:
  --description <text>   --acceptance <text>   --priority <n>
  --deps <id,id>         --repo <path|id:…>    --agent <name>
  --max-attempts <n>     --state <state>       --force (override card-worktree guard)
  --not-before <7d|ISO>  hold until due        --every <1w>  re-run on that interval

States: Backlog | Ready | "In Progress" | Review | Done | Blocked
`;

type Args = { _: string[]; flags: Record<string, string | boolean> };

function parseArgs(argv: string[]): Args {
	const out: Args = { _: [], flags: {} };
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i] as string;
		if (token.startsWith('--')) {
			const key = token.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith('--')) out.flags[key] = true;
			else {
				out.flags[key] = next;
				i += 1;
			}
		} else out._.push(token);
	}
	return out;
}

function flagStr(args: Args, key: string): string | undefined {
	const v = args.flags[key];
	return typeof v === 'string' ? v : undefined;
}

function flagNum(args: Args, key: string): number | undefined {
	const v = flagStr(args, key);
	return v === undefined ? undefined : Number(v);
}

function requireState(value: string | undefined): CardState {
	if (!isCardState(value)) throw new Error(`invalid state "${value ?? ''}"`);
	return value;
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	const command = args._[0] ?? 'help';

	if (command === 'help' || args.flags['help']) {
		process.stdout.write(USAGE);
		return 0;
	}

	// Refuse board edits made from inside a running card's own worktree. The
	// scheduler launches agents as card workers, and they load the kanban skill too.
	assertBoardWritable(command === 'card' ? `card ${args._[1] ?? ''}`.trim() : command, {
		force: args.flags['force'] === true,
	});

	// ------------------------------------------------------------------ serve
	if (command === 'serve') {
		const app = createApp({
			config: {
				...(flagNum(args, 'port') === undefined ? {} : { port: flagNum(args, 'port') as number }),
				...(args.flags['auto-run'] ? { autoRun: true } : {}),
				...(flagNum(args, 'max-concurrent') === undefined
					? {}
					: { maxConcurrent: flagNum(args, 'max-concurrent') as number }),
			},
		});

		if (!app.config.enabled) {
			process.stderr.write('kanban.enabled is false — refusing to start.\n');
			return 1;
		}

		const report = await app.recover();
		if (report.inspected > 0) {
			app.log.info('recovery complete', {
				inspected: report.inspected,
				adopted: report.adopted.length,
				requeued: report.requeued.length,
				blocked: report.blocked.length,
				held: report.held.length,
			});
		}

		const server = createHttpServer(app);
		const { promise, resolve } = Promise.withResolvers<number>();

		// Bind BEFORE starting the scheduler. `scheduler.start` stamps this process's pid
		// into scheduler_state, so a serve that never got the port would claim ownership of
		// a healthy board and then die, leaving `kanban status` pointing at a dead pid.
		const bound = await new Promise<Error | null>((done) => {
			server.once('error', (err: Error) => done(err));
			server.listen(app.config.port, () => done(null));
		});

		if (bound) {
			const taken = (bound as NodeJS.ErrnoException).code === 'EADDRINUSE';
			process.stderr.write(
				taken
					? `Port ${app.config.port} is already in use — another board is probably running.\n` +
							`Check with: kanban status · or serve elsewhere: kanban serve --port ${app.config.port + 1}\n`
					: `Could not start the board: ${bound.message}\n`,
			);
			app.close();
			return 1;
		}

		process.stdout.write(`Orca Kanban board:  http://localhost:${app.config.port}\n`);
		process.stdout.write(`Auto-run: ${app.config.autoRun ? 'on' : 'off'} · agent: ${app.config.defaultAgent}\n`);

		// The loop always runs; autoRun decides whether it picks cards up.
		app.scheduler.start({ autoRun: app.config.autoRun });

		const shutdown = (): void => {
			process.stdout.write('\nstopping scheduler…\n');
			void app.scheduler.stop().then(() => {
				server.close();
				app.close();
				resolve(0);
			});
		};
		process.on('SIGINT', shutdown);
		process.on('SIGTERM', shutdown);

		return promise;
	}

	// -------------------------------------------------------------------- run
	if (command === 'run') {
		const app = createApp({
			config:
				flagNum(args, 'max-concurrent') === undefined
					? {}
					: { maxConcurrent: flagNum(args, 'max-concurrent') as number },
		});
		await app.recover();

		if (args.flags['once']) {
			const outcome = await app.scheduler.runOnce();
			process.stdout.write(
				outcome
					? `${outcome.card.id} -> ${outcome.result.status} (${outcome.result.completionReason}) state=${outcome.card.state}\n`
					: 'no eligible cards\n',
			);
			app.close();
			return outcome ? 0 : 0;
		}

		const { promise, resolve } = Promise.withResolvers<number>();
		app.scheduler.start({ autoRun: true });
		process.stdout.write('scheduler running — Ctrl+C to stop\n');
		process.on('SIGINT', () => {
			void app.scheduler.stop().then(() => {
				app.close();
				resolve(0);
			});
		});
		return promise;
	}

	// ------------------------------------------------------------------- card
	if (command === 'card') {
		const app = createApp();
		const sub = args._[1] ?? '';

		try {
			if (sub === 'add') {
				const title = args._.slice(2).join(' ').trim();
				if (!title) throw new Error('a card title is required');

				const input: CardInput = { title, state: 'Backlog' };
				const description = flagStr(args, 'description');
				const acceptance = flagStr(args, 'acceptance');
				const deps = flagStr(args, 'deps');
				const repo = flagStr(args, 'repo');
				const agent = flagStr(args, 'agent');
				const priority = flagNum(args, 'priority');
				const maxAttempts = flagNum(args, 'max-attempts');
				const state = flagStr(args, 'state');

				if (description !== undefined) input.description = description;
				if (acceptance !== undefined) input.acceptanceCriteria = acceptance;
				if (deps !== undefined) input.dependencies = deps.split(',').map((s) => s.trim()).filter(Boolean);
				if (repo !== undefined) input.repo = repo;
				if (agent !== undefined) input.agent = agent;
				if (priority !== undefined) input.priority = priority;
				if (maxAttempts !== undefined) input.maxAttempts = maxAttempts;
				if (state !== undefined) input.state = requireState(state);

				const notBefore = flagStr(args, 'not-before');
				if (notBefore !== undefined) {
					const dueAt = parseDueAt(notBefore);
					if (dueAt === null) throw new Error(`could not read --not-before "${notBefore}" — try 7d, 2h, or 2026-08-19`);
					input.notBefore = dueAt;
				}

				const every = flagStr(args, 'every');
				if (every !== undefined) {
					const interval = parseDuration(every);
					if (interval === null) throw new Error(`could not read --every "${every}" — try 1w, 3d, or 12h`);
					input.repeatEveryMs = interval;
				}

				const card = app.board.createCard(input);
				const schedule = [
					card.notBefore ? `due ${formatRelative(card.notBefore)}` : null,
					card.repeatEveryMs ? `repeats` : null,
				].filter(Boolean);
				process.stdout.write(
					`${card.id}  ${card.state}  P${card.priority}  ${card.title}` +
						`${schedule.length > 0 ? `  (${schedule.join(', ')})` : ''}\n`,
				);
				return 0;
			}

			if (sub === 'list') {
				const state = flagStr(args, 'state');
				const cards = state ? app.board.cardsInState(requireState(state)) : app.board.listCards();
				const eligible = new Set(app.board.eligibleCards().map((c) => c.id));
				if (cards.length === 0) process.stdout.write('(no cards)\n');
				for (const c of cards) {
					// The reason matters more than the mark: a Ready card sitting still is
					// either due later, out of retries, or waiting on somebody else.
					const why = eligible.has(c.id) ? '' : (app.board.whyNotRunnable(c) ?? '');
					// A card parked on a human needs its age, not its eligibility: that is the
					// question you are actually asking when you look at the Review column.
					const waiting =
						c.state === 'Review' || c.state === 'Blocked'
							? `waiting ${formatRelative(c.stateChangedAt).replace(' ago', '')}`
							: '';
					// Loudest note on the row: this card moves only when you come back to it.
					const yours = c.manualSince ? `yours since ${formatRelative(c.manualSince).replace(' ago', '')}` : '';
					const note = [yours, waiting, why].filter(Boolean).join(', ');
					process.stdout.write(
						`${c.id}  ${c.state.padEnd(11)} P${String(c.priority).padEnd(4)} ` +
							`${eligible.has(c.id) ? '✓' : ' '} ${c.attemptCount}/${c.maxAttempts}  ${c.title}` +
							`${note === '' ? '' : `  (${note})`}\n`,
					);
				}
				return 0;
			}

			if (sub === 'show') {
				const id = args._[2];
				if (!id) throw new Error('a card id is required');
				const card = app.board.getCard(id);
				if (!card) throw new Error(`no such card ${id}`);
				process.stdout.write(`${JSON.stringify(card, null, 2)}\n`);
				process.stdout.write(`runs:\n${JSON.stringify(app.board.runsForCard(id), null, 2)}\n`);
				return 0;
			}

			if (sub === 'move') {
				const id = args._[2];
				const state = requireState(args._.slice(3).join(' '));
				if (!id) throw new Error('a card id is required');
				const card = app.board.moveCard(id, state);
				if (!card) throw new Error(`no such card ${id}`);
				await app.mirrorCard(card);
				process.stdout.write(`${card.id} -> ${card.state}\n`);
				return 0;
			}

			if (sub === 'rm') {
				const id = args._[2];
				if (!id) throw new Error('a card id is required');
				const force = args.flags['force'] === true;
				process.stdout.write(app.board.deleteCard(id, { force }) ? `deleted ${id}\n` : `no such card ${id}\n`);
				return 0;
			}

			if (sub === 'retry') {
				const id = args._[2];
				if (!id) throw new Error('a card id is required');
				const card = app.board.retryCard(id);
				if (!card) throw new Error(`no such card ${id}`);
				await app.mirrorCard(card, 'retry requested');
				process.stdout.write(`${card.id} -> ${card.state} (attempts reset)\n`);
				return 0;
			}

			if (sub === 'approve') {
				const id = args._[2];
				if (!id) throw new Error('a card id is required');
				// Validate FIRST: a refused approval must not commit anything.
				const existing = app.board.verdictTarget(id);
				if (!existing) throw new Error(`no such card ${id}`);

				// Then commit, so "Done" never means "finished, files lost".
				const landing = await landCardWork(existing, app.config);
				if (landing.committed) app.board.recordCommit(id, landing.sha);

				const comment = flagStr(args, 'm') ?? flagStr(args, 'comment');
				const card = app.board.approveCard(id, comment !== undefined ? { comment } : {});
				if (!card) throw new Error(`no such card ${id}`);
				await app.mirrorCard(card, 'approved by review');
				process.stdout.write(`${card.id} -> ${card.state} (approved; ${describeLanding(landing)})\n`);
				return 0;
			}

			if (sub === 'reject') {
				const id = args._[2];
				if (!id) throw new Error('a card id is required');
				const reason = flagStr(args, 'm') ?? flagStr(args, 'comment') ?? args._.slice(3).join(' ');
				if (!reason.trim()) throw new Error('a reason is required: -m "what needs to change"');
				const card = app.board.rejectCard(id, reason);
				if (!card) throw new Error(`no such card ${id}`);
				await app.mirrorCard(card, 'changes requested');
				process.stdout.write(`${card.id} -> ${card.state} (changes requested; the next agent will read your reason)\n`);
				return 0;
			}

			if (sub === 'comment') {
				const id = args._[2];
				if (!id) throw new Error('a card id is required');
				const text = flagStr(args, 'm') ?? args._.slice(3).join(' ');
				if (!text.trim()) throw new Error('nothing to say: pass the text or -m "…"');
				const comment = app.board.addComment(id, text);
				if (!comment) throw new Error(`no such card ${id}`);
				process.stdout.write(`${comment.id} added to ${id}\n`);
				return 0;
			}

			if (sub === 'diff') {
				const id = args._[2];
				if (!id) throw new Error('a card id is required');
				const card = app.board.getCard(id);
				if (!card) throw new Error(`no such card ${id}`);
				if (!card.worktreePath) throw new Error(`${id} has no worktree yet — it has not run`);

				const diff = await gitReviewDiff(card.worktreePath, { baseRef: app.config.baseBranch });
				process.stdout.write(`# ${card.id} — ${card.title}\n# worktree: ${card.worktreePath}\n`);
				process.stdout.write(`# vs ${diff.baseRef ?? 'HEAD'}${diff.untracked.length ? ` · ${diff.untracked.length} new file(s)` : ''}\n\n`);
				process.stdout.write(diff.stat ? `${diff.stat}\n\n` : '');
				process.stdout.write(diff.patch ? `${diff.patch}\n` : 'no changes\n');
				return 0;
			}

			if (sub === 'open') {
				const id = args._[2];
				if (!id) throw new Error('a card id is required');
				const card = app.board.getCard(id);
				if (!card) throw new Error(`no such card ${id}`);

				if (args.flags['session']) {
					if (!card.sessionId) throw new Error(`${id} has no Orca session`);
					await app.orca.terminalSwitch(card.sessionId);
					process.stdout.write(`switched Orca to ${card.sessionId}\n`);
					return 0;
				}

				if (!card.worktreePath) throw new Error(`${id} has no worktree yet — it has not run`);
				const selector = card.worktreeId ? `id:${card.worktreeId}` : `path:${card.worktreePath}`;
				await app.orca.fileOpenChanged({ worktreeSelector: selector, mode: 'diff' });
				process.stdout.write(`opened this card's changed files in Orca\n`);
				return 0;
			}

			if (sub === 'takeover') {
				const id = args._[2];
				if (!id) throw new Error('a card id is required');
				const card = await app.takeOver(id);
				process.stdout.write(
					`${card.id} -> yours (${card.state}, session ${card.sessionId ?? 'none'})\n` +
						`the board has stopped watching it; hand it back with: kanban card takeback ${card.id}\n`,
				);
				return 0;
			}

			if (sub === 'takeback') {
				const id = args._[2];
				if (!id) throw new Error('a card id is required');

				// Handing back means somebody has to watch the session. A daemon already owns
				// execution if one is alive, and two watchers on one agent would both try to
				// settle the card — so route it there instead of racing it.
				const live = schedulerLiveness(app.board.schedulerStatus(), app.config.pollIntervalMs);
				if (live.alive) {
					throw new Error(
						`a scheduler is already running (pid ${app.board.schedulerStatus().ownerPid}); hand it back there — ` +
							`in the board UI, or: curl -XPOST localhost:${app.config.port}/api/cards/${id}/takeback`,
					);
				}

				const { card, run, settled } = await app.scheduler.takeBack(id);
				process.stdout.write(`${card.id} -> watched here (run ${run.id}); waiting for the agent\n`);
				const outcome = await settled;
				process.stdout.write(
					outcome
						? `${outcome.card.id} -> ${outcome.result.status} (${app.board.getCard(id)?.state})\n`
						: `${id} -> no outcome\n`,
				);
				return 0;
			}

			if (sub === 'resume') {
				const id = args._[2];
				if (!id) throw new Error('a card id is required');
				const card = app.board.getCard(id);
				if (!card) throw new Error(`no such card ${id}`);

				const outcome = await resumeCardSession(card, app.config, app.orca);
				if (!outcome.resumed) throw new Error(`cannot resume ${id}: ${describeResume(outcome)}`);

				app.board.attachSession(id, {
					sessionId: outcome.sessionId,
					worktreeId: card.worktreeId,
					worktreePath: card.worktreePath,
					branch: card.branch,
				});
				process.stdout.write(`${id} -> ${outcome.command} in ${outcome.sessionId}\n`);
				return 0;
			}

			if (sub === 'snooze') {
				const id = args._[2];
				if (!id) throw new Error('a card id is required');
				const when = flagStr(args, 'until') ?? args._.slice(3).join(' ');
				if (!when.trim()) throw new Error('say when: e.g. "1w", "36h", or "2026-08-19"');

				const dueAt = parseDueAt(when);
				if (dueAt === null) throw new Error(`could not read "${when}" — try 7d, 12h, or 2026-08-19`);

				const card = app.board.snoozeCard(id, dueAt);
				if (!card) throw new Error(`no such card ${id}`);
				await app.mirrorCard(card, `deferred until ${new Date(dueAt).toISOString()}`);
				process.stdout.write(
					`${card.id} -> ${card.state}, held until ${new Date(dueAt).toLocaleString()} (${formatRelative(dueAt)})\n`,
				);
				return 0;
			}

			throw new Error(`unknown card subcommand "${sub}"`);
		} finally {
			app.close();
		}
	}

	// --------------------------------------------------------------- recover
	if (command === 'recover') {
		const app = createApp();
		const report = await app.recover();
		process.stdout.write(
			`inspected ${report.inspected} · adopted ${report.adopted.length} · requeued ${report.requeued.length} · blocked ${report.blocked.length} · held ${report.held.length}\n`,
		);
		for (const d of [...report.adopted, ...report.requeued, ...report.blocked, ...report.held]) {
			process.stdout.write(`  ${d.card.id} ${d.action}: ${d.reason}\n`);
		}
		app.close();
		return 0;
	}

	// ---------------------------------------------------------------- status
	if (command === 'status') {
		const app = createApp();
		const s = app.board.schedulerStatus();
		const cards = app.board.listCards();
		const byState = new Map<string, number>();
		for (const c of cards) byState.set(c.state, (byState.get(c.state) ?? 0) + 1);

		const inFlight = app.board.inFlightCount();
		// The row survives the process, so say plainly when nothing is watching the board.
		const live = schedulerLiveness(s, app.config.pollIntervalMs);
		process.stdout.write(
			live.alive
				? `scheduler: ${s.runState}${s.autoRun ? ' (auto-run on)' : ' (auto-run off)'} · ${live.reason}\n`
				: `scheduler: not running (${live.reason}) · start it with: kanban serve\n`,
		);
		process.stdout.write(`slots:     ${inFlight}/${app.config.maxConcurrent} in flight\n`);
		for (const flight of s.inFlight) {
			process.stdout.write(`  running: ${flight.cardId} · session ${flight.sessionId ?? '—'}\n`);
		}
		// Held cards are not in any lane and nothing is watching them, so without this
		// line a card you took an hour ago is invisible in the one place you would look.
		for (const c of app.board.manualCards()) {
			process.stdout.write(
				`  yours:   ${c.id} · since ${formatRelative(c.manualSince as number)} · take back with: kanban card takeback ${c.id}\n`,
			);
		}
		process.stdout.write(`executed:  ${s.cardsExecuted}\n`);
		process.stdout.write(`cards:     ${[...byState].map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}\n`);
		process.stdout.write(`eligible:  ${app.board.eligibleCards().map((c) => c.id).join(', ') || 'none'}\n`);

		const wakeAt = app.board.nextWakeAt();
		if (wakeAt !== null) {
			process.stdout.write(`next due:  ${formatRelative(wakeAt)} (${new Date(wakeAt).toLocaleString()})\n`);
		}
		app.close();
		return 0;
	}

	// ---------------------------------------------------------------- doctor
	if (command === 'doctor') {
		const app = createApp();
		let code = 0;
		try {
			const status = await app.orca.status();
			process.stdout.write(`orca runtime:   ${status.runtimeReachable ? 'reachable' : 'UNREACHABLE'} (v${status.appVersion ?? '?'})\n`);
			if (!status.runtimeReachable) code = 1;
		} catch (err) {
			process.stdout.write(`orca runtime:   ERROR ${(err as Error).message}\n`);
			code = 1;
		}

		const agent = app.config.agents[app.config.defaultAgent];
		process.stdout.write(`default agent:  ${app.config.defaultAgent} -> orca --agent ${agent?.orcaAgentId ?? '?'}\n`);
		process.stdout.write(`default repo:   ${app.config.defaultRepo ?? '(unset — cards must name one)'}\n`);
		process.stdout.write(`success state:  ${app.config.successState}\n`);
		process.stdout.write(`orca board:     ${app.config.mirrorToOrcaBoard ? 'mirroring' : 'off'}\n`);

		if (app.config.orchestration.enabled) {
			const ok = await app.orchestration.available();
			process.stdout.write(`orchestration:  ${ok ? 'available' : 'UNAVAILABLE (enable it in Settings > Experimental)'}\n`);
		} else {
			process.stdout.write('orchestration:  disabled in config\n');
		}

		if (app.config.defaultRepo) {
			try {
				const repo = await app.orca.resolveRepo(app.config.defaultRepo);
				process.stdout.write(`repo resolved:  ${repo.id} ${repo.path}\n`);
			} catch (err) {
				process.stdout.write(`repo resolved:  ERROR ${(err as Error).message}\n`);
				code = 1;
			}
		}

		app.close();
		return code;
	}

	process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
	return 1;
}

// `kanban card show | head` closes the pipe while we are still writing. That is a
// normal way to use a CLI, not a crash, so exit quietly instead of throwing EPIPE.
for (const stream of [process.stdout, process.stderr]) {
	stream.on('error', (err: NodeJS.ErrnoException) => {
		if (err.code === 'EPIPE') process.exit(0);
		throw err;
	});
}

main()
	.then((code) => {
		if (code !== 0) process.exitCode = code;
	})
	.catch((err: Error) => {
		// The guard message is already formatted for a human/agent to act on.
		const refused = err instanceof CardWorkerGuardError || err instanceof BoardRuleError;
		process.stderr.write(refused ? `${err.message}\n` : `error: ${err.message}\n`);
		process.exitCode = err instanceof CardWorkerGuardError ? 3 : err instanceof BoardRuleError ? 4 : 1;
	});
