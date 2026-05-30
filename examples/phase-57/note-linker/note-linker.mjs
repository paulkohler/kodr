#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const WIKI_LINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Recursively collect all .md file paths under a directory.
 */
async function collectMdFiles(dir) {
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMdFiles(fullPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Extract all wiki-style link targets from a file's content.
 */
function extractLinks(content) {
  const targets = [];
  let match;
  const re = new RegExp(WIKI_LINK_RE);
  while ((match = re.exec(content)) !== null) {
    targets.push(match[1]);
  }
  return targets;
}

/**
 * Resolve a link target to a candidate .md filename (case-insensitive).
 */
function resolveLinkTarget(target, existingFiles) {
  const lower = target.toLowerCase();
  // Try exact match first (with .md)
  const exact = existingFiles.find(
    (f) => f.toLowerCase() === lower,
  );
  if (exact) return exact;
  // Try appending .md
  const withExt = existingFiles.find(
    (f) => f.toLowerCase() === lower + '.md',
  );
  if (withExt) return withExt;
  return null;
}

/**
 * Scan a directory for wiki-style links and report broken ones.
 *
 * @param {string} dir - Absolute or relative directory path.
 * @returns {Promise<{ links: Map<string, string[]>, broken: string[] }>}
 */
export async function main(dir) {
  const absDir = resolve(dir);
  const mdFiles = await collectMdFiles(absDir);
  const fileNames = mdFiles.map((f) => relative(absDir, f));

  const links = new Map();
  const brokenSet = new Set();

  for (const filePath of mdFiles) {
    const relPath = relative(absDir, filePath);
    const content = await readFile(filePath, 'utf8');
    const targets = extractLinks(content);
    links.set(relPath, targets);

    for (const target of targets) {
      if (!resolveLinkTarget(target, fileNames)) {
        brokenSet.add(target);
      }
    }
  }

  return {
    links,
    broken: [...brokenSet].sort(),
  };
}

// CLI entry point
if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  if (!dir) {
    process.stderr.write('Usage: node note-linker.mjs <dir>\n');
    process.exitCode = 1;
  } else {
    try {
      const result = await main(dir);
      if (result.broken.length === 0) {
        process.stdout.write('No broken links.\n');
      } else {
        for (const link of result.broken) {
          process.stdout.write(`${link}\n`);
        }
      }
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    }
  }
}
