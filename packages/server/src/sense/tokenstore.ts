import type { KvStore } from '../db/index.js';
import type { TokenStore } from './auth.js';
import type { StoredTokens } from './types.js';

const KEY = 'sense.tokens';

/** Persists Sense tokens in the kv table so restarts never re-prompt for MFA. */
export class KvTokenStore implements TokenStore {
  constructor(private readonly kv: KvStore) {}

  load(): StoredTokens | null {
    return this.kv.getJson<StoredTokens>(KEY);
  }

  save(tokens: StoredTokens): void {
    this.kv.setJson(KEY, tokens);
  }

  clear(): void {
    this.kv.delete(KEY);
  }
}
