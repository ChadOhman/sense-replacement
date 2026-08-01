#!/usr/bin/env node
// Writes build-time version identity to the path given as argv[1].
// SHA source: GITHUB_SHA (CI) > git rev-parse (local build) > "dev".
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const out = process.argv[2];
if (!out) {
  console.error('usage: gen-version.mjs <output-path>');
  process.exit(1);
}

let sha = process.env.GITHUB_SHA ?? '';
if (!sha) {
  try {
    sha = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    sha = 'dev';
  }
}

const version = {
  sha,
  shortSha: sha === 'dev' ? 'dev' : sha.slice(0, 7),
  builtAt: new Date().toISOString(),
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(version, null, 2) + '\n');
console.log(`version: ${version.shortSha} (${out})`);
