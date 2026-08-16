# CiteLoom MCP smoke client

This host-side client tests the deployed CiteLoom MCP endpoint through a separately registered native OAuth client.
It can also test a user-bound MCP API key created for a specific CiteLoom user.
It uses the official MCP TypeScript client for OAuth discovery, Authorization Code with PKCE, MCP `2026-07-28`, core tools, and resources.
It starts an answer with `citeloom.ask_documents` and polls `citeloom.get_answer` until the answer has a final state.

## MCP Inspector

The repository includes MCP Inspector `2.2.0` as a pinned development dependency.
Its checked-in configuration includes OAuth and API-key connections to the deployed CiteLoom endpoint with MCP `2026-07-28`.
The API-key connection does not contain a credential.

Register this exact callback URI in the Logto native application:

```text
http://127.0.0.1:6276/oauth/callback
```

List the available tools through OAuth:

```sh
pnpm mcp:inspect:tools
```

Open the interactive terminal client:

```sh
pnpm mcp:inspect
```

Open the Inspector in a browser:

```sh
pnpm mcp:inspect:web
```

For API-key access, create an owner-only temporary configuration outside the repository:

```sh
umask 077
cp mcp-client/inspector.json /tmp/citeloom-inspector-api-key.json
chmod 600 /tmp/citeloom-inspector-api-key.json
```

Add `"headers": { "Authorization": "Bearer YOUR_CITELOOM_MCP_KEY" }` to the `citeloom-api-key` entry in the temporary file.
Start the session with `MCP_STORAGE_DIR=/tmp/citeloom-mcp-inspector-api-key pnpm exec mcp-inspector --web --config /tmp/citeloom-inspector-api-key.json`.
Inspector `2.2.0` does not provide a header editor for a read-only `--config` session.
Delete the temporary file when the session ends.
Do not put the API key in the checked-in `mcp-client/inspector.json` file.

The Inspector stores OAuth tokens under `~/.mcp-inspector/storage/`.
The complete browser walkthrough is in the [MCP client guide](../docsite/src/content/docs/configuration/mcp.md#test-with-mcp-inspector).

The client stores OAuth tokens only in process memory and starts an HTTP callback listener only on the configured loopback address.
Publicly trusted HTTPS certificates require no TLS option.
For a private or local certificate authority, pass its public root certificate with `--ca-file`; the client adds it only to the current process and keeps normal certificate and hostname verification enabled.

## Run

### API key

In CiteLoom, open Security, select User accounts, open the target user's Actions menu, and choose Manage MCP API keys.
Generate a key with both Search documents and Ask documents permissions for the complete smoke test.
Save it in a user-readable file so it does not appear in shell history or process arguments.
Run the first two commands, paste the key at the hidden prompt, and press Enter.

```sh
umask 077
read -r -s CITELOOM_MCP_KEY
printf '%s\n' "$CITELOOM_MCP_KEY" > ./citeloom-mcp.key
unset CITELOOM_MCP_KEY
pnpm mcp:client -- \
  --server-url https://citeloom.example/mcp \
  --api-key-file ./citeloom-mcp.key \
  --question 'What policy is documented in my workspaces?'
```

### OAuth

The native OAuth application's configured redirect URI must exactly match `--callback-url`.
The OAuth application must be allowed to request `citeloom.search` and `citeloom.answer` for the CiteLoom MCP resource.

```sh
pnpm mcp:client -- \
  --server-url https://citeloom.example/mcp \
  --client-id '<native OAuth App ID>' \
  --callback-url http://127.0.0.1:6276/oauth/callback \
  --question 'What policy is documented in my workspaces?'
```

Open the authorization URL printed by the command, sign in, and approve access.
The client then verifies protocol discovery, the CiteLoom tools, source search, asynchronous answer creation and polling, and every linked thread or citation resource returned by the answer.
Search and Ask use every active workspace where the authenticated CiteLoom user has an enabled membership.

For the repository Compose deployment, Caddy writes its public root certificate to `data/caddy/caddy/pki/authorities/local/root.crt`.
Add `--ca-file <compose-directory>/data/caddy/caddy/pki/authorities/local/root.crt` to the command when that private CA is not already trusted by Node.
Do not pass `--ca-file` when the deployment uses a publicly trusted certificate.

Use `pnpm mcp:client -- --help` for timeout and polling options.
