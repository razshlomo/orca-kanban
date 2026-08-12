import { execFile } from 'node:child_process';
import type { Logger } from './logger.ts';

/**
 * Integration with Orca's own orchestration subsystem (`orca orchestration ...`).
 *
 * Why this exists: Orca already owns durable Task/Dispatch provenance, a guarded
 * ready -> dispatched claim, a worker completion mailbox, and worker cleanup.
 * Running agents beside that state would make Kanban work invisible to Orca (and
 * the orchestration guide explicitly forbids claiming orchestration after the
 * fact), so every card execution is registered as a real Task + Dispatch.
 *
 * What it deliberately does NOT own: the Kanban board itself. Orca tasks have no
 * priority, no board order, and no Backlog/Review states, so board metadata stays
 * in SQLite and is linked to Orca by taskId/dispatchId.
 */

export type OrchestrationMessage = {
	id: string;
	type: string;
	subject: string | null;
	body: string | null;
	taskId: string | null;
	dispatchId: string | null;
	outcome: string | null;
	filesModified: string[];
};

export type OrchestrationDelivery = {
	deliveryId: string | null;
	messages: OrchestrationMessage[];
};

export type OrchestrationTaskStatus = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked';

export type OrchestrationApi = {
	available(): Promise<boolean>;
	ensureRun(objective: string): Promise<string>;
	createTask(options: { spec: string; title?: string; deps?: string[] }): Promise<string>;
	/** Guarded ready -> dispatched transition. Returns null when already claimed. */
	dispatch(options: { taskId: string; handle: string }): Promise<string | null>;
	updateTask(options: { taskId: string; status: OrchestrationTaskStatus; result?: unknown }): Promise<void>;
	/** Blocks on Orca's mailbox until a worker reports, or the timeout elapses. */
	checkWait(options: { types?: string[]; timeoutMs: number }): Promise<OrchestrationDelivery>;
	ack(deliveryId: string): Promise<void>;
	/**
	 * Returns false when Orca would not release the worker — notably for a
	 * low-level `dispatch` (rather than `worker-start`), where no worker resource
	 * exists and the caller must close the terminal itself.
	 */
	releaseWorker(dispatchId: string): Promise<boolean>;
	runId: string | null;
};

function runCli(
	bin: string,
	args: string[],
	timeoutMs: number,
): Promise<{ ok: boolean; result: Record<string, unknown> | null; errorCode: string | null; errorMessage: string | null }> {
	const { promise, resolve } = Promise.withResolvers<{
		ok: boolean;
		result: Record<string, unknown> | null;
		errorCode: string | null;
		errorMessage: string | null;
	}>();

	execFile(bin, [...args, '--json'], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
		const text = String(stdout ?? '').trim();
		const start = text.indexOf('{');
		if (start >= 0) {
			try {
				const parsed = JSON.parse(text.slice(start)) as {
					ok?: boolean;
					result?: Record<string, unknown>;
					error?: { code?: string; message?: string };
				};
				resolve({
					ok: parsed.ok === true,
					result: parsed.result ?? null,
					errorCode: parsed.error?.code ?? null,
					errorMessage: parsed.error?.message ?? null,
				});
				return;
			} catch {
				// fall through to the transport error below
			}
		}
		resolve({
			ok: false,
			result: null,
			errorCode: 'no_json',
			errorMessage: err ? err.message : String(stderr ?? '').trim() || 'no JSON returned',
		});
	});

	return promise;
}

export type OrchestrationOptions = {
	bin?: string;
	log: Logger;
	/** Reuse an existing Run instead of creating one. */
	runId?: string | null;
	objective?: string;
};

/**
 * Live implementation. Every call carries `--run <id>` explicitly so the
 * scheduler works as a background daemon: Orca otherwise resolves the Run from
 * the *calling terminal*, which a daemon does not have.
 */
export class OrcaOrchestration implements OrchestrationApi {
	runId: string | null;

	private readonly bin: string;
	private readonly log: Logger;

	constructor(options: OrchestrationOptions) {
		this.bin = options.bin ?? process.env.ORCA_BIN ?? 'orca';
		this.log = options.log;
		this.runId = options.runId ?? null;
	}

	async available(): Promise<boolean> {
		const res = await runCli(this.bin, ['orchestration', 'run-list'], 20_000);
		return res.ok;
	}

	async ensureRun(objective: string): Promise<string> {
		if (this.runId) return this.runId;

		// Reuse a Run with the same objective so restarts do not pile up namespaces.
		const list = await runCli(this.bin, ['orchestration', 'run-list'], 20_000);
		if (list.ok) {
			const runs = Array.isArray(list.result?.['runs']) ? (list.result?.['runs'] as Array<Record<string, unknown>>) : [];
			const existing = runs.find((r) => String(r['objective'] ?? '') === objective && Number(r['legacy'] ?? 0) === 0);
			if (existing) {
				this.runId = String(existing['id']);
				return this.runId;
			}
		}

		const created = await runCli(this.bin, ['orchestration', 'run-create', '--objective', objective], 30_000);
		if (!created.ok) {
			throw new Error(`orchestration run-create failed: ${created.errorCode} ${created.errorMessage ?? ''}`);
		}
		const run = created.result?.['run'] as Record<string, unknown> | undefined;
		this.runId = String(run?.['id'] ?? '');
		if (!this.runId) throw new Error('orchestration run-create returned no run id');
		return this.runId;
	}

	private requireRun(): string {
		if (!this.runId) throw new Error('No orchestration Run bound; call ensureRun first.');
		return this.runId;
	}

	async createTask(options: { spec: string; title?: string; deps?: string[] }): Promise<string> {
		const args = ['orchestration', 'task-create', '--run', this.requireRun(), '--spec', options.spec];
		if (options.title) args.push('--task-title', options.title);
		if (options.deps && options.deps.length > 0) args.push('--deps', JSON.stringify(options.deps));

		const res = await runCli(this.bin, args, 30_000);
		if (!res.ok) throw new Error(`orchestration task-create failed: ${res.errorCode} ${res.errorMessage ?? ''}`);
		const task = res.result?.['task'] as Record<string, unknown> | undefined;
		const id = task?.['id'] ? String(task['id']) : '';
		if (!id) throw new Error('orchestration task-create returned no task id');
		return id;
	}

	/**
	 * Orca's guarded claim: it accepts the transition only while the task is
	 * `ready`, so a second dispatch of the same task is rejected by the runtime.
	 */
	async dispatch(options: { taskId: string; handle: string }): Promise<string | null> {
		const res = await runCli(
			this.bin,
			['orchestration', 'dispatch', '--run', this.requireRun(), '--task', options.taskId, '--to', options.handle],
			60_000,
		);

		if (!res.ok) {
			this.log.warn('orchestration dispatch rejected', {
				taskId: options.taskId,
				code: res.errorCode,
				error: res.errorMessage,
			});
			return null;
		}

		const dispatch = res.result?.['dispatch'] as Record<string, unknown> | undefined;
		const id = dispatch?.['id'] ?? res.result?.['dispatchId'] ?? res.result?.['id'];
		return id ? String(id) : null;
	}

	async updateTask(options: { taskId: string; status: OrchestrationTaskStatus; result?: unknown }): Promise<void> {
		const args = [
			'orchestration',
			'task-update',
			'--run',
			this.requireRun(),
			'--id',
			options.taskId,
			'--status',
			options.status,
		];
		if (options.result !== undefined) args.push('--result', JSON.stringify(options.result));

		const res = await runCli(this.bin, args, 30_000);
		if (!res.ok) {
			this.log.warn('orchestration task-update failed', {
				taskId: options.taskId,
				code: res.errorCode,
				error: res.errorMessage,
			});
		}
	}

	async checkWait(options: { types?: string[]; timeoutMs: number }): Promise<OrchestrationDelivery> {
		const args = [
			'orchestration',
			'check',
			'--run',
			this.requireRun(),
			'--wait',
			'--timeout-ms',
			String(options.timeoutMs),
		];
		if (options.types && options.types.length > 0) args.push('--types', options.types.join(','));

		const res = await runCli(this.bin, args, options.timeoutMs + 30_000);
		if (!res.ok) return { deliveryId: null, messages: [] };

		const raw = res.result ?? {};
		const deliveryId = raw['deliveryId'] ?? raw['delivery_id'] ?? null;
		const list = Array.isArray(raw['messages']) ? (raw['messages'] as Array<Record<string, unknown>>) : [];

		return {
			deliveryId: deliveryId ? String(deliveryId) : null,
			messages: list.map((m) => ({
				id: String(m['id'] ?? ''),
				type: String(m['type'] ?? ''),
				subject: m['subject'] ? String(m['subject']) : null,
				body: m['body'] ? String(m['body']) : null,
				taskId: m['task_id'] ?? m['taskId'] ? String(m['task_id'] ?? m['taskId']) : null,
				dispatchId: m['dispatch_id'] ?? m['dispatchId'] ? String(m['dispatch_id'] ?? m['dispatchId']) : null,
				outcome: m['outcome'] ? String(m['outcome']) : null,
				filesModified: Array.isArray(m['files_modified'])
					? (m['files_modified'] as unknown[]).map(String)
					: typeof m['files_modified'] === 'string'
						? String(m['files_modified']).split(',').filter(Boolean)
						: [],
			})),
		};
	}

	async ack(deliveryId: string): Promise<void> {
		await runCli(this.bin, ['orchestration', 'check', '--run', this.requireRun(), '--ack', deliveryId], 30_000);
	}

	/**
	 * Orca's post-completion cleanup. Preferred over `terminal close` because it
	 * archives the worker's output first and only closes terminals Orca can prove
	 * belong to that settled Dispatch.
	 */
	async releaseWorker(dispatchId: string): Promise<boolean> {
		const res = await runCli(this.bin, ['orchestration', 'worker-release', '--dispatch', dispatchId], 60_000);
		if (!res.ok) {
			this.log.warn('orchestration worker-release did not settle; caller must close the session', {
				dispatchId,
				code: res.errorCode,
				error: res.errorMessage,
			});
			return false;
		}
		return true;
	}
}

/** Used when orchestration is disabled or unavailable; execution still works. */
export const disabledOrchestration: OrchestrationApi = {
	runId: null,
	available: async () => false,
	ensureRun: async () => '',
	createTask: async () => '',
	dispatch: async () => null,
	updateTask: async () => {},
	checkWait: async () => ({ deliveryId: null, messages: [] }),
	ack: async () => {},
	releaseWorker: async () => false,
};
