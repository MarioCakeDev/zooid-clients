export interface LoginFlow {
  type: string;
  identity_providers?: { id: string; name: string }[];
  // Other flow-specific fields are forward-compatible — the client looks at
  // `type` and `identity_providers` only.
  [k: string]: unknown;
}

export interface Credentials {
  homeserverUrl: string;
  accessToken: string;
  userId: string;
  deviceId: string;
  /**
   * OIDC refresh token, when the session came from a MAS/OIDC login. Its
   * presence (together with `issuer`) is what lets the session outlive a
   * short-lived access token.
   */
  refreshToken?: string;
  /** OIDC issuer to refresh tokens against. Set for MAS/OIDC sessions. */
  issuer?: string;
  /**
   * Public OIDC client id this session authorized with. Persisted so a refresh
   * (including one triggered after a reload) sends the same `client_id` the
   * refresh token was issued to.
   */
  oidcClientId?: string;
  /** Absolute epoch-ms at which `accessToken` expires, when the OP told us. */
  expiresAt?: number;
}

export interface AuthConfig {
  issuer: string;
  account?: string;
  /**
   * Public OIDC client id registered with MAS for this deployment. Resolved
   * from runtime `/config.json` or build-time `VITE_OIDC_CLIENT_ID` — never
   * hardcoded, since it belongs to the homeserver this build is served for.
   */
  oidcClientId?: string;
}

/**
 * Access token lifetimes are refreshed this far ahead of expiry, so a refresh
 * lands before the next request can be rejected with M_UNKNOWN_TOKEN.
 */
export const TOKEN_REFRESH_LEAD_MS = 60_000;

// PKCE utilities for OIDC authorization code flow
function base64urlencode(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64urlencode(crypto.getRandomValues(new Uint8Array(32)));
  const challengeBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64urlencode(challengeBuffer) };
}

export function getDeviceId(): string {
  const existing = sessionStorage.getItem("zooid_device_id");
  if (existing) return existing;
  const id = `WEB-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
  sessionStorage.setItem("zooid_device_id", id);
  return id;
}

export function buildAuthorizeUrl(
  issuer: string,
  clientId: string,
  redirectUri: string,
  scopes: string,
  codeChallenge: string,
): string {
  const state = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `${issuer}/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&response_mode=fragment&scope=${encodeURIComponent(scopes)}&state=${state}&code_challenge_method=S256&code_challenge=${codeChallenge}`;
}

export async function fetchLoginFlows(
  homeserverUrl: string,
  authConfig?: AuthConfig,
): Promise<LoginFlow[]> {
  // If OIDC/MAS is configured, the server returns HTML instead of JSON.
  // In that case, return a synthetic SSO flow so the UI shows the login button.
  if (authConfig?.issuer) {
    return [{ type: "m.login.sso", identity_providers: [{ id: "oidc", name: "Sign in" }] }];
  }

  const res = await fetch(`${homeserverUrl}/_matrix/client/v3/login`);
  if (!res.ok) throw await matrixError(res);

  // Detect MAS HTML response (MAS returns HTML instead of JSON for /login)
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/html")) {
    // Server uses MAS/OIDC — return a synthetic SSO flow
    return [{ type: "m.login.sso", identity_providers: [{ id: "oidc", name: "Sign in" }] }];
  }

  const json = (await res.json()) as { flows: LoginFlow[] };
  return json.flows;
}

export async function loginWithPassword(
  homeserverUrl: string,
  username: string,
  password: string,
): Promise<Credentials> {
  const res = await fetch(`${homeserverUrl}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: username },
      password,
      initial_device_display_name: "Zooid Web",
    }),
  });
  if (!res.ok) throw await matrixError(res);
  return parseCredentials(homeserverUrl, await res.json());
}

export async function exchangeLoginToken(
  homeserverUrl: string,
  loginToken: string,
): Promise<Credentials> {
  const res = await fetch(`${homeserverUrl}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.token",
      token: loginToken,
      initial_device_display_name: "Zooid Web",
    }),
  });
  if (!res.ok) throw await matrixError(res);
  return parseCredentials(homeserverUrl, await res.json());
}

export async function exchangeAuthorizationCode(
  homeserverUrl: string,
  issuer: string,
  oidcClientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<Credentials> {
  const tokenEndpoint = `${issuer.replace(/\/+$/, "")}/oauth2/token`;
  const tokenRes = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: oidcClientId,
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${body}`);
  }
  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
    scope: string;
  };
  const accessToken = tokenData.access_token;

  // Resolve Matrix user ID via whoami
  const whoamiRes = await fetch(`${homeserverUrl.replace(/\/+$/, "")}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!whoamiRes.ok) throw await matrixError(whoamiRes);
  const whoami = (await whoamiRes.json()) as { user_id: string; device_id?: string };

  return {
    homeserverUrl,
    accessToken,
    userId: whoami.user_id,
    deviceId: whoami.device_id ?? getDeviceId(),
    refreshToken: tokenData.refresh_token,
    issuer: issuer.replace(/\/+$/, ""),
    oidcClientId,
    expiresAt: expiryFrom(tokenData.expires_in),
  };
}

/** Turn an `expires_in` (seconds, per OAuth) into an absolute epoch-ms instant. */
function expiryFrom(expiresIn: number | undefined): number | undefined {
  return typeof expiresIn === "number" && Number.isFinite(expiresIn)
    ? Date.now() + expiresIn * 1000
    : undefined;
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * Exchange an OIDC refresh token for a fresh access token via the issuer's
 * token endpoint. MAS rotates refresh tokens; when it does, the new one is
 * returned and callers must persist it. A response without a new refresh token
 * means the old one stays valid and is returned unchanged.
 */
export async function refreshAccessToken(
  issuer: string,
  refreshToken: string,
  oidcClientId: string,
): Promise<RefreshedTokens> {
  const tokenEndpoint = `${issuer.replace(/\/+$/, "")}/oauth2/token`;
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: oidcClientId,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: expiryFrom(data.expires_in),
  };
}

export function ssoRedirectUrl(
  homeserverUrl: string,
  redirectUrl: string,
  idpId?: string,
): string {
  const path = idpId
    ? `/_matrix/client/v3/login/sso/redirect/${encodeURIComponent(idpId)}`
    : `/_matrix/client/v3/login/sso/redirect`;
  return `${homeserverUrl}${path}?redirectUrl=${encodeURIComponent(redirectUrl)}`;
}

function parseCredentials(homeserverUrl: string, json: unknown): Credentials {
  const j = json as { access_token: string; user_id: string; device_id: string };
  return {
    homeserverUrl,
    accessToken: j.access_token,
    userId: j.user_id,
    deviceId: j.device_id,
  };
}

export async function matrixError(res: Response): Promise<Error> {
  try {
    const j = (await res.json()) as { error?: string; errcode?: string };
    return new Error(j.error ?? j.errcode ?? `HTTP ${res.status}`);
  } catch {
    return new Error(`HTTP ${res.status}`);
  }
}
