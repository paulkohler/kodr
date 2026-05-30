import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { main } from './note-linker.mjs';

async function fixtureDir() {
  return mkdtemp(join(tmpdir(), 'note-linker-test-'));
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
}

describe('note-linker', () => {
  it('empty directory → no broken links', async () => {
    const dir = await fixtureDir();
    try {
      const result = await main(dir);
      if (result.broken.length !== 0) {
        throw new Error(`Expected no broken links, got ${result.broken}`);
      }
      if (result.links.size !== 0) {
        throw new Error(`Expected no links, got ${result.links.size}`);
      }
    } finally {
      await cleanup(dir);
    }
  });

  it('single file with a link to another file that exists → no broken links', async () => {
    const dir = await fixtureDir();
    try {
      await writeFile(join(dir, 'a.md'), 'Hello [[b]]');
      await writeFile(join(dir, 'b.md'), 'World');
      const result = await main(dir);
      if (result.broken.length !== 0) {
        throw new Error(`Expected no broken links, got ${result.broken}`);
      }
      const aLinks = result.links.get('a.md');
      if (!aLinks || aLinks.length !== 1 || aLinks[0] !== 'b') {
        throw new Error(`Expected a.md to link to b, got ${JSON.stringify(aLinks)}`);
      }
    } finally {
      await cleanup(dir);
    }
  });

  it('single file with a link to a file that doesn\'t exist → broken link reported', async () => {
    const dir = await fixtureDir();
    try {
      await writeFile(join(dir, 'a.md'), 'Hello [[missing]]');
      const result = await main(dir);
      if (result.broken.length !== 1 || result.broken[0] !== 'missing') {
        throw new Error(`Expected broken link "missing", got ${JSON.stringify(result.broken)}`);
      }
    } finally {
      await cleanup(dir);
    }
  });

  it('links are case-insensitive (FileA links to [[filea]] which resolves)', async () => {
    const dir = await fixtureDir();
    try {
      await writeFile(join(dir, 'FileA.md'), 'Hello [[filea]]');
      await writeFile(join(dir, 'filea.md'), 'World');
      const result = await main(dir);
      if (result.broken.length !== 0) {
        throw new Error(`Expected no broken links, got ${result.broken}`);
      }
    } finally {
      await cleanup(dir);
    }
  });

  it('link text may omit the .md extension ([[about]] resolves to about.md)', async () => {
    const dir = await fixtureDir();
    try {
      await writeFile(join(dir, 'index.md'), 'See [[about]]');
      await writeFile(join(dir, 'about.md'), 'About page');
      const result = await main(dir);
      if (result.broken.length !== 0) {
        throw new Error(`Expected no broken links, got ${result.broken}`);
      }
    } finally {
      await cleanup(dir);
    }
  });

  it('multiple files, some broken some not — only broken ones reported', async () => {
    const dir = await fixtureDir();
    try {
      await writeFile(join(dir, 'a.md'), 'Links to [[b]] and [[missing]]');
      await writeFile(join(dir, 'b.md'), 'Exists');
      await writeFile(join(dir, 'c.md'), 'Links to [[a]]');
      const result = await main(dir);
      if (result.broken.length !== 1 || result.broken[0] !== 'missing') {
        throw new Error(`Expected only "missing" broken, got ${JSON.stringify(result.broken)}`);
      }
    } finally {
      await cleanup(dir);
    }
  });

  it('duplicate broken links across files — deduplicated in output', async () => {
    const dir = await fixtureDir();
    try {
      await writeFile(join(dir, 'a.md'), 'Links to [[gone]]');
      await writeFile(join(dir, 'b.md'), 'Also links to [[gone]]');
      const result = await main(dir);
      if (result.broken.length !== 1 || result.broken[0] !== 'gone') {
        throw new Error(`Expected one broken link "gone", got ${JSON.stringify(result.broken)}`);
      }
    } finally {
      await cleanup(dir);
    }
  });
});
