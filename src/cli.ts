#!/usr/bin/env node
import { createApp } from './app.ts';
import { assertBoardWritable, CardWorkerGuardError } from './guard.ts';
import { createHttpServer } from './server.ts';
import { isCardState, type CardInput, type CardState } from './types.ts';

const USAGE = `orca-kanban — Kanban-driven sequential agent execution for Orca

Usage:
  orca-kanban serve [--port <n>] [--auto-run]    Start the board API + UI (and the scheduler)
  orca-kanban run [--once]                       Run the scheduler loop in the foreground
  orca-kanban card add <title> [options]         Create a card
  orca-kanban card list [--state <state>]        List cards
  orca-kanban card show <id>                     Show one card and its run history
  orca-kanban card move <id> <state>             Move a card between columns
  orca-kanban card rm <id>                       Delete a card
  orca-kanban card retry <id>                    Return a failed/blocked card to Ready
  orca-kanban recover                            Reconcile cards stranded In Progress
  orca-kanban status                             Show board + scheduler status
  orca-kanban doctor                             Check Orca connectivity and config

Card options:
  --description <text>   --acceptance <text>   --priority <n>
  --deps <id,id>         --repo <path|id:…>    --agent <name>
  --max-attempts <n>     --state <state>       --force (override card-worktree guard)

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
			});
		}

		const server = createHttpServer(app);
		const { promise, resolve } = Promise.withResolvers<number>();

		server.listen(app.config.port, () => {
			process.stdout.write(`Orca Kanban board:  http://localhost:${app.config.port}\n`);
			process.stdout.write(`Auto-run: ${app.config.autoRun ? 'on' : 'off'} · agent: ${app.config.defaultAgent}\n`);
		});

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
		const app = createApp();
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

				const card = app.board.createCard(input);
				process.stdout.write(`${card.id}  ${card.state}  P${card.priority}  ${card.title}\n`);
				return 0;
			}

			if (sub === 'list') {
				const state = flagStr(args, 'state');
				const cards = state ? app.board.cardsInState(requireState(state)) : app.board.listCards();
				const eligible = new Set(app.board.eligibleCards().map((c) => c.id));
				if (cards.length === 0) process.stdout.write('(no cards)\n');
				for (const c of cards) {
					process.stdout.write(
						`${c.id}  ${c.state.padEnd(11)} P${String(c.priority).padEnd(4)} ` +
							`${eligible.has(c.id) ? '✓' : ' '} ${c.attemptCount}/${c.maxAttempts}  ${c.title}\n`,
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
				process.stdout.write(app.board.deleteCard(id) ? `deleted ${id}\n` : `no such card ${id}\n`);
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
			`inspected ${report.inspected} · adopted ${report.adopted.length} · requeued ${report.requeued.length} · blocked ${report.blocked.length}\n`,
		);
		for (const d of [...report.adopted, ...report.requeued, ...report.blocked]) {
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

		process.stdout.write(`scheduler: ${s.runState}${s.autoRun ? ' (auto-run on)' : ' (auto-run off)'}\n`);
		if (s.currentCardId) process.stdout.write(`current:   ${s.currentCardId} · session ${s.currentSessionId ?? '—'}\n`);
		process.stdout.write(`executed:  ${s.cardsExecuted}\n`);
		process.stdout.write(`cards:     ${[...byState].map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}\n`);
		process.stdout.write(`eligible:  ${app.board.eligibleCards().map((c) => c.id).join(', ') || 'none'}\n`);
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
		process.stderr.write(err instanceof CardWorkerGuardError ? `${err.message}\n` : `error: ${err.message}\n`);
		process.exitCode = err instanceof CardWorkerGuardError ? 3 : 1;
	});
