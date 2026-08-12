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
