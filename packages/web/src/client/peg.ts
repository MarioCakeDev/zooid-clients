import { type MatrixClient, createClient } from "matrix-js-sdk";
import type { IStore } from "matrix-js-sdk/lib/store";
import { sessionStorage_ } from "./storage";
import { createMatrixStore, createMemoryStore } from "./store";
import { type Credentials, TOKEN_REFRESH_LEAD_MS, refreshAccessToken } from "./login";

type Listener = () => void;

export interface StoreReadiness {
  /** True when the session is backed by IndexedDB and survives a reload. */
  persistent: boolean;
  /** Why persistence is unavailable, when it is. */
  reason?: string;
}

class MatrixClientPegImpl {
  private client: MatrixClient | null = null;
  private store: IStore | null = null;
  private creds: Credentials | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshInFlight: Promise<void> | null = null;
  // Bumped on every set()/reset(). An in-flight refresh captures it and aborts
  // if the session changed under it, so a slow refresh can't rewrite storage or
  // re-arm a timer after logout, nor clobber a freshly logged-in session.
  private sessionGeneration = 0;
  private storeReady: Promise<StoreReadiness> = Promise.resolve({
    persistent: false,
    reason: "no session",
  });
  private listeners = new Set<Listener>();

  safeGet(): MatrixClient | null {
    return this.client;
  }

  get(): MatrixClient {
    if (!this.client) throw new Error("MatrixClientPeg: not logged in");
    return this.client;
  }

  set(creds: Credentials): MatrixClient {
    if (this.client) this.client.stopClient();
    this.clearRefreshTimer();
    this.refreshInFlight = null;
    this.sessionGeneration += 1;
    this.creds = creds;

    // The store is built explicitly (see ./store). IndexedDB gives us a saved
    // sync so a reload resumes from a token instead of running a cold initial
    // sync at initialSyncLimit — MemoryStore.getSavedSync() returns null
    // unconditionally, which is why every refresh used to lose history.
    const store = createMatrixStore(creds);
    this.store = store;

    // A MAS/OIDC session carries a refresh token; wiring it into the SDK lets
    // a request that trips over an expired access token refresh and retry
    // instead of surfacing M_UNKNOWN_TOKEN and dropping the user at /login.
    const canRefresh = Boolean(creds.issuer && creds.refreshToken);
    this.client = createClient({
      baseUrl: creds.homeserverUrl,
      accessToken: creds.accessToken,
      userId: creds.userId,
      deviceId: creds.deviceId,
      store,
      refreshToken: canRefresh ? creds.refreshToken : undefined,
      tokenRefreshFunction: canRefresh ? () => this.refreshOidcTokens() : undefined,
      // Required for history to survive a gappy ("limited: true") sync. The
      // SDK resets the live timeline whenever sync reports a gap, and
      // EventTimelineSet.resetLiveTimeline() discards *every* loaded event
      // unless timelineSupport is on — so a backgrounded tab would come back
      // to a timeline with a silent hole where the middle of the
      // conversation used to be. With it on, the old timeline is kept and
      // linked, which is what allRoomEvents() in use-timeline.ts assumes.
      timelineSupport: true,
    });

    this.watchForDegradation(store);

    // IndexedDBStore.startup() must run AFTER createClient (it needs the
    // client's createUser wired up) and BEFORE startClient (the sync loop
    // reads the saved token on its first pass). Nothing in the SDK calls it
    // for us — MatrixClient.startClient only awaits the *crypto* store.
    // startup() is also the one backend method the SDK does NOT wrap in its
    // degradable() helper, so it can reject and we must handle that.
    this.storeReady = this.startStore(store);

    if (canRefresh) this.scheduleTokenRefresh();

    sessionStorage_.setJSON("session", creds);
    this.emit();
    return this.client;
  }

  /**
   * Refresh the OIDC access token using the session's refresh token.
   *
   * Single-flight: the proactive timer and the SDK's reactive refresh (on
   * M_UNKNOWN_TOKEN) share this. MAS rotates refresh tokens, so two refreshes
   * racing would burn each other's — the second's token is already revoked.
   * The refresh token is read from `this.creds`, not the SDK's copy, so it is
   * always the newest one even after a proactive refresh the SDK didn't see.
   */
  private refreshOidcTokens(): Promise<{ accessToken: string; refreshToken?: string }> {
    if (this.refreshInFlight) {
      return this.refreshInFlight.then(() => ({
        accessToken: this.creds!.accessToken,
        refreshToken: this.creds!.refreshToken,
      }));
    }
    const current = this.creds;
    if (!current?.issuer || !current.refreshToken) {
      return Promise.reject(new Error("MatrixClientPeg: no OIDC refresh token for this session"));
    }
    const generation = this.sessionGeneration;
    const run = (async () => {
      const next = await refreshAccessToken(current.issuer!, current.refreshToken!);
      if (this.sessionGeneration !== generation) {
        throw new Error("MatrixClientPeg: session changed during token refresh");
      }
      const updated: Credentials = {
        ...current,
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        expiresAt: next.expiresAt,
      };
      this.creds = updated;
      sessionStorage_.setJSON("session", updated);
      // The SDK sets its own accessToken after this resolves, but doing it
      // here too keeps the live client correct when the proactive timer is the
      // trigger.
      this.client?.setAccessToken(updated.accessToken);
      this.scheduleTokenRefresh();
    })();
    this.refreshInFlight = run;
    const clear = () => {
      if (this.refreshInFlight === run) this.refreshInFlight = null;
    };
    run.then(clear, clear);
    return run.then(() => ({
      accessToken: this.creds!.accessToken,
      refreshToken: this.creds!.refreshToken,
    }));
  }

  /** Proactively refresh shortly before the access token expires. */
  private scheduleTokenRefresh(): void {
    this.clearRefreshTimer();
    const creds = this.creds;
    if (!creds?.issuer || !creds.refreshToken || !creds.expiresAt) return;
    const delay = Math.max(creds.expiresAt - Date.now() - TOKEN_REFRESH_LEAD_MS, 0);
    this.refreshTimer = setTimeout(() => {
      void this.refreshOidcTokens().catch((err) => {
        // Not fatal: the SDK's reactive refresh is still the backstop. Log it
        // so a persistently failing refresh is visible rather than a silent
        // expiry an hour later.
        console.error("[peg] proactive OIDC token refresh failed", err);
      });
    }, delay);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async startStore(store: IStore): Promise<StoreReadiness> {
    const startup = (store as unknown as { startup?: () => Promise<void> }).startup;
    if (typeof startup !== "function") return { persistent: false, reason: "store has no startup" };
    try {
      await startup.call(store);
      return { persistent: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Loud on purpose. A blocked or evicted IndexedDB (private browsing,
      // quota, a sibling tab holding an upgrade) silently costs the user their
      // history on every reload; it should not also be invisible to us.
      console.error(
        `[peg] IndexedDB store startup failed — falling back to MemoryStore. ` +
          `History will not survive a reload. Reason: ${reason}`,
        err,
      );
      const fallback = createMemoryStore();
      this.store = fallback;
      if (this.client) {
        (this.client as unknown as { store: IStore }).store = fallback;
      }
      return { persistent: false, reason };
    }
  }

  private watchForDegradation(store: IStore): void {
    const on = (store as unknown as { on?: (e: string, h: (...a: unknown[]) => void) => void }).on;
    if (typeof on !== "function") return;
    // IndexedDBStore wraps every backend call in degradable(), which swallows
    // the error, becomes a MemoryStore in place, and emits "degraded". Without
    // this listener that transition is completely invisible.
    on.call(store, "degraded", (err: unknown) => {
      console.error("[peg] IndexedDB store degraded to memory mid-session", err);
    });
    on.call(store, "closed", () => {
      console.error("[peg] IndexedDB store connection closed unexpectedly");
    });
  }

  /**
   * Resolves once the store has finished loading from disk. `startClient()`
   * must not run before this — otherwise the first sync goes out without the
   * saved token and we take a cold initial sync anyway.
   */
  whenStoreReady(): Promise<StoreReadiness> {
    return this.storeReady;
  }

  /**
   * Synchronous teardown: stop the client, drop the peg, clear credentials.
   *
   * Deliberately does NOT touch persisted data, and deliberately stays sync —
   * it is the token-revoked path in app.tsx and the teardown in ~90 test
   * afterEach blocks. Wiping the cache belongs to logout(), below.
   */
  reset(): void {
    if (this.client) {
      try {
        this.client.stopClient();
      } catch {
        // tolerated — stopClient is best-effort during teardown
      }
    }
    this.clearRefreshTimer();
    this.refreshInFlight = null;
    this.sessionGeneration += 1;
    this.creds = null;
    this.client = null;
    this.store = null;
    this.storeReady = Promise.resolve({ persistent: false, reason: "no session" });
    sessionStorage_.remove("session");
    this.emit();
  }

  /**
   * Deliberate sign-out. Deletes the persisted store first: without this the
   * previous user's rooms and messages stay in IndexedDB for whoever logs in
   * next on this browser profile.
   */
  async logout(): Promise<void> {
    const store = this.store as unknown as { deleteAllData?: () => Promise<void> } | null;
    try {
      await store?.deleteAllData?.();
    } catch (err) {
      // A cache we couldn't wipe must never strand the user in a logged-in
      // shell — log it and sign out regardless.
      console.warn("[peg] failed to delete persisted store data on logout", err);
    }
    this.reset();
  }

  /** TEST ONLY. Inject a pre-built client without going through createClient(). */
  injectClientForTest(client: MatrixClient): void {
    if (this.client) {
      try {
        this.client.stopClient();
      } catch {
        // tolerated
      }
    }
    this.client = client;
    this.emit();
  }

  restoreFromStorage(): Credentials | null {
    const creds = sessionStorage_.getJSON<Credentials>("session");
    if (!creds) return null;
    this.set(creds);
    return creds;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export const MatrixClientPeg = new MatrixClientPegImpl();
