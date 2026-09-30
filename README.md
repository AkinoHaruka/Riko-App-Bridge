# Riko App API Bridge for DSH

`@riko/riko-app-api` is a standalone DeepSeek Harness Host plugin for the Riko Android app. It owns `/riko-app-api/v1`, account authentication, per-account session ownership, and account-scoped custom model providers. It does not modify the Riko Memory adapter.

## Install

From this repository checkout:

```text
corepack pnpm dsh plugin --profile <profile> add .
```

The profile patch keeps the plugin disabled until all required environment variables are configured:

| Variable | Purpose |
|---|---|
| `RIKO_APP_API_TOKEN_FILE` | Server-only administrator bearer token file. Never put it in the app. |
| `RIKO_APP_SESSION_REGISTRY_FILE` | Persistent account-to-DSH-session ownership registry. |
| `RIKO_APP_ACCOUNT_STORE_FILE` | Persistent account records, scrypt password hashes, and hashed access tokens. |
| `RIKO_APP_ALLOWED_PROVIDER_HOSTS` | Optional comma-separated extra DNS hosts that account-owned custom providers may use. Built-in public provider hosts are allowed by default. |

Store all three files on persistent storage outside the plugin package. The plugin writes them atomically and creates new files with owner-only permissions where supported.

## Accounts and access

Registration is open. Usernames accept Unicode text, spaces, and punctuation; leading/trailing whitespace is trimmed and names are normalized to lowercase. A username must contain 1–128 Unicode characters and cannot contain control characters. Passwords must contain at least 10 characters. Passwords are stored as scrypt hashes; opaque bearer tokens are returned once, stored by Android in Android Keystore, and stored on the server only as SHA-256 hashes. Registration and login have per-address and per-username throttles.

Every session created through an account is owned by that account. Session listing, history, streaming, model selection, prompt submission, and cancellation verify that ownership. Old sessions from the previous single-token bridge remain in an admin-only legacy bucket and are never assigned to the first registrant. The server-only administrator token remains available for operator access and global DSH configuration.

App users can add custom API providers. The bridge stores them in DSH under an account-specific provider ID and credential reference, filters other accounts' providers from the app catalog, and rejects cross-account provider selection. Account-owned providers require HTTPS, use the built-in public-provider host allowlist, and cannot target IP literals, arbitrary hosts, or nonstandard ports. An administrator can add approved DNS host names through `RIKO_APP_ALLOWED_PROVIDER_HOSTS`. Normal accounts cannot read or change global provider credentials/settings. Model discovery is admin-only because it makes a server-side request to a caller-provided URL; users can enter model IDs manually. The DSH listener must remain behind the existing HTTPS reverse proxy and bound to loopback.

The Riko Memory adapter is a separate service boundary. Do not enable it for public app accounts until its memory principal is mapped to the authenticated app account; a single static memory token would make accounts share memories.

## API surface

- Public: `GET /health`, `POST /auth/register`, `POST /auth/login`.
- Authenticated account: `GET /auth/me`, `POST /auth/logout`, model catalog, account-scoped custom model providers, and owned session operations.
- Server administrator token: account-independent DSH model settings and legacy/session operator access.

Provider credential values and account password hashes are never returned by the API. Responses use `Cache-Control: no-store`.

## Development

```text
npm install
npm test
```

The package targets DSH `0.2.0-rc.1` APIs. Tests use local service doubles and synthetic accounts; they do not prove production deployment or external model connectivity.
