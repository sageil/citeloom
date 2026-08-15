# CiteLoom MCP smoke client

This host-side client tests the deployed CiteLoom MCP endpoint through a separately registered native OAuth client.
It can also test a user-bound MCP API key created for a specific CiteLoom user.
It uses the official MCP TypeScript client for OAuth discovery, Authorization Code with PKCE, protocol negotiation, standard tools, and resources.
The narrow local adapter handles only CiteLoom's draft Tasks extension because the 2026 SDK rejects the extension's `task` result before a custom schema can validate it.
The adapter sends the required MCP request metadata and headers and validates every JSON-RPC task response against CiteLoom's shared task schemas.

The client stores OAuth tokens only in process memory and starts an HTTP callback listener only on the configured loopback address.
Publicly trusted HTTPS certificates require no TLS option.
For a private or local certificate authority, pass its public root certificate with `--ca-file`; the client adds it only to the current process and keeps normal certificate and hostname verification enabled.

## Run

### API key

In CiteLoom, open Security, select User accounts, open the target user's Actions menu, and choose Manage MCP API keys.
Generate a key with both Search documents and Ask documents permissions for the complete smoke test.
Provide the visible name of an active workspace where the key owner has enabled membership.
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
  --workspace '<CiteLoom workspace name>' \
  --question 'What policy is documented in this workspace?'
```

### OAuth

The native OAuth application's configured redirect URI must exactly match `--callback-url`.
The OAuth application must be allowed to request `citeloom.search` and `citeloom.answer` for the CiteLoom MCP resource.

```sh
pnpm mcp:client -- \
  --server-url https://citeloom.example/mcp \
  --client-id '<native OAuth App ID>' \
  --callback-url http://127.0.0.1:6276/oauth/callback \
  --workspace '<CiteLoom workspace name>' \
  --question 'What policy is documented in this workspace?'
```

Open the authorization URL printed by the command, sign in, and approve access.
The client then verifies protocol and extension discovery, both CiteLoom tools, source search, asynchronous answer creation and polling, and every linked thread or citation resource returned by the answer.

For the repository Compose deployment, Caddy writes its public root certificate to `data/caddy/caddy/pki/authorities/local/root.crt`.
Add `--ca-file <compose-directory>/data/caddy/caddy/pki/authorities/local/root.crt` to the command when that private CA is not already trusted by Node.
Do not pass `--ca-file` when the deployment uses a publicly trusted certificate.

Use `pnpm mcp:client -- --help` for timeout and polling options.
