import { afterEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { IndexedDBStore, MemoryStore } from "matrix-js-sdk";
import { mswServer } from "../../test/setup";
import { MatrixClientPeg } from "./peg";
import { sessionStorage_ } from "./storage";
import {
  resetStoreFactoryForTest,
  setStoreFactoryForTest,
} from "./store";

const creds = {
  homeserverUrl: "https://h.example",
  accessToken: "tok",
  userId: "@alice:h.example",
  deviceId: "DEV1",
};

describe("MatrixClientPeg", () => {
  afterEach(() => {
    MatrixClientPeg.reset();
    resetStoreFactoryForTest();
  });

  it("returns null before set()", () => {
    expect(MatrixClientPeg.safeGet()).toBeNull();
  });

  it("creates a client and emits change on set()", () => {
    const onChange = vi.fn();
    MatrixClientPeg.subscribe(onChange);
    MatrixClientPeg.set(creds);
    expect(MatrixClientPeg.safeGet()).not.toBeNull();
    expect(MatrixClientPeg.safeGet()!.getUserId()).toBe(creds.userId);
    expect(onChange).toHaveBeenCalledOnce();
  });

  // Without timelineSupport, EventTimelineSet.resetLiveTimeline() throws away
  // every loaded event on any gappy sync, so a backgrounded tab comes back to
  // a timeline with a silent hole in it (zooid-ai/zooid#14).
  it("enables timelineSupport so a gappy sync doesn't discard loaded history", () => {
    MatrixClientPeg.set(creds);
    const c = MatrixClientPeg.safeGet()! as unknown as { timelineSupport: boolean };
    expect(c.timelineSupport).toBe(true);
  });

  it("reset() stops the client and clears the peg", () => {
    MatrixClientPeg.set(creds);
    const c = MatrixClientPeg.safeGet()!;
    const stopSpy = vi.spyOn(c, "stopClient");
    MatrixClientPeg.reset();
    expect(MatrixClientPeg.safeGet()).toBeNull();
    expect(stopSpy).toHaveBeenCalled();
  });

  it("subscribe returns an unsubscribe fn", () => {
    const onChange = vi.fn();
    const unsub = MatrixClientPeg.subscribe(onChange);
    unsub();
    MatrixClientPeg.set(creds);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("gives the client an IndexedDBStore by default", () => {
    MatrixClientPeg.set(creds);
    const store = (MatrixClientPeg.safeGet() as unknown as { store: unknown }).store;
    expect(store).toBeInstanceOf(IndexedDBStore);
  });

  it("resolves whenStoreReady({ persistent: true }) once startup succeeds", async () => {
    MatrixClientPeg.set(creds);
    await expect(MatrixClientPeg.whenStoreReady()).resolves.toEqual({ persistent: true });
  });

  it("degrades to MemoryStore, loudly, when store startup rejects", async () => {
    const boom = new Error("IDB blocked");
    const bad = new MemoryStore({ localStorage: globalThis.localStorage });
    (bad as unknown as { startup: () => Promise<void> }).startup = () => Promise.reject(boom);
    setStoreFactoryForTest(() => bad);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    MatrixClientPeg.set(creds);
    const readiness = await MatrixClientPeg.whenStoreReady();

    expect(readiness.persistent).toBe(false);
    expect(readiness.reason).toContain("IDB blocked");
    // Boots anyway — a cold sync is a degraded experience, not a broken one.
    expect(MatrixClientPeg.safeGet()).not.toBeNull();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("reset() stays synchronous and does NOT delete persisted data", () => {
    const store = new MemoryStore({ localStorage: globalThis.localStorage });
    const del = vi.fn(() => Promise.resolve());
    (store as unknown as { deleteAllData: () => Promise<void> }).deleteAllData = del;
    setStoreFactoryForTest(() => store);

    MatrixClientPeg.set(creds);
    const out = MatrixClientPeg.reset();

    expect(out).toBeUndefined(); // sync signature — ~90 afterEach blocks depend on this
    expect(MatrixClientPeg.safeGet()).toBeNull();
    expect(del).not.toHaveBeenCalled();
  });

  it("logout() deletes persisted data before clearing the peg", async () => {
    const store = new MemoryStore({ localStorage: globalThis.localStorage });
    const del = vi.fn(() => Promise.resolve());
    (store as unknown as { deleteAllData: () => Promise<void> }).deleteAllData = del;
    setStoreFactoryForTest(() => store);

    MatrixClientPeg.set(creds);
    await MatrixClientPeg.logout();

    expect(del).toHaveBeenCalled();
    expect(MatrixClientPeg.safeGet()).toBeNull();
  });

  describe("OIDC token refresh", () => {
    const ISSUER = "https://mas.example";
    const CLIENT_ID = "test-oidc-client";
    const oidcCreds = {
      ...creds,
      refreshToken: "rt1",
      issuer: ISSUER,
      oidcClientId: CLIENT_ID,
      expiresAt: Date.now() + 300_000,
    };

    it("does not configure refresh for a non-OIDC session", () => {
      const c = MatrixClientPeg.set(creds);
      expect(c.getRefreshToken()).toBeNull();
    });

    it("does not configure refresh without a client id", () => {
      const { oidcClientId: _drop, ...withoutClientId } = oidcCreds;
      const c = MatrixClientPeg.set(withoutClientId);
      expect(c.getRefreshToken()).toBeNull();
    });

    it("hands the refresh token to the SDK", () => {
      const c = MatrixClientPeg.set(oidcCreds);
      expect(c.getRefreshToken()).toBe("rt1");
    });

    it("refreshes and retries after M_UNKNOWN_TOKEN instead of logging out", async () => {
      const calls: string[] = [];
      mswServer.use(
        http.post(`${ISSUER}/oauth2/token`, async ({ request }) => {
          const body = new URLSearchParams(await request.text());
          expect(body.get("grant_type")).toBe("refresh_token");
          expect(body.get("refresh_token")).toBe("rt1");
          expect(body.get("client_id")).toBe(CLIENT_ID);
          calls.push("refresh");
          return HttpResponse.json({ access_token: "at2", expires_in: 300, refresh_token: "rt2" });
        }),
        http.get(`${creds.homeserverUrl}/_matrix/client/v3/account/whoami`, ({ request }) => {
          calls.push("whoami");
          if (request.headers.get("Authorization") === "Bearer at2") {
            return HttpResponse.json({ user_id: creds.userId, device_id: creds.deviceId });
          }
          return HttpResponse.json({ errcode: "M_UNKNOWN_TOKEN", error: "expired" }, { status: 401 });
        }),
      );

      const c = MatrixClientPeg.set(oidcCreds);
      await c.whoami();

      expect(calls).toEqual(["whoami", "refresh", "whoami"]);
      expect(c.getAccessToken()).toBe("at2");
      // The rotated refresh token is persisted so a reload keeps refreshing.
      expect(sessionStorage_.getJSON<{ refreshToken?: string }>("session")?.refreshToken).toBe("rt2");
    });

    it("proactively refreshes before the access token expires", async () => {
      let refreshed = 0;
      mswServer.use(
        http.post(`${ISSUER}/oauth2/token`, () => {
          refreshed += 1;
          return HttpResponse.json({ access_token: "at2", expires_in: 300, refresh_token: "rt2" });
        }),
      );

      const c = MatrixClientPeg.set({ ...oidcCreds, expiresAt: Date.now() + 1_000 });
      await vi.waitFor(() => expect(refreshed).toBe(1));
      expect(c.getAccessToken()).toBe("at2");
    });

    it("does not resurrect the session when logout races an in-flight refresh", async () => {
      let started = false;
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      mswServer.use(
        http.post(`${ISSUER}/oauth2/token`, async () => {
          started = true;
          await gate;
          return HttpResponse.json({ access_token: "at2", expires_in: 300, refresh_token: "rt2" });
        }),
      );
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      MatrixClientPeg.set({ ...oidcCreds, expiresAt: Date.now() + 1_000 });
      await vi.waitFor(() => expect(started).toBe(true));

      MatrixClientPeg.reset();
      release();
      await vi.waitFor(() => expect(errSpy).toHaveBeenCalled());

      // The aborted refresh must not rewrite the session it no longer owns.
      expect(sessionStorage_.getJSON("session")).toBeNull();
      errSpy.mockRestore();
    });
  });

  it("logout() still clears the peg when deleteAllData rejects", async () => {
    const store = new MemoryStore({ localStorage: globalThis.localStorage });
    (store as unknown as { deleteAllData: () => Promise<void> }).deleteAllData = () =>
      Promise.reject(new Error("quota"));
    setStoreFactoryForTest(() => store);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    MatrixClientPeg.set(creds);
    await MatrixClientPeg.logout();

    // A failed cache wipe must never strand the user in a logged-in shell.
    expect(MatrixClientPeg.safeGet()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
