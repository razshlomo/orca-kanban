/* eslint-disable no-control-regex */

/** CSI/OSC escape sequences plus the cursor-movement noise TUIs emit. */
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])/g;

export function stripAnsi(value: string): string {
	return value.replace(ANSI, '');
}

/**
 * Turns raw terminal tail lines into something worth persisting: no escape
 * codes, no spinner frames, no blank runs.
 */
export function cleanTerminalTail(lines: string[], maxLines = 120): string {
	const cleaned: string[] = [];

	for (const raw of lines) {
		const line = stripAnsi(raw)
			// Braille spinner frames and the box-drawing chrome OMP/Codex paint.
			.replace(/[\u2800-\u28FF]/g, '')
			.replace(/[\u2500-\u257F]{2,}/g, '')
			.replace(/\u23A1|\u23A2|\u23A3|\u23A4|\u23A5|\u23A6/g, '')
			.replace(/\s+$/, '');

		if (line.trim() === '') {
			if (cleaned.at(-1) === '') continue;
			cleaned.push('');
			continue;
		}
		cleaned.push(line);
	}

	while (cleaned.length > 0 && cleaned[0] === '') cleaned.shift();
	while (cleaned.length > 0 && cleaned.at(-1) === '') cleaned.pop();

	return cleaned.slice(-maxLines).join('\n');
}

/** Slug safe for a git branch / Orca worktree name. */
export function slugify(value: string, maxLength = 40): string {
	const slug = value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, maxLength)
		.replace(/-+$/, '');
	return slug || 'card';
}

const DURATION_UNITS: Record<string, number> = {
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 604_800_000,
};

/**
 * Parses a human duration like `30m`, `2h`, `7d`, `1w`, or a compound `1w2d`.
 * Returns null for anything it does not fully understand, so a typo becomes a
 * visible error instead of a silently wrong schedule.
 */
export function parseDuration(value: string): number | null {
	const text = value.trim().toLowerCase();
	if (text === '') return null;

	// Bare number means minutes; that is the least surprising default for a snooze.
	if (/^\d+$/.test(text)) return Number(text) * DURATION_UNITS['m']!;

	const parts = text.match(/\d+[smhdw]/g);
	if (!parts || parts.join('') !== text) return null;

	let total = 0;
	for (const part of parts) {
		const unit = DURATION_UNITS[part.slice(-1)];
		if (!unit) return null;
		total += Number(part.slice(0, -1)) * unit;
	}
	return total > 0 ? total : null;
}

/**
 * Resolves what a user typed into an absolute epoch-ms deadline: either a duration
 * from now (`7d`) or a date/datetime (`2026-08-19`, ISO 8601). Null when neither.
 */
export function parseDueAt(value: string, now = Date.now()): number | null {
	const duration = parseDuration(value);
	if (duration !== null) return now + duration;

	const parsed = Date.parse(value.trim());
	return Number.isNaN(parsed) ? null : parsed;
}

/** Compact "in 6d" / "2h ago" for board display. */
export function formatRelative(at: number, now = Date.now()): string {
	const delta = at - now;
	const abs = Math.abs(delta);
	const [unit, ms] =
		abs >= DURATION_UNITS['d']! ? ['d', DURATION_UNITS['d']!]
		: abs >= DURATION_UNITS['h']! ? ['h', DURATION_UNITS['h']!]
		: abs >= DURATION_UNITS['m']! ? ['m', DURATION_UNITS['m']!]
		: ['s', DURATION_UNITS['s']!];

	const n = Math.round(abs / (ms as number));
	return delta >= 0 ? `in ${n}${unit}` : `${n}${unit} ago`;
}
