import { z } from 'zod';
import type { VersionInfo } from '@sense/shared';
import type { KvStore } from '../db/index.js';
import { getVersion } from './version.js';

const CHECK_KEY = 'update.check';

export const manifestSchema = z.object({
  sha: z.string().min(7),
  shortSha: z.string().min(7),
  builtAt: z.string(),
  tarball: z.string().regex(/^[A-Za-z0-9._-]+\.tar\.gz$/), // bare filename, no paths
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().positive(),
});
export type UpdateManifest = z.infer<typeof manifestSchema>;

export interface UpdateCheck {
  latest: UpdateManifest | null;
  checkedTs: number;
  error: string | null;
}

export function getUpdateCheck(kv: KvStore): UpdateCheck | null {
  return kv.getJson<UpdateCheck>(CHECK_KEY);
}

export function isUpdateAvailable(kv: KvStore, current: VersionInfo = getVersion()): boolean {
  const latest = getUpdateCheck(kv)?.latest;
  return current.sha !== 'dev' && latest != null && latest.sha !== current.sha;
}

/** Fetch the pinned release manifest and cache the result in KV.
 *  Never throws — failures land in the cached error field. */
export async function checkForUpdate(
  kv: KvStore,
  manifestUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<UpdateCheck> {
  const checkedTs = Math.floor(Date.now() / 1000);
  let result: UpdateCheck;
  try {
    const res = await fetchFn(manifestUrl, {
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = manifestSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error(`invalid manifest: ${parsed.error.issues[0]?.message}`);
    result = { latest: parsed.data, checkedTs, error: null };
  } catch (err) {
    // Keep the previous good manifest so a transient outage doesn't hide a
    // known-available update.
    result = {
      latest: getUpdateCheck(kv)?.latest ?? null,
      checkedTs,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  kv.setJson(CHECK_KEY, result);
  return result;
}
