import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { VersionInfo } from '@sense/shared';

const DEV_VERSION: VersionInfo = { sha: 'dev', shortSha: 'dev', builtAt: null };

let cached: VersionInfo | null = null;

/** Build-time identity written by scripts/gen-version.mjs to dist/version.json.
 *  Absent under tsx dev mode (nothing generates it) → 'dev'. */
export function getVersion(): VersionInfo {
  if (cached) return cached;
  // Compiled location is dist/update/version.js; the file sits at dist/version.json.
  const path = join(dirname(fileURLToPath(import.meta.url)), '../version.json');
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<VersionInfo>;
    if (typeof parsed.sha === 'string' && typeof parsed.shortSha === 'string') {
      cached = { sha: parsed.sha, shortSha: parsed.shortSha, builtAt: parsed.builtAt ?? null };
      return cached;
    }
  } catch {
    /* missing or malformed — dev build */
  }
  cached = DEV_VERSION;
  return cached;
}
