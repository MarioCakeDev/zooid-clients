---
"@zooid/web": minor
---

Refresh MAS/OIDC sessions automatically. A token obtained through the MAS
authorization-code flow now keeps its `refresh_token`, and the client uses it
both proactively (shortly before `expires_in` elapses) and reactively (when a
request comes back `M_UNKNOWN_TOKEN`) — so an active session no longer drops to
the login screen when its short-lived access token ages out. Refreshed tokens
are persisted for the next reload, and a refresh that races a logout can no
longer resurrect the session.

The OIDC client id is no longer hardcoded: it is resolved from runtime
`oidc_client_id` in `/config.json`, falling back to the build-time
`VITE_OIDC_CLIENT_ID`. An unset id is surfaced as a configuration error on the
login screen instead of silently authorizing against a baked-in client.
