import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { mswServer } from "../../test/setup";
import {
  exchangeAuthorizationCode,
  exchangeLoginToken,
  fetchLoginFlows,
  loginWithPassword,
  refreshAccessToken,
  ssoRedirectUrl,
} from "./login";

const HS = "https://h.example";
const CLIENT_ID = "test-oidc-client";

describe("fetchLoginFlows", () => {
  it("returns the flows array verbatim", async () => {
    mswServer.use(
      http.get(`${HS}/_matrix/client/v3/login`, () =>
        HttpResponse.json({
          flows: [
            { type: "m.login.password" },
            { type: "m.login.sso", identity_providers: [{ id: "zoon", name: "Zoon" }] },
          ],
        }),
      ),
    );
    const flows = await fetchLoginFlows(HS);
    expect(flows).toHaveLength(2);
    expect(flows[0].type).toBe("m.login.password");
    expect(flows[1].type).toBe("m.login.sso");
  });
});

describe("loginWithPassword", () => {
  it("POSTs to /login and returns credentials", async () => {
    mswServer.use(
      http.post(`${HS}/_matrix/client/v3/login`, async ({ request }) => {
        const body = (await request.json()) as { type: string; password: string };
        expect(body.type).toBe("m.login.password");
        expect(body.password).toBe("hunter2");
        return HttpResponse.json({
          access_token: "tok",
          user_id: "@alice:h.example",
          device_id: "DEV1",
        });
      }),
    );
    const creds = await loginWithPassword(HS, "alice", "hunter2");
    expect(creds).toEqual({
      accessToken: "tok",
      userId: "@alice:h.example",
      deviceId: "DEV1",
      homeserverUrl: HS,
    });
  });

  it("throws on 403", async () => {
    mswServer.use(
      http.post(`${HS}/_matrix/client/v3/login`, () =>
        HttpResponse.json({ errcode: "M_FORBIDDEN", error: "wrong" }, { status: 403 }),
      ),
    );
    await expect(loginWithPassword(HS, "alice", "wrong")).rejects.toThrow(/wrong/);
  });
});

describe("ssoRedirectUrl", () => {
  it("builds the redirect URL with idpId when supplied", () => {
    const url = ssoRedirectUrl(HS, "https://app.example/auth/callback", "zoon");
    expect(url).toBe(
      `${HS}/_matrix/client/v3/login/sso/redirect/zoon?redirectUrl=${encodeURIComponent("https://app.example/auth/callback")}`,
    );
  });

  it("omits idpId for default SSO", () => {
    const url = ssoRedirectUrl(HS, "https://app.example/auth/callback");
    expect(url).toBe(
      `${HS}/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent("https://app.example/auth/callback")}`,
    );
  });
});

describe("exchangeLoginToken", () => {
  it("POSTs m.login.token and returns credentials", async () => {
    mswServer.use(
      http.post(`${HS}/_matrix/client/v3/login`, async ({ request }) => {
        const body = (await request.json()) as { type: string; token: string };
        expect(body.type).toBe("m.login.token");
        expect(body.token).toBe("LT");
        return HttpResponse.json({
          access_token: "tok",
          user_id: "@alice:h.example",
          device_id: "DEV2",
        });
      }),
    );
    const creds = await exchangeLoginToken(HS, "LT");
    expect(creds.accessToken).toBe("tok");
    expect(creds.deviceId).toBe("DEV2");
  });
});

const ISSUER = "https://mas.example";

describe("exchangeAuthorizationCode", () => {
  it("keeps the refresh token, issuer and expiry from the OIDC token response", async () => {
    const before = Date.now();
    mswServer.use(
      http.post(`${ISSUER}/oauth2/token`, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("client_id")).toBe(CLIENT_ID);
        expect(body.get("code_verifier")).toBe("verifier");
        return HttpResponse.json({
          access_token: "at1",
          token_type: "Bearer",
          expires_in: 300,
          refresh_token: "rt1",
          scope: "openid",
        });
      }),
      http.get(`${HS}/_matrix/client/v3/account/whoami`, ({ request }) => {
        expect(request.headers.get("Authorization")).toBe("Bearer at1");
        return HttpResponse.json({ user_id: "@alice:h.example", device_id: "DEV1" });
      }),
    );

    const creds = await exchangeAuthorizationCode(
      HS,
      ISSUER,
      CLIENT_ID,
      "code",
      "verifier",
      "https://app.example/auth/callback",
    );
    expect(creds.refreshToken).toBe("rt1");
    expect(creds.issuer).toBe(ISSUER);
    expect(creds.oidcClientId).toBe(CLIENT_ID);
    expect(creds.expiresAt).toBeGreaterThanOrEqual(before + 300_000);
  });
});

describe("refreshAccessToken", () => {
  it("POSTs a refresh_token grant and returns the rotated tokens", async () => {
    mswServer.use(
      http.post(`${ISSUER}/oauth2/token`, async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("rt1");
        expect(body.get("client_id")).toBe(CLIENT_ID);
        return HttpResponse.json({
          access_token: "at2",
          expires_in: 300,
          refresh_token: "rt2",
        });
      }),
    );
    const tokens = await refreshAccessToken(ISSUER, "rt1", CLIENT_ID);
    expect(tokens.accessToken).toBe("at2");
    expect(tokens.refreshToken).toBe("rt2");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it("keeps the existing refresh token when the OP does not rotate it", async () => {
    mswServer.use(
      http.post(`${ISSUER}/oauth2/token`, () =>
        HttpResponse.json({ access_token: "at2", expires_in: 300 }),
      ),
    );
    const tokens = await refreshAccessToken(ISSUER, "rt1", CLIENT_ID);
    expect(tokens.refreshToken).toBe("rt1");
  });

  it("throws with the response body when the refresh is rejected", async () => {
    mswServer.use(
      http.post(`${ISSUER}/oauth2/token`, () =>
        HttpResponse.json({ error: "invalid_grant" }, { status: 400 }),
      ),
    );
    await expect(refreshAccessToken(ISSUER, "stale", CLIENT_ID)).rejects.toThrow(/invalid_grant/);
  });
});
