# Application-wide OAuth

CiteLoom has one active authentication mode: `local` or `oauth`.
Local mode uses CiteLoom usernames, passwords, server-side sessions, and session cookies.
OAuth mode replaces cookie authentication for the browser API and enables OAuth bearer tokens for MCP.
Workspace-bound MCP API keys are available in either browser authentication mode.
OAuth is optional, and existing installations start in local mode.

## Authentication modes

| Mode | Browser API | MCP | CiteLoom session cookies |
| --- | --- | --- | --- |
| `local` | Local session cookie | Workspace-bound MCP API key | Used normally |
| `oauth` | API-audience bearer token | MCP-audience bearer token or workspace-bound MCP API key | Ignored, expired when present, and never used for authorization |

Staging OAuth configuration does not change the active mode.
Cookie authentication continues until a linked global administrator completes the staged OAuth flow and activates the exact staged configuration version.
Activation changes the mode and revokes every existing local session in one database transaction.
Disabling OAuth changes the mode back to local and retains the OAuth configuration as a staged configuration for later use.
Returning to local mode never restores an old session or signs in a user automatically.

## Configuration

A global administrator manages OAuth under Security > Authentication.
CiteLoom stores the versioned configuration in PostgreSQL rather than process environment variables.
The administrator supplies the HTTPS issuer, browser public-client ID, browser authorization scopes, required API scopes, and required MCP scopes.

CiteLoom derives these identifiers from its configured public origin:

- Browser API resource: `${publicOrigin}/api`
- MCP resource: `${publicOrigin}/mcp`
- Browser callback: `${publicOrigin}/oauth/callback`
- Browser post-logout redirect: `${publicOrigin}/login`

The resource identifiers and redirect URIs are not separately entered or duplicated in configuration.
CiteLoom requires its configured public origin to use HTTPS before OAuth can be staged.
CiteLoom verifies the issuer's OpenID Connect discovery document and signing-key set before staging a configuration.
Concurrent changes use the stored settings version and reject stale writes.
The persisted host-recovery setting must be enabled before OAuth can be activated.
It cannot be disabled while OAuth is active.

The authorization server must register the exact derived resources and redirect URIs.
Its discovery and token endpoints must allow the CiteLoom browser origin through CORS because the browser public client exchanges authorization codes directly.

## Identity and workspace authorization

An access token identifies an external user by the verified `(issuer, subject)` pair.
A global administrator must explicitly link that pair to one existing CiteLoom user.
CiteLoom does not link users by email address, username, display name, or another mutable claim.

OAuth does not require an external organization or workspace claim.
There is no external-to-local workspace mapping in the active authorization path.
CiteLoom remains authoritative for users, global roles, workspaces, memberships, workspace roles, and source-library access.

The browser selects a local workspace with the internal `X-CiteLoom-Workspace-Id` request header, using the ID returned by CiteLoom's identity context.
An OAuth MCP client selects a workspace by its visible name with the `X-CiteLoom-Workspace-Name` request header.
An MCP API key is bound to the workspace that was selected when the key was generated and does not require a workspace selector.
These headers are untrusted selectors, not proof of access.
For every protected request, CiteLoom verifies the linked user, selected workspace, active membership, and applicable local authorization before constructing the request principal.

## Browser flow

The browser is an OAuth public client and uses Authorization Code with PKCE `S256`, an exact redirect URI, a random `state` value, and a top-level redirect.
It validates the authorization response `iss` parameter when present and requires it when the authorization-server metadata advertises `authorization_response_iss_parameter_supported`.
It never places an access token in a URL or stores a token in a cookie.
A centralized fetch adapter adds the API bearer token and selected local workspace to protected API requests.

Access, refresh, and ID tokens are stored in the current tab's `sessionStorage` and are removed on sign-out.
This allows a page reload and an OAuth-issuer replacement flow to complete without creating a CiteLoom authentication cookie, but same-origin malicious JavaScript could read those tokens.
CiteLoom serves its pinned browser dependencies locally and applies a Content Security Policy that blocks external and inline scripts.
The policy permits `unsafe-eval` because Alpine.js requires dynamic expression evaluation; no other browser dependency is allowed to evaluate code, and HTMX evaluation and script tags are disabled explicitly.
Deployments should also use short token lifetimes and refresh-token rotation or sender constraint where the provider supports it.

When the provider returns a refresh token, CiteLoom includes the API resource indicator in refresh requests and replaces rotated tokens.
If no usable token remains, the browser starts a new Authorization Code flow.
Provider logout uses the discovered end-session endpoint when available after CiteLoom removes its local token state.

## MCP

The modern MCP endpoint is available at `POST /mcp` for protocol version `2026-07-28` without an MCP protocol session.
The endpoint rejects legacy initialization and accepts either an OAuth MCP bearer token or a CiteLoom MCP API key.
OAuth tokens are validated against the distinct `${publicOrigin}/mcp` audience and require an explicit `X-CiteLoom-Workspace-Name` header.
API keys carry their local workspace binding and therefore require no workspace header, OAuth client registration, browser redirect, or interactive sign-in.
Both authentication methods reuse the same local principal and retrieval services as the browser API.

Global and workspace administrators generate API keys from Security > User accounts > Actions > Manage MCP API keys.
The selected user is the credential owner, while the administrator who generated or revoked the key is retained only for audit.
The cleartext key is shown once, and PostgreSQL stores only its SHA-256 digest.
Every API-key request rechecks that the key is unexpired and unrevoked, the owner is active, the bound workspace is active, the owner's workspace membership is enabled, and the requested scope is granted.
MCP API-key authentication does not change browser authentication: local mode still uses usernames and session cookies, while OAuth mode still replaces browser cookie authentication.

Protected-resource metadata is published at:

- `/.well-known/oauth-protected-resource/api`
- `/.well-known/oauth-protected-resource/mcp`

The MCP surface uses `citeloom.search` for the read-only `citeloom.search_sources` tool and `citeloom.answer` for the asynchronous `citeloom.ask_documents` tool, its task methods, and its saved thread and citation resources.
Tool and resource discovery is filtered by the MCP scopes granted to the OAuth token or API key.
The server advertises the draft `io.modelcontextprotocol/tasks` extension in `server/discover`.
Clients must declare that extension in the per-request capabilities for `citeloom.ask_documents`, `tasks/get`, `tasks/update`, and `tasks/cancel`.
The answer call returns a durable task handle immediately, and the client polls `tasks/get` for the completed `StreamedAnswer` and links to `citeloom://workspace/research/threads/{threadId}` and `citeloom://workspace/research/citations/{citationId}`.
The Task retention application setting determines the finite TTL published for each new task.
Each task keeps the retention window that applied when it was created, active work is not deleted, and expired completed, failed, or cancelled tasks are removed in bounded background batches.
The installed MCP SDK does not provide a 2026 runtime for the draft task flow, so CiteLoom keeps the server methods and host-client task requests in narrow adapters that can be replaced when official SDK support is available.
The adapter reuses CiteLoom's existing saved-answer pipeline and does not automatically replay claimed work after a worker interruption because replay could create a duplicate research turn.

## Host recovery

An OAuth-authenticated global administrator can switch the application back to local mode through the Security page while the authorization server is available.
If the authorization server is unavailable, a host operator can inspect the recovery state without changing it:

```sh
pnpm dev auth recover-local
```

The report reads only the database connection from CiteLoom's existing startup configuration.
It does not load application settings or contact the authorization server or an inference provider.

Apply recovery explicitly:

```sh
pnpm dev auth recover-local --apply
```

Recovery is available only when a global administrator enabled Host recovery under Security > Authentication before OAuth activation.
The apply operation locks the versioned authentication settings, switches `oauth` to `local`, retains the previous OAuth configuration as staged, increments the version, deletes every local session, and writes a `recovered` audit event in one database transaction.
It does not change usernames, passwords, memberships, or OAuth identity links.
Users then sign in normally with their existing CiteLoom username and password and receive a new bounded session.
Running the apply command again after a successful recovery is a no-op.
For the supplied container deployment, use the host-side commands in [Operations](operations.md#recover-local-authentication).

## Optional Logto deployment

The optional [`compose.logto.yml`](../compose.logto.yml) file follows Logto's database-seeding entrypoint and requires deployment-specific `LOGTO_*` values from [`.env.example`](../.env.example).
Those values configure the separate Logto service and are not CiteLoom's application OAuth settings.
The Compose stack does not terminate TLS, so expose Logto through a trusted HTTPS reverse proxy before using it as CiteLoom's issuer.

Start Logto independently from CiteLoom:

```sh
docker compose --env-file .env -f compose.logto.yml up -d --wait
```

Configure distinct API and MCP resources whose indicators exactly match the identifiers derived by CiteLoom.
Configure the browser as a public client with the exact callback and post-logout redirect URIs.
Pre-register each supported MCP host with its exact redirect URIs.
Create local CiteLoom users and memberships, then link each immutable Logto subject to the corresponding local user.
