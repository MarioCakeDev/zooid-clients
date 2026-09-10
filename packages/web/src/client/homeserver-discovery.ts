import type { RuntimeConfig } from "./runtime-config";

export interface DiscoverInput {
  mxid: string | null;
  runtimeConfig: RuntimeConfig | null;
  buildtimeUrl: string | null;
}

export interface WellKnownResult {
  homeserverUrl: string;
  authConfig?: {
    issuer: string;
    account?: string;
  };
}

// Precedence (highest → lowest):
//   1. user-typed MXID → .well-known/matrix/client on the MXID's domain
//   2. runtime /config.json
//   3. build-time VITE_MATRIX_HOMESERVER_URL
export async function discoverHomeserver(input: DiscoverInput): Promise<WellKnownResult> {
  if (input.mxid) {
    const domain = mxidDomain(input.mxid);
    const wellKnown = await fetchWellKnown(domain);
    if (wellKnown) return wellKnown;
  }
  if (input.runtimeConfig?.homeserver_url)
    return { homeserverUrl: input.runtimeConfig.homeserver_url };
  if (input.buildtimeUrl) return { homeserverUrl: input.buildtimeUrl };
  throw new Error("No homeserver URL could be resolved");
}

function mxidDomain(mxid: string): string {
  const colon = mxid.indexOf(":");
  if (colon === -1) throw new Error(`Invalid MXID: ${mxid}`);
  return mxid.slice(colon + 1);
}

async function fetchWellKnown(domain: string): Promise<WellKnownResult | null> {
  try {
    const res = await fetch(`https://${domain}/.well-known/matrix/client`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    const homeserver = json["m.homeserver"] as
      | { base_url?: string }
      | undefined;
    const auth = json["org.matrix.msc2965.authentication"] as
      | { issuer?: string; account?: string }
      | undefined;
    const baseUrl = homeserver?.base_url;
    if (!baseUrl) return null;
    return {
      homeserverUrl: baseUrl,
      authConfig: auth?.issuer ? { issuer: auth.issuer, account: auth.account } : undefined,
    };
  } catch {
    return null;
  }
}
