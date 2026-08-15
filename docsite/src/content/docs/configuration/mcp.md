---
title: Configure MCP
description: Connect an MCP host to CiteLoom with OAuth or a user-bound API key, then use its search and cited-answer capabilities.
---

CiteLoom serves MCP at `https://citeloom.example/mcp` over Streamable HTTP.
Replace `https://citeloom.example` with the public origin of your CiteLoom installation.
CiteLoom accepts only [MCP protocol `2026-07-28`](https://modelcontextprotocol.io/specification/2026-07-28).

## Capabilities exposed to the model

The LLM receives only the capabilities allowed by the current OAuth token or API key.

| Scope | Name | Type | Behavior |
| --- | --- | --- | --- |
| Any authenticated request | `citeloom://workspace/context` | Resource | Lets the host provide the authenticated CiteLoom user and selected workspace to the model. |
| `citeloom.search` | `citeloom.search_sources` | Tool | Lets the model retrieve exact keyword matches and optional semantic matches without creating a research turn. |
| `citeloom.search` | `citeloom.search_workspace` | Prompt | Instructs the model to search while preserving document and passage evidence metadata. |
| `citeloom.answer` | `citeloom.ask_documents` | Tool | Lets the model request a durable cited answer. |
| `citeloom.answer` | `citeloom.answer_with_citations` | Prompt | Instructs the model to request and present a durable cited answer. |
| `citeloom.answer` | `citeloom://workspace/research/threads/{threadId}` | Resource template | Lets the host provide a saved research thread to the model. |
| `citeloom.answer` | `citeloom://workspace/research/citations/{citationId}` | Resource template | Lets the host provide immutable citation evidence to the model. |

The model selects tools and supplies their arguments.
The MCP host handles discovery, authentication, resource retrieval, and task polling, then returns the resulting content to the model.
When `citeloom.answer` is granted, `server/discover` also advertises the `io.modelcontextprotocol/tasks` extension.
The MCP host must advertise the same extension in each answer or task request.

## Connect with OAuth

Use OAuth when the MCP host acts for an interactive CiteLoom user.

### Configure CiteLoom and the authorization server

1. Set CiteLoom's public origin to an HTTPS origin and activate OAuth under Security > Authentication.
2. Configure the authorization server with the MCP resource identifier `https://citeloom.example/mcp`.
3. Allow the MCP resource to grant `citeloom.search`, `citeloom.answer`, or both.
4. Configure a public MCP client with Authorization Code and PKCE, using the registration method supported by the MCP host and authorization server.
5. Link the OAuth subject to an active CiteLoom user who has enabled membership in the workspace the host will select.

The MCP client's redirect URI is configured in the authorization server, not in CiteLoom.
The [OAuth guide](../../installation/oauth/) defines the compatibility contract and includes a Logto example.

### Configure the MCP host

Provide these values through the host's MCP configuration:

| Setting | Value |
| --- | --- |
| Transport | Streamable HTTP |
| Server URL | `https://citeloom.example/mcp` |
| OAuth resource | `https://citeloom.example/mcp` |
| OAuth client | The configured public-client ID, or the registration method supported by the MCP host and authorization server. |
| Scopes | `citeloom.search`, `citeloom.answer`, or both. |
| MCP request header | `X-CiteLoom-Workspace-Name: <visible workspace name>` |

Send `X-CiteLoom-Workspace-Name` only to the CiteLoom MCP endpoint.
Do not send it to the authorization server.

### OAuth discovery and validation

CiteLoom publishes MCP protected-resource metadata at:

```text
https://citeloom.example/.well-known/oauth-protected-resource/mcp
```

That response identifies the authorization server, MCP resource, supported scopes, CiteLoom MCP name, and this documentation.
An unauthenticated `GET /mcp` request returns HTTP 401 with a `WWW-Authenticate` header that points to this metadata.
An authenticated `GET /mcp` request returns HTTP 405 with `Allow: POST` because CiteLoom accepts MCP protocol messages through `POST /mcp`.
A rejected OAuth bearer token returns a `WWW-Authenticate` challenge containing the protected-resource metadata URL.

The OAuth access token must have:

- the configured authorization-server issuer;
- the exact `https://citeloom.example/mcp` audience;
- an unexpired signature verifiable through the issuer's JWKS;
- a client identifier;
- the scope that the requested CiteLoom operation needs.

CiteLoom then resolves the token subject and `X-CiteLoom-Workspace-Name` to an active local user, active workspace, and enabled workspace membership.

### Verify OAuth access

1. Reconnect the MCP server and complete the host's browser authorization flow.
2. Read `citeloom://workspace/context`.
3. Confirm that `username`, `workspaceId`, and `workspaceName` identify the intended CiteLoom account and workspace.
4. List tools and confirm that the granted scopes expose the expected CiteLoom tools.

## Connect with an MCP API key

Use an MCP API key for automation or when the MCP host accepts a fixed bearer secret.
This workflow works while CiteLoom browser authentication is in either local or OAuth mode.

### Create the key

1. Open Security > User accounts.
2. Open the target user's Actions menu and select Manage MCP API keys.
3. Set the optional label, expiry, and the `citeloom.search` or `citeloom.answer` scopes that the key needs.
4. Copy the cleartext key when CiteLoom displays it.

Global administrators can manage keys for any active user.
Workspace administrators can manage keys for active users in their selected workspace.

CiteLoom displays the key once and stores only its SHA-256 digest.
Store the key in the MCP host's secret store.

### Configure the MCP host

Use the same Streamable HTTP server URL and send the key as a bearer credential:

```http
Authorization: Bearer <CiteLoom MCP API key>
```

Do not configure an OAuth client, OAuth resource, or callback for an API key.
Send `X-CiteLoom-Workspace-Name: <visible workspace name>` with every CiteLoom MCP request.
The key identifies one user and can select any active workspace where that user has enabled membership.

For every request, CiteLoom rechecks the key digest, expiry, revocation state, owner state, workspace state, membership state, and scope.

### Verify API-key access

1. Reconnect the MCP server.
2. Read `citeloom://workspace/context`.
3. Confirm that the returned user and workspace match the key's owner and selected workspace.
4. List tools and confirm that the key's scopes expose only the intended CiteLoom tools.

## Diagnose rejected requests

| Result | Meaning | Corrective action |
| --- | --- | --- |
| HTTP 400 `invalid_request` | The workspace header is missing, repeated, or invalid. | Send one `X-CiteLoom-Workspace-Name` value containing the visible workspace name on CiteLoom MCP requests. |
| HTTP 401 `invalid_token` | The OAuth token or API key is absent, invalid, expired, or revoked. | Reauthorize OAuth or replace the API key, then reconnect. |
| HTTP 403 `insufficient_scope` | The credential does not grant the scope that the tool, task method, or resource needs. | Grant `citeloom.search` or `citeloom.answer` as reported by the challenge. |
| HTTP 403 `access_denied` | The OAuth identity cannot access the selected local workspace. | Check the subject link, user state, workspace state, membership, and visible workspace name. |
| JSON-RPC missing-capability error | The host called `citeloom.ask_documents` or a task method without declaring the Tasks extension. | Enable `io.modelcontextprotocol/tasks` in the host or use `citeloom.search_sources` only. |
| HTTP 400 protocol mismatch | The host used a protocol other than `2026-07-28`. | Configure or update the host to use MCP `2026-07-28`. |

The [OAuth and MCP reference](../../reference/oauth/#mcp) documents the complete server-side authentication and task-retention behavior.
