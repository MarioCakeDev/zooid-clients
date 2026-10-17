import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { mswServer } from "../../test/setup";
import { discoverHomeserver } from "./homeserver-discovery";

// `discoverHomeserver` returns a `WellKnownResult` ({ homeserverUrl, authConfig })
// — the fork reads `authConfig` to drive MAS/OIDC login. These precedence tests
// assert the resolved `homeserverUrl`.
describe("discoverHomeserver — precedence", () => {
  it("uses .well-known when a full MXID is supplied", async () => {
    mswServer.use(
      http.get("https://example.com/.well-known/matrix/client", () =>
        HttpResponse.json({ "m.homeserver": { base_url: "https://matrix.example.com" } }),
      ),
    );
    const result = await discoverHomeserver({
      mxid: "@alice:example.com",
      runtimeConfig: null,
      buildtimeUrl: "https://buildtime.example",
    });
    expect(result.homeserverUrl).toBe("https://matrix.example.com");
  });

  it("falls through to runtime /config.json when no MXID is supplied", async () => {
    const result = await discoverHomeserver({
      mxid: null,
      runtimeConfig: { homeserver_url: "https://runtime.example" },
      buildtimeUrl: "https://buildtime.example",
    });
    expect(result.homeserverUrl).toBe("https://runtime.example");
  });

  it("falls through to build-time URL when nothing else is set", async () => {
    const result = await discoverHomeserver({
      mxid: null,
      runtimeConfig: null,
      buildtimeUrl: "https://buildtime.example",
    });
    expect(result.homeserverUrl).toBe("https://buildtime.example");
  });

  it("throws when nothing resolves", async () => {
    await expect(
      discoverHomeserver({ mxid: null, runtimeConfig: null, buildtimeUrl: null }),
    ).rejects.toThrow(/homeserver/i);
  });

  it("MXID well-known overrides runtime and build-time", async () => {
    mswServer.use(
      http.get("https://example.com/.well-known/matrix/client", () =>
        HttpResponse.json({ "m.homeserver": { base_url: "https://wellknown.example" } }),
      ),
    );
    const result = await discoverHomeserver({
      mxid: "@alice:example.com",
      runtimeConfig: { homeserver_url: "https://runtime.example" },
      buildtimeUrl: "https://buildtime.example",
    });
    expect(result.homeserverUrl).toBe("https://wellknown.example");
  });

  it("falls through past .well-known on 404 to runtime/build-time", async () => {
    mswServer.use(
      http.get("https://example.com/.well-known/matrix/client", () =>
        HttpResponse.json({}, { status: 404 }),
      ),
    );
    const result = await discoverHomeserver({
      mxid: "@alice:example.com",
      runtimeConfig: { homeserver_url: "https://runtime.example" },
      buildtimeUrl: null,
    });
    expect(result.homeserverUrl).toBe("https://runtime.example");
  });
});
