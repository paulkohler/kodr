import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	jailedPath,
	makeDiff,
	prepareChanges,
	preparePatches,
	prepareWrites,
	SafeWriteError,
} from '../src/safe-writes.mjs';

describe('safe writes', () => {
	it('rejects path escapes', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-'));

		await assert.rejects(() => jailedPath(cwd, '/tmp/outside'), SafeWriteError);
		await assert.rejects(() => jailedPath(cwd, '../outside'), SafeWriteError);
		await assert.rejects(
			() => jailedPath(cwd, 'a/../../outside'),
			SafeWriteError,
		);
	});

	it('rejects symlink parent escapes', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-link-'));
		const outside = await mkdtemp(join(tmpdir(), 'kodr-outside-'));
		await symlink(outside, join(cwd, 'linked'));

		await assert.rejects(
			() => jailedPath(cwd, 'linked/file.txt'),
			/Symlink parent/u,
		);
	});

	it('rejects existing symlink file targets', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-link-file-'));
		const outside = await mkdtemp(join(tmpdir(), 'kodr-outside-file-'));
		await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
		await symlink(join(outside, 'secret.txt'), join(cwd, 'linked.txt'));

		await assert.rejects(
			() => jailedPath(cwd, 'linked.txt'),
			/Symlink target/u,
		);
		await assert.rejects(
			() =>
				prepareWrites(
					cwd,
					[
						{
							content: 'changed',
							path: 'linked.txt',
						},
					],
					{ apply: true },
				),
			/Symlink target/u,
		);
		assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret');
	});

	it('supports dry-run diffs without modifying files', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-dry-'));
		await writeFile(join(cwd, 'README.md'), 'old\n', 'utf8');

		const result = await prepareWrites(
			cwd,
			[
				{
					content: 'new\n',
					path: 'README.md',
				},
			],
			{ apply: false },
		);

		assert.equal(result.applied, false);
		assert.match(result.writes[0].diff, /-old/u);
		assert.match(result.writes[0].diff, /\+new/u);
		assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), 'old\n');
	});

	it('applies writes and creates timestamped backups', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-apply-'));
		await mkdir(join(cwd, 'src'), { recursive: true });
		await writeFile(join(cwd, 'src', 'app.js'), 'old', 'utf8');

		const result = await prepareWrites(
			cwd,
			[
				{
					content: 'new',
					path: 'src/app.js',
				},
			],
			{
				apply: true,
				timestamp: 'fixed-time',
			},
		);

		assert.equal(result.applied, true);
		assert.equal(await readFile(join(cwd, 'src', 'app.js'), 'utf8'), 'new');
		assert.equal(
			await readFile(
				join(cwd, '.kodr', 'backups', 'fixed-time', 'src', 'app.js'),
				'utf8',
			),
			'old',
		);
	});

	it('applies exact patches and creates backups', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-patch-'));
		await mkdir(join(cwd, 'src'), { recursive: true });
		await writeFile(join(cwd, 'src', 'app.js'), 'one\ntwo\nthree\n', 'utf8');

		const result = await preparePatches(
			cwd,
			[
				{
					path: 'src/app.js',
					replace: 'TWO\n',
					search: 'two\n',
				},
			],
			{
				apply: true,
				timestamp: 'patch-time',
			},
		);

		assert.equal(result.applied, true);
		assert.equal(result.writes[0].status, 'patch');
		assert.equal(
			await readFile(join(cwd, 'src', 'app.js'), 'utf8'),
			'one\nTWO\nthree\n',
		);
		assert.equal(
			await readFile(
				join(cwd, '.kodr', 'backups', 'patch-time', 'src', 'app.js'),
				'utf8',
			),
			'one\ntwo\nthree\n',
		);
	});

	it('collects stale or ambiguous patches into failedPatches instead of throwing', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-stale-patch-'));
		await writeFile(join(cwd, 'README.md'), 'same\nsame\n', 'utf8');

		const multipleResult = await preparePatches(cwd, [
			{
				path: 'README.md',
				replace: 'changed',
				search: 'same',
			},
		]);
		assert.equal(multipleResult.failedPatches.length, 1);
		assert.equal(multipleResult.failedPatches[0].reason, 'multiple_matches');
		assert.equal(multipleResult.failedPatches[0].occurrences, 2);
		assert.equal(multipleResult.writes.length, 0);

		const noMatchResult = await preparePatches(cwd, [
			{
				path: 'README.md',
				replace: 'changed',
				search: 'missing',
			},
		]);
		assert.equal(noMatchResult.failedPatches.length, 1);
		assert.equal(noMatchResult.failedPatches[0].reason, 'no_match');
		assert.equal(noMatchResult.failedPatches[0].occurrences, 0);
		assert.equal(noMatchResult.writes.length, 0);

		// File must be untouched.
		assert.equal(
			await readFile(join(cwd, 'README.md'), 'utf8'),
			'same\nsame\n',
		);
	});

	it('applies successful patches and collects failed ones without partial-apply side-effects', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-patch-batch-'));
		await writeFile(join(cwd, 'a.txt'), 'alpha\n', 'utf8');
		await writeFile(join(cwd, 'b.txt'), 'beta\n', 'utf8');

		const result = await preparePatches(
			cwd,
			[
				{
					path: 'a.txt',
					replace: 'ALPHA\n',
					search: 'alpha\n',
				},
				{
					path: 'b.txt',
					replace: 'BETA\n',
					search: 'missing\n',
				},
			],
			{ apply: true },
		);

		// a.txt patch succeeded and was applied.
		assert.equal(result.writes.length, 1);
		assert.equal(result.writes[0].path, 'a.txt');
		assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'ALPHA\n');

		// b.txt patch failed; file is untouched, no backup written.
		assert.equal(result.failedPatches.length, 1);
		assert.equal(result.failedPatches[0].path, 'b.txt');
		assert.equal(result.failedPatches[0].reason, 'no_match');
		assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), 'beta\n');
	});

	it('composes multiple patches to the same file before writing', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-patch-compose-'));
		await writeFile(join(cwd, 'notes.txt'), 'alpha\nbeta\ngamma\n', 'utf8');

		await preparePatches(
			cwd,
			[
				{
					path: 'notes.txt',
					replace: 'ALPHA\n',
					search: 'alpha\n',
				},
				{
					path: 'notes.txt',
					replace: 'BETA\n',
					search: 'beta\n',
				},
			],
			{ apply: true },
		);

		assert.equal(
			await readFile(join(cwd, 'notes.txt'), 'utf8'),
			'ALPHA\nBETA\ngamma\n',
		);
	});

	it('normalizes double-escaped patch newlines only when unambiguous', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-escaped-patch-'));
		await writeFile(join(cwd, 'README.md'), 'hello\nworld\n', 'utf8');

		const result = await preparePatches(
			cwd,
			[
				{
					path: 'README.md',
					replace: 'hello\\nthere\\n',
					search: 'hello\\nworld\\n',
				},
			],
			{ apply: true },
		);

		assert.equal(result.writes[0].status, 'patch');
		assert.equal(
			await readFile(join(cwd, 'README.md'), 'utf8'),
			'hello\nthere\n',
		);
	});

	it('matches whitespace-drifted patch searches only when unambiguous', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-fuzzy-patch-'));
		await writeFile(
			join(cwd, 'app.mjs'),
			'export function run() {\n\tconst rows = [];\n}\n',
			'utf8',
		);

		await preparePatches(
			cwd,
			[
				{
					path: 'app.mjs',
					replace:
						"export function run() {\n\tif (typeof input !== 'string') {\n\t\tthrow new TypeError('input');\n\t}\n\n\tconst rows =[];\n",
					search: 'export function run() {\n\tconst rows =[];\n',
				},
			],
			{ apply: true },
		);

		assert.match(
			await readFile(join(cwd, 'app.mjs'), 'utf8'),
			/throw new TypeError/u,
		);
	});

	it('can combine full-file writes and patches', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-changes-'));
		await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf8');

		const result = await prepareChanges(
			cwd,
			{
				files: [
					{
						content: 'created\n',
						path: 'new.txt',
					},
				],
				patches: [
					{
						path: 'README.md',
						replace: 'hello world\n',
						search: 'hello\n',
					},
				],
			},
			{ apply: true },
		);

		assert.equal(result.writes.length, 2);
		assert.equal(await readFile(join(cwd, 'new.txt'), 'utf8'), 'created\n');
		assert.equal(
			await readFile(join(cwd, 'README.md'), 'utf8'),
			'hello world\n',
		);
	});

	it('drops writes that target a protected input path', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-protect-'));
		await writeFile(join(cwd, 'prompt.md'), 'original task\n', 'utf8');

		const result = await prepareChanges(
			cwd,
			{
				files: [
					{ content: 'tampered task\n', path: 'prompt.md' },
					{ content: 'real output\n', path: 'src/cli.mjs' },
				],
			},
			{ apply: true, protectedPaths: ['prompt.md'] },
		);

		assert.equal(result.writes.length, 1);
		assert.equal(result.writes[0].path, 'src/cli.mjs');
		assert.equal(result.protected.length, 1);
		assert.equal(result.protected[0].path, 'prompt.md');
		// The protected input file is untouched on disk.
		assert.equal(
			await readFile(join(cwd, 'prompt.md'), 'utf8'),
			'original task\n',
		);
		assert.equal(
			await readFile(join(cwd, 'src/cli.mjs'), 'utf8'),
			'real output\n',
		);
	});

	it('protectExisting blocks files[] overwrite of an existing file', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-protect-existing-'));
		await writeFile(join(cwd, 'server.mjs'), 'original\n', 'utf8');

		await assert.rejects(
			() =>
				prepareChanges(
					cwd,
					{ files: [{ content: 'rewrite\n', path: 'server.mjs' }] },
					{ apply: false, protectExisting: true },
				),
			/Refusing to overwrite existing file/u,
		);
		// File on disk must be untouched.
		assert.equal(await readFile(join(cwd, 'server.mjs'), 'utf8'), 'original\n');
	});

	it('protectExisting allows files[] to create new files', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-protect-new-'));

		const result = await prepareChanges(
			cwd,
			{ files: [{ content: 'new content\n', path: 'new.mjs' }] },
			{ apply: true, protectExisting: true },
		);

		assert.equal(result.writes.length, 1);
		assert.equal(result.writes[0].status, 'create');
		assert.equal(await readFile(join(cwd, 'new.mjs'), 'utf8'), 'new content\n');
	});

	it('protectExisting allows patches[] to modify existing files', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-protect-patch-ok-'));
		await writeFile(join(cwd, 'app.mjs'), 'hello world\n', 'utf8');

		const result = await prepareChanges(
			cwd,
			{
				patches: [
					{
						path: 'app.mjs',
						search: 'hello world\n',
						replace: 'hello patch\n',
					},
				],
			},
			{ apply: true, protectExisting: true },
		);

		assert.equal(result.writes.length, 1);
		assert.equal(result.writes[0].status, 'patch');
		assert.equal(await readFile(join(cwd, 'app.mjs'), 'utf8'), 'hello patch\n');
	});

	it('protects patches and matches regardless of separators or absolute form', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-safe-protect-patch-'));
		await writeFile(join(cwd, 'prompt.md'), 'keep me\n', 'utf8');

		const result = await prepareChanges(
			cwd,
			{
				patches: [
					{ path: './prompt.md', replace: 'rewritten\n', search: 'keep me\n' },
				],
			},
			{ apply: true, protectedPaths: [join(cwd, 'prompt.md')] },
		);

		assert.equal(result.writes.length, 0);
		assert.equal(result.protected.length, 1);
		assert.equal(await readFile(join(cwd, 'prompt.md'), 'utf8'), 'keep me\n');
	});
});

// ---------------------------------------------------------------------------
// Phase 226 — preparePatches duplicate-block guard
// ---------------------------------------------------------------------------

describe('preparePatches duplicate-block guard (phase 226)', () => {
	// The multi-line block that duplicates itself in the phase-223 run-3 forensic.
	// The guard checks: after applying the patch, does the replace text appear
	// more than once in the resulting file?
	const LISTEN_GUARD = [
		'if (process.env.NODE_ENV !== "test") {',
		'  server.listen(port, () => {',
		'    console.log(`Listening on port ${port}`);',
		'  });',
		'}',
	].join('\n');

	it('case 1: reproduction — patch whose replace is an existing block is rejected', async () => {
		// Seed file: listen guard already present once, plus a distinct anchor.
		// Patch: search = anchor, replace = LISTEN_GUARD (model re-emits the block,
		// dropping the anchor). After apply the guard would appear twice.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p226-repro-'));
		const initial = `export let server;\nconst port = 3000;\n\n${LISTEN_GUARD}\n`;
		await writeFile(join(cwd, 'server.mjs'), initial, 'utf8');

		const result = await preparePatches(
			cwd,
			[
				{
					// search = unique anchor; replace = just the guard block.
					// After apply: 'export let server;\n' + LISTEN_GUARD + '\n\n' + LISTEN_GUARD
					path: 'server.mjs',
					search: 'export let server;\nconst port = 3000;',
					replace: LISTEN_GUARD,
				},
			],
			{ apply: true },
		);

		// Must be rejected with duplicate_block reason.
		assert.equal(result.failedPatches.length, 1, 'expected one failed patch');
		assert.equal(
			result.failedPatches[0].reason,
			'duplicate_block',
			'reason must be duplicate_block',
		);
		assert.equal(result.writes.length, 0, 'no writes should be applied');

		// File on disk must be unchanged — block appears exactly once.
		const onDisk = await readFile(join(cwd, 'server.mjs'), 'utf8');
		assert.equal(
			onDisk,
			initial,
			'on-disk content must be unchanged (block not duplicated)',
		);
		const blockCount = onDisk.split(LISTEN_GUARD).length - 1;
		assert.equal(blockCount, 1, 'block must appear exactly once in file');
	});

	it('case 2: negative — single-line replace is allowed (isMultiLineBlock gate)', async () => {
		// A patch whose replace is a single line should apply normally even if
		// that literal already appears elsewhere in the file.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p226-singleline-'));
		await writeFile(
			join(cwd, 'app.mjs'),
			'const a = 1;\nconst b = 2;\n',
			'utf8',
		);

		const result = await preparePatches(
			cwd,
			[
				{
					path: 'app.mjs',
					search: 'const a = 1;\n',
					replace: 'const a = 10;\n',
				},
			],
			{ apply: true },
		);

		// Single-line replace: must apply normally.
		assert.equal(result.writes.length, 1, 'single-line replace must apply');
		assert.equal(result.failedPatches.length, 0, 'no failed patches expected');
	});

	it('case 3: negative — normal multi-line insertion is allowed (block absent)', async () => {
		// A multi-line replace block that does NOT already exist in the file
		// must apply normally (appears exactly once after apply).
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p226-newblock-'));
		await writeFile(join(cwd, 'app.mjs'), 'const a = 1;\n', 'utf8');

		const newBlock = ['function greet() {', '  return "hello";', '}'].join(
			'\n',
		);

		const result = await preparePatches(
			cwd,
			[
				{
					path: 'app.mjs',
					search: 'const a = 1;',
					replace: `const a = 1;\n\n${newBlock}`,
				},
			],
			{ apply: true },
		);

		assert.equal(result.writes.length, 1, 'new multi-line block must apply');
		assert.equal(result.failedPatches.length, 0, 'no failed patches expected');
		const content = await readFile(join(cwd, 'app.mjs'), 'utf8');
		assert.match(content, /function greet/u, 'new block must be in file');
	});

	it('case 4: compose — rejected duplicate does not corrupt target.content for a later clean patch', async () => {
		// Two patches to the same file:
		// Patch 1: search = anchor, replace = LISTEN_GUARD (would duplicate the guard).
		// Patch 2: clean distinct edit (rename a variable).
		// Assert: patch 1 is rejected (duplicate_block), patch 2 still applies.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p226-compose-'));
		// File has the anchor and the guard once each.
		const initial = `export let server;\nconst port = 3000;\n\n${LISTEN_GUARD}\n`;
		await writeFile(join(cwd, 'server.mjs'), initial, 'utf8');

		const result = await preparePatches(
			cwd,
			[
				// Patch 1: re-adds the listen guard (duplicate_block → rejected).
				{
					path: 'server.mjs',
					search: 'export let server;\nconst port = 3000;',
					replace: LISTEN_GUARD,
				},
				// Patch 2: clean edit — change port value (anchor is still in file since patch 1 was rejected).
				{
					path: 'server.mjs',
					search: 'const port = 3000;',
					replace: 'const port = 8080;',
				},
			],
			{ apply: true },
		);

		assert.equal(result.failedPatches.length, 1, 'one rejected patch expected');
		assert.equal(
			result.failedPatches[0].reason,
			'duplicate_block',
			'rejected reason must be duplicate_block',
		);
		assert.equal(result.writes.length, 1, 'clean patch must apply');

		const content = await readFile(join(cwd, 'server.mjs'), 'utf8');
		assert.match(content, /port = 8080/u, 'clean patch must have applied');
		// Block must still appear exactly once — not duplicated by the rejected patch.
		const blockCount = content.split(LISTEN_GUARD).length - 1;
		assert.equal(blockCount, 1, 'block must still appear exactly once');
	});
});

describe('makeDiff', () => {
	const exists = (content) => ({ content, exists: true });

	it('emits all additions for a newly created file', () => {
		const diff = makeDiff(
			'a.txt',
			{ content: '', exists: false },
			'one\ntwo\n',
		);
		assert.match(diff, /^--- a\.txt\n\+\+\+ a\.txt\n/u);
		// New file: old side is empty (-0,0).
		assert.match(diff, /@@ -0,0 \+1,3 @@/u);
		assert.match(diff, /\+one/u);
		assert.match(diff, /\+two/u);
		// A deletion line starts with a single "-" (not the "---" header).
		assert.ok(!/^-[^-]/mu.test(diff), 'no deletion lines for a new file');
	});

	it('emits only deletions when lines are removed', () => {
		const diff = makeDiff('a.txt', exists('a\nb\nc\n'), 'a\nc\n');
		assert.match(diff, /^@@ /mu);
		assert.match(diff, /-b/u);
		// An addition line starts with a single "+" (not the "+++" header).
		assert.ok(!/^\+[^+]/mu.test(diff), 'no addition lines when only deleting');
	});

	it('shows a mixed change with surrounding context', () => {
		const before = exists('one\ntwo\nthree\nfour\nfive\n');
		const diff = makeDiff('a.txt', before, 'one\ntwo\nTHREE\nfour\nfive\n');
		assert.match(diff, /-three/u);
		assert.match(diff, /\+THREE/u);
		// Context lines around the change are kept (prefixed with a space).
		assert.match(diff, /\n two\n/u);
		assert.match(diff, /\n four\n/u);
	});

	it('produces no hunks when content is unchanged', () => {
		const diff = makeDiff('a.txt', exists('same\nlines\n'), 'same\nlines\n');
		assert.equal(diff, '--- a.txt\n+++ a.txt\n');
	});

	it('splits distant changes into separate hunks', () => {
		const before = exists(
			Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n'),
		);
		const afterLines = Array.from({ length: 30 }, (_, i) => `line${i}`);
		afterLines[2] = 'CHANGED2';
		afterLines[25] = 'CHANGED25';
		const diff = makeDiff('a.txt', before, afterLines.join('\n'));
		const hunkCount = (diff.match(/^@@ /gmu) || []).length;
		assert.equal(hunkCount, 2);
	});

	it('falls back to a whole-file dump past the line bound', () => {
		const big = `${Array.from({ length: 2001 }, (_, i) => `l${i}`).join('\n')}\n`;
		const diff = makeDiff('big.txt', exists(big), `${big}extra\n`);
		// Fallback shape: no hunk headers, just bulk -/+ lines.
		assert.ok(!/@@ /u.test(diff), 'no hunk headers in fallback mode');
		assert.match(diff, /^--- big\.txt\n\+\+\+ big\.txt\n/u);
		assert.match(diff, /\n-l0\n/u);
		assert.match(diff, /\n\+l0\n/u);
	});
});
