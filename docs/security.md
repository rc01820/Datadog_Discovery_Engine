# Security

## Model

| Control | Implementation |
|---|---|
| Passwords | Argon2id (`argon2-cffi` defaults), 12–256 characters. Verification runs against a dummy hash for unknown users, so response timing doesn't reveal which usernames exist |
| Sessions | 48-byte random token in an **HttpOnly, SameSite=Strict** cookie (`ds_session`; `Secure` when `COOKIE_SECURE=true`). Only an HMAC-SHA256 of the token (keyed with `SESSION_SECRET`) is stored. Server-side expiry (default 8 h), sliding `last_seen` |
| CSRF | A per-session random token, returned at sign-in and in the `ds_csrf` cookie, must be echoed in `X-CSRF-Token` on every non-GET request (constant-time compare). Plus SameSite=Strict |
| Brute force | 5 failures per username or 20 per IP → 5-minute lock (Redis counters). Failures are audited |
| Authorization | Role → permission set, checked by a FastAPI dependency on every endpoint. You can't remove your own admin rights, and at least one enabled administrator must remain |
| Datadog keys | Stored encrypted with Fernet (AES-128-CBC + HMAC), with the key derived from `DATA_ENCRYPTION_KEY`. Never returned to the browser (masked to the last 4 characters). Never logged |
| Outbound | Only to `api.<site>` for the allow-listed Datadog sites. Deep links are built only from a validated site and URL-encoded identifiers |
| Injection | All SQL is parameterised. The query language compiles to parameters. Dynamic column and order fragments come from fixed allow-lists |
| Regex DoS | Regex length ≤ 200, validated before execution, plus a 5 s per-search statement timeout (15 s for export) |
| Query limits | 500 characters, 30 terms, nesting depth 12 |
| Bulk lookup limits | 200,000 characters of input, 2,000 unique items, 20 matches per item, 30 s statement timeout. All lookups use parameterised exact or `inet` comparisons (no regex). CSV export needs the `export` permission. Every run is recorded in the search audit, and every export in the audit log |
| Exports | CSV formula-injection protection (values starting with `= + - @` and tab/CR are prefixed with `'`). Every export is audited |
| Headers (nginx) | `Content-Security-Policy` (`default-src 'self'`; no inline scripts; `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `server_tokens off` |
| Headers (api) | `no-store` on API responses, plus nosniff, DENY and no-referrer |
| Containers | api/worker run as UID 10001, and web as the unprivileged nginx user with a read-only root filesystem. Only the web port is published, and db/redis are internal |
| History archives | Admin-only list and download, with strict filename validation (no path traversal). Downloads and roll-offs are audited. Archive files hold change history (names, IPs, tags) in plain gzip CSV, so protect the archive folder like a backup |
| Audit | Sign-ins (and failures), user, role and settings changes, integration changes (keys shown as `updated`), syncs, exports, and every search query, each with the client IP |

## Important limitation: shared Datadog visibility

The app reads Datadog with **one** API/application key pair. Every signed-in user can search everything that key can see.
Local roles control *features* (export, admin, shared searches), not *which Datadog resources* a user sees.
Only give accounts to people who may see the whole organization, or create a scoped key that can only read what everyone may see.

## Production hardening checklist

- [ ] Put TLS in front ([installation.md](installation.md#tls--reverse-proxy)), set `COOKIE_SECURE=true`, and publish the app on `127.0.0.1` only.
- [ ] Restrict network access (VPN, firewall, or allow-listed source IPs on the proxy).
- [ ] Generate unique secrets with `scripts/init-env.sh`, keep `.env` at mode `600` or use `*_FILE` Docker secrets, and back up `.env` separately from database dumps.
- [ ] Use a **read-only service account** application key with only the scopes you need ([datadog-sources.md](datadog-sources.md#permissions)), and rotate keys regularly.
- [ ] Change the bootstrap admin password, create named accounts, and keep the number of Administrators small.
- [ ] Turn off `DEMO_DATA` for production instances, or leave auto-purge on.
- [ ] Review **Admin › Audit Log** regularly, and set retention to match your policy.
- [ ] Encrypt backups at rest. Database dumps contain the Datadog keys (still encrypted), user password hashes and the audit log.
- [ ] Keep base images updated: `docker compose build --pull && docker compose up -d`.
- [ ] Monitor `/readyz` and the worker heartbeat.

## Not yet implemented

- OIDC / SAML single sign-on and MFA. Local accounts only.
- Per-user Datadog permission mapping.
- Built-in TLS termination.
- Password complexity rules beyond the 12-character minimum, and password expiry.

## Reporting a vulnerability

Contact the maintainers of your deployment privately. Don't open public issues for security problems.
