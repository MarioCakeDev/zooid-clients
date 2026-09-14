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
