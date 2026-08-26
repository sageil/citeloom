# Security and OAuth

CiteLoom uses one browser authentication mode at a time: `local` or `oauth`.
Only a global administrator can configure OAuth or manage OAuth user links.
User-bound MCP API keys are available in both modes.

This reference describes security behavior and exact configuration rules.
The [OAuth installation guide](https://sammyageil.com/citeloom/installation/oauth/) provides the complete setup procedure.

## Authentication modes

| Mode | Browser API | MCP | CiteLoom session cookies |
| --- | --- | --- | --- |
| `local` | Local session cookie | User-bound MCP API key | Used normally |
| `oauth` | API-audience bearer token | MCP-audience bearer token or user-bound MCP API key | Ignored and removed when present |

### Authentication mode transition

1. A global administrator stages the OAuth configuration.
2. CiteLoom keeps local cookie authentication active during staging.
3. A linked global administrator completes the staged OAuth flow.
4. CiteLoom activates the exact staged configuration version.
5. CiteLoom changes the mode to `oauth` and revokes all local sessions in one database transaction.

When a global administrator disables OAuth, CiteLoom changes the mode to `local`.
CiteLoom keeps the OAuth configuration as a staged configuration.
CiteLoom does not restore old sessions or sign in a user automatically.

OAuth is optional.
New installations start in `local` mode.

## Configuration

Open **Security > Authentication** to manage OAuth.
Only a global administrator can open this page or use its API routes.

### Values that you enter

- HTTPS authorization server issuer
- Browser public-client ID
- Browser authorization scopes
- Browser API scopes
- MCP scopes

CiteLoom stores the versioned configuration in PostgreSQL.
It does not read this configuration from process environment variables.

### Values that CiteLoom derives

CiteLoom derives these values from the first entry in its configured **Public origins** list:

| Purpose | Value |
| --- | --- |
| Browser API resource | `${publicOrigin}/api` |
| MCP resource | `${publicOrigin}/mcp` |
| Browser callback | `${publicOrigin}/oauth/callback` |
| Browser post-logout redirect | `${publicOrigin}/login` |

Do not enter these values separately in CiteLoom.
Register the exact resource identifiers and redirect URIs in the authorization server.

### Checks before staging and activation

CiteLoom checks these conditions:

- The first public origin uses HTTPS.
- The issuer has a valid OpenID Connect discovery document.
- The issuer has a valid signing-key set.
- A concurrent change does not use an old settings version.
- Host recovery is enabled before OAuth activation.

You cannot disable host recovery while OAuth is active.
The discovery and token endpoints must allow the CiteLoom browser origin through CORS.
The browser public client exchanges authorization codes directly with the token endpoint.

## Identity and workspace authorization

Only a global administrator can view, add, or remove OAuth user links.
The API returns HTTP 403 when another user tries to manage these links.

### Link an external identity

An access token identifies an external user with a verified `(issuer, subject)` pair.
A global administrator links this pair to one existing CiteLoom user.

CiteLoom does not link a user with these mutable values:

- Email address
- Username
- Display name
- External organization or workspace claim

### Keep authorization in CiteLoom

| System | What it controls |
| --- | --- |
| Authorization server | External identity and granted OAuth scopes |
| CiteLoom | Users, global roles, workspaces, memberships, workspace roles, and source-library access |

CiteLoom does not use an external-to-local workspace mapping in the active authorization path.

### Resolve workspace access

| Client | User identity | Workspace access |
| --- | --- | --- |
| Browser with OAuth | Linked CiteLoom user | `X-CiteLoom-Workspace-Id` with the ID from the identity context |
| MCP with OAuth | Linked CiteLoom user | All active workspaces where the user has an enabled membership |
| MCP with an API key | CiteLoom user who owns the key | All active workspaces where the owner has an enabled membership |

The MCP client uses one `${publicOrigin}/mcp` connection.
It does not send a workspace selector.
Search performs one retrieval over the combined document set available through all accessible workspaces.
Ask performs one retrieval and creates one answer over the same combined document set.
The document set includes shared libraries granted to at least one accessible workspace.

For each protected request, CiteLoom checks:

- The linked user or API-key owner is active.
- Each returned workspace is active.
- The user has an enabled membership in each returned workspace.
- The user has the applicable local authorization in each returned workspace.

## Browser flow

### Sign in

The browser is an OAuth public client.
It uses Authorization Code with PKCE `S256`.

The flow uses:

- An exact redirect URI
- A random `state` value
- A top-level browser redirect
- The authorization response `iss` parameter when it is present

The browser requires the `iss` parameter when the authorization server metadata advertises `authorization_response_iss_parameter_supported`.
A central fetch adapter adds the API bearer token and the selected local workspace to protected API requests.

### Store and refresh tokens

- The current browser tab stores access, refresh, and ID tokens in `sessionStorage`.
- Sign-out removes these tokens.
- CiteLoom does not put an access token in a URL or cookie.
- A page reload can use the tokens in the current tab.
- An OAuth issuer replacement flow can complete without a CiteLoom authentication cookie.
- A refresh request includes the Browser API resource indicator.
- CiteLoom stores each rotated replacement token.
- The browser starts a new Authorization Code flow when no usable token remains.
- Provider logout uses the discovered end-session endpoint when that endpoint is available.

### Protect browser tokens

Malicious same-origin JavaScript can read tokens from `sessionStorage`.
CiteLoom uses these controls to reduce this risk:

- It serves pinned browser dependencies from the CiteLoom server.
- Its Content Security Policy blocks external scripts and inline scripts.
- It disables HTMX evaluation and script tags.
- It permits `unsafe-eval` because Alpine.js uses dynamic expression evaluation.
- No other browser dependency can evaluate code.

Use short token lifetimes.
Use refresh-token rotation or sender-constrained tokens when the authorization server supports them.

## MCP

### Endpoint behavior

| Request | Result |
| --- | --- |
| Unauthenticated `GET /mcp` while OAuth is active | OAuth discovery challenge |
| Authenticated `GET /mcp` | HTTP 405 with `Allow: POST` |
| `POST /mcp` | MCP protocol version `2026-07-28` without an MCP protocol session |

The endpoint rejects legacy initialization.

### Authentication choices

| Method | Browser redirect | OAuth client registration | Server URL |
| --- | --- | --- | --- |
| OAuth MCP bearer token | Yes | Yes | `${publicOrigin}/mcp` |
| CiteLoom MCP API key | No | No | `${publicOrigin}/mcp` |

CiteLoom validates OAuth tokens against the `${publicOrigin}/mcp` audience.
Both methods create the same type of local principal and use the same retrieval services as the browser API.
MCP API-key authentication does not change the browser authentication mode.

### Manage MCP API keys

- A global administrator can generate keys for any active user.
- A workspace administrator can generate keys for active users in the workspace that the administrator manages.
- The selected user owns the key.
- CiteLoom records the administrator who generated or revoked the key for audit.
- CiteLoom shows the cleartext key one time.
- PostgreSQL stores only the SHA-256 digest.

For each API-key request, CiteLoom checks:

- The key is not expired or revoked.
- The owner is active.
- Each returned workspace is active.
- The owner has an enabled membership in each returned workspace.
- The key grants the requested scope.

### Discover OAuth resources

CiteLoom publishes protected-resource metadata at these paths:

- `/.well-known/oauth-protected-resource/api`
- `/.well-known/oauth-protected-resource/mcp`

### MCP scopes

| Scope | Access |
| --- | --- |
| `citeloom.search` | The read-only `citeloom.search_sources` tool |
| `citeloom.answer` | The `citeloom.ask_documents`, `citeloom.get_answer`, and `citeloom.cancel_answer` tools and saved thread and citation resources |

CiteLoom filters tool, prompt, and resource discovery by the scopes on the OAuth token or API key.

### Answer workflow

`citeloom.search_sources` performs one search over the combined authorized document set and returns one result.
`citeloom.ask_documents` starts one durable answer task over the combined authorized document set and returns a `taskId`, `pollIntervalMs`, and `expiresAt`.
The client waits for `pollIntervalMs`, then calls `citeloom.get_answer` until the status is `completed`, `failed`, or `cancelled`.
A completed result contains one cited answer.
`citeloom.cancel_answer` asks CiteLoom to stop active work.
The client calls `citeloom.get_answer` after cancellation to confirm the final state.

CiteLoom does not send a `requestState` object to the client.
It stores answer-task state in PostgreSQL and returns an opaque `taskId`.
The answer tools do not return `input_required` or pause for more client input.
The client uses the `taskId` to read the stored state and final answer.
The task owner includes the authenticated issuer, subject, client ID, and CiteLoom user.
CiteLoom checks that owner before it reads or cancels a task.
CiteLoom does not return a completed combined answer after the user loses access to one of the workspaces used for that answer.

## Host recovery

An OAuth-authenticated global administrator can return CiteLoom to local mode from the Security page.
If the authorization server is unavailable, a host operator can use the recovery command.

Recovery is available only when a global administrator enabled **Host recovery** before OAuth activation.
The operation changes the authentication mode, stages the previous OAuth configuration, increments the settings version, deletes local sessions, and writes an audit event.
These changes occur in one database transaction.

Recovery does not change usernames, passwords, memberships, or OAuth identity links.
A second apply command makes no changes after a successful recovery.

The [local-authentication recovery procedure](operations.md#recover-local-authentication) provides the source and container commands.

## Logto compatibility

The optional [`compose.logto.yml`](../compose.logto.yml) file starts a separate Logto service and database.
Logto is one compatible authorization-server example and is not a CiteLoom dependency.
The Compose file uses the deployment-specific `LOGTO_*` values in [`.env.example`](../.env.example).
These values do not configure CiteLoom OAuth.

The [OAuth installation guide](https://sammyageil.com/citeloom/installation/oauth/) provides the complete Logto setup and upgrade procedure.
