---
title: Connect an MCP client
description: Use CiteLoom MCP through an interactive OAuth flow or a workspace-bound API key.
---

CiteLoom exposes its modern MCP endpoint at `POST /mcp` and supports two authentication workflows.
Both use the same local users, workspace memberships, authorization checks, retrieval, answers, threads, and citations.

| Workflow | Best for | Workspace selection | Browser interaction |
| --- | --- | --- | --- |
| OAuth | Interactive desktop or developer clients acting as a person. | The client sends the visible workspace name. | Required for Authorization Code with PKCE. |
| MCP API key | Automation and clients where a workspace-scoped credential is preferable. | The key is permanently bound to its selected workspace. | Not required. |

The repository includes a smoke client that exercises protocol discovery, tool discovery, source search, asynchronous answer creation and polling, and every linked thread or citation resource returned by the answer.

## OAuth workflow

### 1. Register the native client

Register a public native application with the OAuth provider used by CiteLoom.
Its redirect URI must exactly match the loopback callback supplied to the client.

For the example below, register:

```text
http://127.0.0.1:6276/oauth/callback
```

Allow that application to request `citeloom.search` and `citeloom.answer` for the CiteLoom MCP resource.
For an installation whose public origin is `https://citeloom.example`, the resource indicator is `https://citeloom.example/mcp`.

The external OAuth subject must already be linked to an active CiteLoom user, and that user must have active membership in the requested workspace.

### 2. Run the client

```bash
pnpm mcp:client -- \
  --server-url https://citeloom.example/mcp \
  --client-id '<native OAuth App ID>' \
  --callback-url http://127.0.0.1:6276/oauth/callback \
  --workspace '<CiteLoom workspace name>' \
  --question 'What policy is documented in this workspace?'
```

Open the authorization URL printed by the command, sign in, and approve access.
The client keeps OAuth tokens only in process memory and listens only on the configured loopback callback address.

OAuth access tokens must target the distinct MCP audience and grant the scope required by each operation.
The client sends `X-CiteLoom-Workspace-Name` on CiteLoom MCP requests; it does not send that selector to the authorization server.

## API-key workflow

### 1. Generate a workspace-bound key

In CiteLoom, open Security > User accounts, choose the target user's Actions menu, and select Manage MCP API keys.
Select the intended workspace and grant only the operations the client needs:

| Permission | Scope | MCP surface |
| --- | --- | --- |
| Search documents | `citeloom.search` | `citeloom.search_sources` |
| Ask documents | `citeloom.answer` | `citeloom.ask_documents`, task methods, saved thread resources, and citation resources. |

The cleartext key is shown once.
CiteLoom stores only its SHA-256 digest and rechecks the key, owner, workspace, membership, expiry, revocation, and scopes for every request.

### 2. Save the key without exposing it in process arguments

```bash
umask 077
read -r -s CITELOOM_MCP_KEY
printf '%s\n' "$CITELOOM_MCP_KEY" > ./citeloom-mcp.key
unset CITELOOM_MCP_KEY
```

Paste the key at the hidden prompt and press Enter.

### 3. Run the client

```bash
pnpm mcp:client -- \
  --server-url https://citeloom.example/mcp \
  --api-key-file ./citeloom-mcp.key \
  --question 'What policy is documented in this workspace?'
```

Do not pass `--workspace`, `--client-id`, or `--callback-url` with `--api-key-file`.
The key already carries its local workspace binding and needs no OAuth registration, redirect, or interactive sign-in.

## Private local certificate authority

The repository Compose deployment stores Caddy's public root certificate at `data/caddy/caddy/pki/authorities/local/root.crt`.
When Node does not already trust that private certificate authority, add this option to either workflow:

```text
--ca-file data/caddy/caddy/pki/authorities/local/root.crt
```

The client adds that certificate only to its own process while retaining normal certificate and hostname verification.
Do not pass `--ca-file` when the deployment uses a publicly trusted certificate.

## Authorization failures

Check these boundaries in order:

1. Confirm the server URL includes `/mcp` and uses HTTPS, except for loopback-only testing.
2. For OAuth, confirm the token audience is the MCP resource, the requested scopes are granted, and the workspace name exactly identifies an accessible local workspace.
3. For an API key, confirm it has not expired or been revoked and that its owner and bound workspace membership remain active.
4. Confirm the credential grants `citeloom.search` for source search and `citeloom.answer` for asynchronous answers and saved answer resources.
5. Run `pnpm mcp:client -- --help` to check timeout, polling, callback, and private-CA options.

The [complete OAuth and MCP reference](../../reference/oauth/#mcp) documents protected-resource metadata, protocol versioning, task retention, and extension behavior.
