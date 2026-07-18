import { senseAuthResponseSchema, senseMfaChallengeSchema, type StoredTokens } from './types.js';

export const API_BASE = 'https://api.sense.com/apiservice/api/v1';

const COMMON_HEADERS: Record<string, string> = {
  'User-Agent': 'sense-replacement/0.1 (self-hosted archive)',
  'Sense-Client-Version': '1.17.1-20',
  'X-Sense-Protocol': '3',
};

export interface TokenStore {
  load(): StoredTokens | null;
  save(tokens: StoredTokens): void;
  clear(): void;
}

export class MfaRequiredError extends Error {
  constructor(public readonly mfaToken: string) {
    super('Sense requires a multi-factor authentication code');
  }
}

export class SenseAuthError extends Error {}

async function postForm(path: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    headers: {
      ...COMMON_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
  });
}

function toStoredTokens(raw: unknown): StoredTokens {
  const parsed = senseAuthResponseSchema.parse(raw);
  const monitor = parsed.monitors[0];
  if (!monitor) {
    throw new SenseAuthError('Sense account has no monitors attached');
  }
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    userId: parsed.user_id,
    accountId: parsed.account_id ?? null,
    monitorId: monitor.id,
    monitorTz: monitor.time_zone ?? null,
  };
}

/**
 * Password authentication. Throws MfaRequiredError when Sense demands a TOTP
 * code — hold on to its mfaToken and call completeMfa with the user's code.
 */
export async function authenticate(email: string, password: string): Promise<StoredTokens> {
  const res = await postForm('authenticate', { email, password });
  const body: unknown = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const mfa = senseMfaChallengeSchema.safeParse(body);
    if (mfa.success && (mfa.data.status === 'mfa_required' || mfa.data.error_reason?.toLowerCase().includes('mfa'))) {
      throw new MfaRequiredError(mfa.data.mfa_token);
    }
    throw new SenseAuthError('Sense rejected the email/password credentials');
  }
  if (!res.ok) {
    throw new SenseAuthError(`Sense authentication failed: HTTP ${res.status}`);
  }
  return toStoredTokens(body);
}

export async function completeMfa(mfaToken: string, totp: string): Promise<StoredTokens> {
  const res = await postForm('authenticate/mfa', {
    totp,
    mfa_token: mfaToken,
    client_time: new Date().toISOString(),
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SenseAuthError(
      res.status === 401 || res.status === 400
        ? 'Sense rejected the MFA code'
        : `Sense MFA verification failed: HTTP ${res.status}`,
    );
  }
  return toStoredTokens(body);
}

/** Exchange the refresh token for a fresh access token. Throws on failure. */
export async function renewToken(tokens: StoredTokens): Promise<StoredTokens> {
  if (!tokens.refreshToken) {
    throw new SenseAuthError('No refresh token available');
  }
  const res = await postForm('renew', {
    user_id: String(tokens.userId),
    refresh_token: tokens.refreshToken,
    is_access_token: 'true',
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SenseAuthError(`Token renewal failed: HTTP ${res.status}`);
  }
  const parsed = senseAuthResponseSchema
    .omit({ monitors: true })
    .extend({ monitors: senseAuthResponseSchema.shape.monitors.optional() })
    .parse(body);
  return {
    ...tokens,
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? tokens.refreshToken,
  };
}

export { COMMON_HEADERS };
