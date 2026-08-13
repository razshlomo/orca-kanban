import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Script } from 'node:vm';

const html = readFileSync(path.join(import.meta.dirname, '..', 'ui', 'index.html'), 'utf8');
const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

test('the panel script parses, so a typo cannot ship a blank board', () => {
	// The UI is a static file with no build step, so nothing else would catch this.
	assert.doesNotThrow(() => new Script(script));
});

test('every onclick names a function that exists', () => {
	// Removing a button used to leave its handler behind, or worse, the reverse: a
	// button wired to a function that was deleted, failing only when clicked.
	const handlers = [...html.matchAll(/onclick="([a-zA-Z]+)\(/g)].map((m) => m[1] as string);
	assert.ok(handlers.length > 5, 'the panel really does have handlers to check');

	const missing = [...new Set(handlers)].filter(
		(fn) => !new RegExp(`(function ${fn}\\b|${fn} = (async )?\\()`).test(script),
	);
	assert.deepEqual(missing, [], 'every handler must be defined');
});

test('there is exactly one save control, and one place that reports the result', () => {
	// The panel used to carry three separate saves (Save, Save repeat, Hold), which is
	// what made it impossible to tell what a click would persist.
	assert.equal([...html.matchAll(/id="saveBtn"/g)].length, 1);
	assert.equal([...html.matchAll(/id="saveMsg"/g)].length, 1);
	assert.equal([...html.matchAll(/id="revertBtn"/g)].length, 1);

	for (const gone of ['saveRepeat', 'clearSchedule', 'f-snooze']) {
		assert.ok(!html.includes(gone), `${gone} belonged to the old multi-save panel`);
	}
});

test('the save button is driven by dirty state, not left permanently enabled', () => {
	assert.match(script, /btn\.disabled = !dirty \|\| saving/, 'disabled unless there is something to save');
	assert.match(script, /textContent = saving \? 'Saving…'/, 'and it says when it is working');
});

test('the poll cannot redraw over unsaved edits', () => {
	// The original guard used a focus/blur flag, so clicking away from a field dropped
	// the typing on the next 1.5s poll. Dirty state is what actually protects it.
	assert.match(script, /if \(selectedId && !isDirty\(\) && !saving\) renderPanel\(\)/);
	assert.ok(!script.includes('let editing'), 'the focus/blur flag is gone for good');
});

test('a successful save clears the baseline, so the panel stops claiming unsaved edits', () => {
	// Without this the footer kept saying "Unsaved changes" after a save, because the
	// poll refuses to redraw while dirty and nothing else refreshed the baseline.
	const save = script.slice(script.indexOf('async function saveCard'), script.indexOf('function revertCard'));
	assert.match(save, /baseline = null;[\s\S]*await refresh\(\)/, 'baseline is dropped before refreshing');
});

test('every field carries a real label, not just a placeholder', () => {
	const fields = [...html.matchAll(/<(?:input|textarea|select) id="(f-[a-z]+)"/g)].map((m) => m[1] as string);
	assert.ok(fields.length >= 10, `expected the full form, found ${fields.length}`);

	const unlabelled = fields.filter((id) => !html.includes(`for="${id}"`));
	assert.deepEqual(unlabelled, [], 'a placeholder is not a label');
});

test('the card panel is a scrolling body between a fixed head and action bar', () => {
	// The Save button must not be able to scroll out of reach on a long card.
	for (const cls of ['p-head', 'p-body', 'p-foot']) {
		assert.ok(html.includes(`class="${cls}"`), `${cls} is part of the panel shell`);
	}
	assert.match(html, /\.p-body \{ flex: 1; overflow: auto/);
	assert.match(html, /width: min\(440px, 100vw\)/, 'and it never exceeds a narrow window');
});

test('sections remember only deliberate opens', () => {
	// Chrome queues a toggle event for a details inserted already open, which leaked the
	// auto-opened Review section onto every card visited afterwards.
	assert.match(script, /querySelector\('summary'\)\.addEventListener\('click'/);
	assert.ok(!script.includes("addEventListener('toggle'"), 'toggle is the leaky signal');
});

test('a held card is visually distinct, not just differently worded', () => {
	// A purple left border and a tag, because a held card only moves when its owner
	// returns to it — it must be findable by eye across six columns.
	assert.match(html, /--mine:\s*#[0-9a-f]{6}/i);
	assert.match(html, /\.card\.mine\s*\{[^}]*border-left:\s*3px solid var\(--mine\)/);
	assert.match(script, /c\.manualSince\s*\?\s*' mine'/);
	assert.match(script, /class="tag mine"[^`]*yours/);
});

test('the header counts held cards, so one cannot be forgotten', () => {
	const header = script.slice(script.indexOf("const held = "), script.indexOf("getElementById('scur')"));
	assert.match(header, /manualSince/);
	assert.match(header, /yours/);
});

test('take over and take back are gated on real state, never offered blindly', () => {
	const can = script.slice(script.indexOf('const can = {'), script.indexOf('const why = {'));
	// Taking over needs a live session; taking back needs the worktree to re-attach to.
	assert.match(can, /takeOver:\s*running && !mine && Boolean\(c\.sessionId\)/);
	assert.match(can, /takeBack:\s*mine && Boolean\(c\.worktreePath\)/);

	const why = script.slice(script.indexOf('const why = {'), script.indexOf('try { runs'));
	assert.match(why, /takeOver:/);
	assert.match(why, /takeBack:/);

	// Both buttons must carry the disabled+title treatment every other control uses.
	for (const fn of ['takeOver', 'takeBack']) {
		const re = new RegExp(`can\\.${fn} \\? '' : \`disabled title="\\$\\{esc\\(why\\.${fn}\\)\\}"\``);
		assert.match(html, re, `${fn} must say why it is disabled`);
	}
});
