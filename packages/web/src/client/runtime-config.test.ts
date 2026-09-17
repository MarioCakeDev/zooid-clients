import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { mswServer } from "../../test/setup";
import { loadRuntimeConfig, resolveOidcClientId } from "./runtime-config";

describe("loadRuntimeConfig", () => {
  it("parses a valid config.json", async () => {
    mswServer.use(
      http.get("/config.json", () =>
        HttpResponse.json({ homeserver_url: "https://h.example", default_idp_label: "Zoon" }),
      ),
    );
    const cfg = await loadRuntimeConfig();
    expect(cfg).toEqual({ homeserver_url: "https://h.example", default_idp_label: "Zoon" });
  });

  it("returns null when /config.json is missing (404)", async () => {
    mswServer.use(http.get("/config.json", () => HttpResponse.json({}, { status: 404 })));
    expect(await loadRuntimeConfig()).toBeNull();
  });

  it("returns null when /config.json is invalid JSON", async () => {
    mswServer.use(http.get("/config.json", () => HttpResponse.text("not json")));
    expect(await loadRuntimeConfig()).toBeNull();
  });

  it("rejects unknown fields silently (forward-compat)", async () => {
    mswServer.use(
      http.get("/config.json", () =>
        HttpResponse.json({ homeserver_url: "https://h.example", future_field: 42 }),
      ),
    );
    const cfg = await loadRuntimeConfig();
    expect(cfg?.homeserver_url).toBe("https://h.example");
  });

  it("parses the global_search opt-out flag", async () => {
    mswServer.use(
      http.get("/config.json", () => HttpResponse.json({ global_search: false })),
    );
    const cfg = await loadRuntimeConfig();
    expect(cfg).toEqual({ global_search: false });
  });

  it("ignores a non-boolean global_search", async () => {
    mswServer.use(
      http.get("/config.json", () => HttpResponse.json({ global_search: "yes" })),
    );
    const cfg = await loadRuntimeConfig();
    expect(cfg).toEqual({});
  });

  it("reads the two push fields", async () => {
    mswServer.use(
      http.get("/config.json", () =>
        HttpResponse.json({
          homeserver_url: "https://hs.example",
          push_gateway_url: "https://hs.example/_matrix/push/v1/notify",
          vapid_public_key: "BPk",
        }),
      ),
    );
    const cfg = await loadRuntimeConfig();
    expect(cfg).toEqual({
      homeserver_url: "https://hs.example",
      push_gateway_url: "https://hs.example/_matrix/push/v1/notify",
      vapid_public_key: "BPk",
    });
  });

  it("drops non-string push fields rather than passing junk to subscribe()", async () => {
    mswServer.use(
      http.get("/config.json", () => HttpResponse.json({ push_gateway_url: 42, vapid_public_key: null })),
    );
    expect(await loadRuntimeConfig()).toEqual({});
  });

  it("reads the OIDC client id", async () => {
    mswServer.use(
      http.get("/config.json", () => HttpResponse.json({ oidc_client_id: "01M25" })),
    );
    expect(await loadRuntimeConfig()).toEqual({ oidc_client_id: "01M25" });
  });

  it("drops a non-string OIDC client id", async () => {
    mswServer.use(
      http.get("/config.json", () => HttpResponse.json({ oidc_client_id: 42 })),
    );
    expect(await loadRuntimeConfig()).toEqual({});
  });
});

describe("resolveOidcClientId", () => {
  it("prefers runtime config over build-time", () => {
    expect(
      resolveOidcClientId({ runtime: "runtime-id", buildtime: "build-id" }),
    ).toBe("runtime-id");
  });

  it("falls back to build-time when runtime is absent", () => {
    expect(resolveOidcClientId({ buildtime: "build-id" })).toBe("build-id");
  });

  it("returns null when neither is set — no hardcoded default", () => {
    expect(resolveOidcClientId({})).toBeNull();
    expect(resolveOidcClientId({ runtime: "", buildtime: "  " })).toBeNull();
  });

  it("treats a blank runtime value as absent and falls back to build-time", () => {
    expect(resolveOidcClientId({ runtime: "  ", buildtime: "build-id" })).toBe("build-id");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveOidcClientId({ buildtime: "  build-id  " })).toBe("build-id");
  });
});
