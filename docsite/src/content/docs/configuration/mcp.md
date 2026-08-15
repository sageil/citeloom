---
title: Configure MCP
description: Connect one MCP host to CiteLoom, then search and ask across the user's combined authorized document set.
---

CiteLoom serves MCP over Streamable HTTP at one URL:

```text
https://citeloom.example/mcp
```

Replace `https://citeloom.example` with the first origin in the CiteLoom **Public origins** list.
CiteLoom accepts only [MCP protocol `2026-07-28`](https://modelcontextprotocol.io/specification/2026-07-28).

## How workspace access works

The OAuth identity or API key identifies one CiteLoom user.
CiteLoom finds all active workspaces where that user has an enabled membership.
The MCP client does not select a workspace.
It does not send a workspace name, workspace header, or workspace tool argument.

CiteLoom combines the documents available through these workspaces into one authorized document set.
This set includes private libraries owned by an available workspace.
It also includes shared libraries granted to at least one available workspace.
CiteLoom includes each library one time.

Each Search call performs one search over this combined document set.
Each Ask task performs one retrieval and creates one answer over this combined document set.

## Capabilities

The MCP host receives only the capabilities allowed by the OAuth token or API key.

| Scope | Name | Type | Behavior |
| --- | --- | --- | --- |
| Any authenticated request | `citeloom://workspace/context` | Resource | Returns the authenticated user and all available workspaces. |
| `citeloom.search` | `citeloom.search_sources` | Tool | Performs one search over the combined authorized document set. |
| `citeloom.search` | `citeloom.search_workspace` | Prompt | Tells the model to search the combined authorized document set and keep the evidence metadata. |
| `citeloom.answer` | `citeloom.ask_documents` | Tool | Starts one durable answer task over the combined authorized document set. |
| `citeloom.answer` | `citeloom.get_answer` | Tool | Returns the task state and the single combined answer. |
| `citeloom.answer` | `citeloom.cancel_answer` | Tool | Requests cancellation of an answer task. |
| `citeloom.answer` | `citeloom.answer_with_citations` | Prompt | Tells the model to request and present the cited answer. |
| `citeloom.answer` | `citeloom://workspaces/{workspaceId}/research/threads/{threadId}` | Resource template | Returns a saved research thread from an available workspace. |
| `citeloom.answer` | `citeloom://workspaces/{workspaceId}/research/citations/{citationId}` | Resource template | Returns citation evidence from an available workspace. |

## Search available documents

Call `citeloom.search_sources` once.
CiteLoom resolves the combined authorized document set before retrieval.
CiteLoom returns one search result.
The MCP host gives that result to the model.

## Ask available documents

Use this sequence:

1. Call `citeloom.ask_documents` with the question, document scope, and research thread title.
2. Save the returned `taskId`.
3. Wait for the returned `pollIntervalMs`.
4. Call `citeloom.get_answer` with the `taskId`.
5. If the status is `working`, wait and call `citeloom.get_answer` again.
6. If the status is `completed`, use the cited answer.
7. If the status is `failed` or `cancelled`, show that state to the user.

CiteLoom creates one saved research turn for the combined answer.

Call `citeloom.cancel_answer` when the user asks to stop active work.
Call `citeloom.get_answer` after cancellation to confirm the final state.

## How CiteLoom stores task state

CiteLoom stores answer-task state in PostgreSQL and returns an opaque `taskId`.
It does not send a `requestState` object to the client.
The answer tools do not return `input_required` and do not pause for more client input.

The task owner contains the authenticated issuer, subject, client ID, and CiteLoom user ID.
The task owner does not contain a workspace selector.
The same credential must read or cancel the task.
The `taskId` does not grant access by itself.

CiteLoom resolves current workspace memberships before task execution.
The completed result records the workspaces used for the answer.
If the user later loses one of these workspaces, CiteLoom does not return the combined answer.

## Connect with OAuth

Use OAuth when the MCP host acts for an interactive CiteLoom user.

### Configure CiteLoom and the authorization server

1. Put the HTTPS origin used for MCP first in CiteLoom's **Public origins** list.
2. Activate OAuth under **Security > Authentication**.
3. Configure the authorization server with the MCP resource identifier `https://citeloom.example/mcp`.
4. Allow the MCP resource to grant `citeloom.search`, `citeloom.answer`, or both.
5. Configure a public MCP client with Authorization Code and PKCE.
6. Link the OAuth subject to an active CiteLoom user.
7. Add that user to each workspace that the MCP connection must use.

The MCP host owns its callback URI.
Configure that exact callback URI in the authorization server.
The [OAuth guide](../../installation/oauth/) defines the compatibility contract and includes a Logto example.

### Configure the MCP host

| Setting | Value |
| --- | --- |
| Transport | Streamable HTTP |
| Server URL | `https://citeloom.example/mcp` |
| OAuth resource | `https://citeloom.example/mcp` |
| OAuth client | The configured public-client ID, or another registration method supported by the MCP host and authorization server. |
| Scopes | `citeloom.search`, `citeloom.answer`, or both. |

Do not add a workspace to the URL.
Do not add a custom workspace header.

### OAuth discovery and validation

CiteLoom publishes MCP protected-resource metadata at:

```text
https://citeloom.example/.well-known/oauth-protected-resource/mcp
```

An unauthenticated `GET /mcp` request returns HTTP 401 with a `WWW-Authenticate` header that points to this metadata.
An authenticated `GET /mcp` request returns HTTP 405 with `Allow: POST`.
Send MCP protocol messages to `POST /mcp`.
A rejected OAuth bearer token returns an OAuth challenge that contains the protected-resource metadata URL.

The OAuth access token must have:

- The configured authorization-server issuer.
- The exact `https://citeloom.example/mcp` audience.
- An unexpired signature that the issuer's signing keys can verify.
- A client identifier.
- The scope needed by the requested CiteLoom operation.

CiteLoom resolves the token subject to an active local user and all active workspace memberships for that user.

### Verify OAuth access

1. Reconnect the MCP server and complete the browser authorization flow.
2. Read `citeloom://workspace/context`.
3. Confirm the username and the complete workspace list.
4. Call `citeloom.search_sources`.
5. Confirm that the response contains one combined search result.

## Test with MCP Inspector

The repository includes MCP Inspector `2.2.0`.
Use its browser interface to inspect OAuth, tools, prompts, resources, requests, and responses.

### 1. Register the callback

Add this exact redirect URI to the public Native application in your authorization server:

```text
http://127.0.0.1:6276/oauth/callback
```

Grant `citeloom.search`, `citeloom.answer`, or both to the application.
Do not add a client secret.

### 2. Configure the Inspector

Open `mcp-client/inspector.json` in the CiteLoom repository.
Set the server URL and public client ID for your installation:

```json
{
  "mcpServers": {
    "citeloom": {
      "type": "http",
      "url": "https://citeloom.example/mcp",
      "protocolEra": "modern",
      "oauth": {
        "clientId": "YOUR_NATIVE_APPLICATION_ID",
        "scopes": "citeloom.search citeloom.answer"
      }
    }
  }
}
```

Keep `protocolEra` set to `modern` because CiteLoom accepts MCP `2026-07-28`.

To test an MCP API key, add a second server entry without a credential:

```json
{
  "mcpServers": {
    "citeloom-api-key": {
      "type": "http",
      "url": "https://citeloom.example/mcp",
      "protocolEra": "modern"
    }
  }
}
```

Do not put an API key in this file.

### 3. Start the browser interface

From the CiteLoom repository root, install the pinned packages:

```sh
pnpm install
```

Start the Inspector:

```sh
pnpm mcp:inspect:web
```

The command starts a local Inspector at `http://localhost:6274` and opens the correct local session in your browser.
Do not copy or publish the local Inspector access token from the browser URL.

If CiteLoom uses a private certificate authority, give Node the public root certificate:

```sh
NODE_EXTRA_CA_CERTS=/absolute/path/to/root.crt pnpm mcp:inspect:web
```

Do not disable certificate or host-name validation.

### 4. Connect through OAuth

1. Select `citeloom` from the configured server list.
2. Select **Connect**.
3. Sign in through the authorization page that the Inspector opens.
4. Approve the CiteLoom MCP scopes.
5. Return to the Inspector.
6. Confirm that the connection state is **Connected**.

Open **Tools**.
The complete scope set shows these tools:

- `citeloom.search_sources`
- `citeloom.ask_documents`
- `citeloom.get_answer`
- `citeloom.cancel_answer`

### Use an MCP API key

Use these steps instead of the OAuth connection steps when you want to test an API key:

1. Stop an Inspector session that used OAuth for the same CiteLoom URL.
2. Start an API-key session with a separate credential store:

```sh
MCP_STORAGE_DIR=/tmp/citeloom-mcp-inspector-api-key pnpm mcp:inspect:web
```

3. Select `citeloom-api-key` from the configured server list.
4. Open the server settings.
5. Add a header named `Authorization`.
6. Set its value to `Bearer YOUR_CITELOOM_MCP_KEY`.
7. Select **Connect**.
8. Confirm that the connection state is **Connected**.

The checked-in configuration is read-only during the Inspector session.
The separate credential store prevents Inspector from adding a saved OAuth token to the API-key request.
Do not export or save a configuration that contains the API key.
Remove the header from the browser interface when the test is complete.

### 5. Test Search

Select `citeloom.search_sources` and enter these values:

```json
{
  "includeRelated": false,
  "keywordPage": 1,
  "query": "retention policy",
  "scope": {
    "kind": "all"
  }
}
```

Select **Run**.
Confirm that `structuredContent` contains one result over the complete authorized document set.
Confirm that each result includes its source file and evidence passage.

### 6. Test Ask

Select `citeloom.ask_documents` and enter these values:

```json
{
  "question": "What retention policy do these documents define?",
  "scope": {
    "kind": "all"
  },
  "threadTitle": "MCP Inspector test"
}
```

Select **Run** and copy the returned `taskId`.
The first result normally has the status `working`.

Select `citeloom.get_answer` and enter the task ID:

```json
{
  "taskId": "PASTE_TASK_ID_HERE"
}
```

Wait for `pollIntervalMs` before each new call.
Repeat the call while the status is `working`.

When the status is `completed`, confirm these fields:

- `answer` contains the cited answer.
- `matchedDocuments` contains the source files used for the answer.
- `workspaceIds` contains the workspaces used for retrieval.
- `resources` contains links when the result exposes saved research resources.

### 7. Stop the Inspector

Return to the terminal and press **Ctrl+C**.
The Inspector keeps its OAuth tokens under `~/.mcp-inspector/storage/` so the next session can reuse them.

## Connect with an MCP API key

Use an MCP API key for automation or when the MCP host accepts a fixed bearer secret.
An API key works while CiteLoom browser authentication is in local or OAuth mode.

### Create the key

1. Open **Security > User accounts**.
2. Open the target user's **Actions** menu.
3. Select **Manage MCP API keys**.
4. Select the expiry and the `citeloom.search` or `citeloom.answer` scopes.
5. Copy the cleartext key when CiteLoom displays it.

Global administrators can manage keys for any active user.
Workspace administrators can manage keys for active users in the workspace that they administer.

CiteLoom displays the key one time and stores only its SHA-256 digest.
Store the key in the MCP host's secret store.

### Configure the MCP host

Use `https://citeloom.example/mcp` as the Streamable HTTP server URL.
Send the key as a bearer credential:

```http
Authorization: Bearer <CiteLoom MCP API key>
```

Do not configure an OAuth client, OAuth resource, or callback for an API key.
The key uses all active workspaces where its owner has an enabled membership.

For every request, CiteLoom checks the key digest, expiry, revocation state, owner state, workspace states, memberships, and scope.

### Verify API-key access

1. Reconnect the MCP server.
2. Read `citeloom://workspace/context`.
3. Confirm the key owner and the complete workspace list.
4. Call `citeloom.search_sources`.
5. Confirm that the response contains one combined search result.

## Correct rejected requests

| Result | Meaning | Correction |
| --- | --- | --- |
| HTTP 401 `invalid_token` | The OAuth token or API key is absent, invalid, expired, or revoked. | Authorize again or replace the API key, then reconnect. |
| HTTP 403 `insufficient_scope` | The credential does not grant the scope that the operation needs. | Grant `citeloom.search` or `citeloom.answer` as shown in the challenge. |
| HTTP 403 `access_denied` | The identity is not linked to an active CiteLoom user with an active workspace membership. | Check the subject link, user state, workspace states, and memberships. |
| HTTP 405 from authenticated `GET /mcp` | The host used GET for an MCP protocol message. | Send the MCP message to `POST /mcp`. |
| HTTP 400 protocol mismatch | The host used a protocol other than `2026-07-28`. | Configure or update the host to use MCP `2026-07-28`. |

The [OAuth and MCP reference](../../reference/oauth/#mcp) documents the server-side authentication and task behavior.
