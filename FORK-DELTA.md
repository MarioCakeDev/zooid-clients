# Fork delta vs upstream

> **AI-only fork.** This repository is maintained **exclusively by the Zooid AI
> agent workforce** (`MarioCakeDev/MatrixAgent`). Changes are AI-generated, are
> not held to upstream review standards, and may be experimental or broken; this
> fork is not intended for humans, general use, or redistribution. **Do not
> depend on this fork.**

This branch (`merge/upstream-0.16.0`) merges `upstream/main` @ `2b8a626`
(`@zooid/web` **0.16.0**) into our fork `main`, whose merge base was `526d6175`
(`@zooid/web` **0.12.0**); the fork's previous revision was `a068897`.

Everything below is a **fork-only** difference that survives the merge. Upstream
0.13–0.16's own work (thread links/quotes/sharing, agent question cards,
failed-send Retry/Delete, thread gap markers + load-more-oldest, empty-turn
indicator, cross-workstation workforce roster, Storybook dark theme) is
upstream's and is not listed here.

Regenerate with `git log --oneline upstream/main..HEAD`.

---

## 1. MAS/OIDC authentication (our headline feature)

The fork logs in through the homeserver's MAS/OIDC provider rather than only a
raw homeserver URL: `.well-known/matrix/client` discovery of
`org.matrix.msc2965.authentication`, a registered **public OIDC client id**
(runtime `config.json` `oidc_client_id`, else build-time
`VITE_OIDC_CLIENT_ID` — no hardcoded default), **PKCE** with the Matrix OIDC
scopes, the **authorization-code token exchange**, and **session auto-refresh**
before the access token expires.

Modules:

- `packages/web/src/client/homeserver-discovery.ts` — returns a
  `WellKnownResult` (`homeserverUrl` plus optional `authConfig`), and still
  probes well-known when falling back to the runtime/build-time URL so MAS is
  discovered on that domain too.
- `packages/web/src/client/runtime-config.ts` — `oidc_client_id` and
  `resolveOidcClientId` (runtime wins over build-time; blank counts as absent).
- `packages/web/src/client/login.ts` (+ `.test.ts`) — OIDC client id, PKCE,
  Matrix OIDC scopes, and the auth-code exchange.
- `packages/web/src/client/peg.ts` (+ `.test.ts`) — session auto-refresh.
- `packages/web/src/components/auth/auth-callback.tsx`,
  `packages/web/src/components/auth/login.tsx`, `packages/web/src/app.tsx`,
  `packages/web/src/main.tsx` — plumbing (`authConfig` on `AppConfig` and
  `DiscoverInput`).

## 2. Workforce space default `zooid`

Upstream reads the initial workforce space from runtime `config.json`
(`workforce_space`) and removed the build-time `VITE_WORKFORCE_SPACE` fallback.
The fork keeps the daemon's space alias as the **default**:
`DEFAULT_WORKFORCE_SPACE = "zooid"` (upstream `"dev"`) in
`packages/web/src/client/runtime-config.ts`, consumed as
`workforceSpace ?? DEFAULT_WORKFORCE_SPACE` in
`packages/web/src/components/structures/logged-in-view.tsx`.

## 3. Trailing-slash stripping

`discoverHomeserver` strips trailing slashes from a discovered `base_url` and
from the OIDC `issuer` (`replace(/\/+$/, "")`), so a configured URL with a
trailing slash does not produce doubled-slash endpoints.

## 4. `.github/workflows/` — upstream's CI is not carried

Upstream added `.github/workflows/ci.yml`. The fork's CI is external
(built/deployed via Coolify), and carrying a GitHub Actions workflow would need
a `workflow`-scoped token to push, so this merge **does not add it**. Re-apply
the same exclusion on future upstream merges — the same policy as the
`MarioCakeDev/zooid` fork.

## 5. Merge-time note — stale discovery test corrected

`packages/web/src/client/homeserver-discovery.test.ts` was never updated when the
fork changed `discoverHomeserver` to return a `WellKnownResult` instead of a bare
string (`990ca6f`), so its five precedence tests had been failing on fork `main`
before this merge (verified against `origin/main`). This merge corrects the
assertions to the object contract; the number of tests is unchanged.
