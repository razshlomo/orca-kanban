/**
 * Standalone claim attempt used by the atomicity test.
 *
 * Runs as its own OS process so the contention is real: several processes open the
 * same SQLite board file and race to claim the same card.
 *
 * Usage: node claim-worker.ts <dbPath> <cardId> <workerId>
 */
import { Board } from '../../src/board.ts';

const [dbPath, cardId, workerId] = process.argv.slice(2);

if (!dbPath || !cardId || !workerId) {
	process.stderr.write('usage: claim-worker.ts <dbPath> <cardId> <workerId>\n');
	process.exit(2);
}

const board = new Board(dbPath);

try {
	const claimed = board.claimCard(cardId, workerId);
	process.stdout.write(claimed ? `WON ${workerId}\n` : `LOST ${workerId}\n`);
} catch (err) {
	// A lock error is a loss, not a crash — report it so the test can count it.
	process.stdout.write(`ERROR ${workerId} ${(err as Error).message}\n`);
} finally {
	board.close();
}
