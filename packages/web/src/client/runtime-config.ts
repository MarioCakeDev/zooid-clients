export interface RuntimeConfig {
  homeserver_url?: string;
  default_idp_label?: string;
  global_search?: boolean;
  push_gateway_url?: string;
  vapid_public_key?: string;
  /** Public OIDC client id registered with MAS for this deployment. */
  oidc_client_id?: string;
}

/**
 * Resolve the OIDC client id this deployment authenticates with: runtime
 * `/config.json` wins, then the build-time `VITE_OIDC_CLIENT_ID`. There is no
 * baked-in default — the id is deployment-specific (it is registered with the
 * homeserver's MAS), so an unset value is a configuration error, not a value
 * worth guessing.
 */
export function resolveOidcClientId(opts: {
  runtime?: string;
  buildtime?: string;
}): string | null {
  const runtime = opts.runtime?.trim();
  if (runtime) return runtime;
  const buildtime = opts.buildtime?.trim();
  return buildtime ? buildtime : null;
}

export async function loadRuntimeConfig(): Promise<RuntimeConfig | null> {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as Partial<RuntimeConfig> & Record<string, unknown>;
    const out: RuntimeConfig = {};
    if (typeof json.homeserver_url === "string") out.homeserver_url = json.homeserver_url;
    if (typeof json.default_idp_label === "string") out.default_idp_label = json.default_idp_label;
    if (typeof json.global_search === "boolean") out.global_search = json.global_search;
    if (typeof json.push_gateway_url === "string") out.push_gateway_url = json.push_gateway_url;
    if (typeof json.vapid_public_key === "string") out.vapid_public_key = json.vapid_public_key;
    if (typeof json.oidc_client_id === "string") out.oidc_client_id = json.oidc_client_id;
    return out;
  } catch {
    return null;
  }
}
