---
title: Use OAuth
description: Configure CiteLoom with a compatible OpenID Connect authorization server, with Logto as one example.
---

CiteLoom can use a compatible OAuth 2.0 and OpenID Connect authorization server.
It does not use a Logto-specific SDK or token format.
Logto is one self-hosted example.

CiteLoom keeps user roles, workspace memberships, and document access in CiteLoom.
The authorization server authenticates the user and grants OAuth scopes.

## Check authorization-server compatibility

The authorization server must:

- Use an HTTPS issuer.
- Publish an OpenID Connect discovery document for the exact issuer.
- Publish an HTTPS JSON Web Key Set.
- Support Authorization Code with PKCE S256 for public clients.
- Accept the OAuth `resource` parameter and issue a JWT access token for the exact CiteLoom API or MCP audience.
- Put the external user identifier in `sub`.
- Put granted scopes in the space-separated `scope` claim.
- Put the MCP client identifier in `client_id` or `azp`.
- Allow the CiteLoom browser origin to read discovery and token responses through CORS.
- Register the exact browser callback URI.
- Accept the exact post-logout redirect URI when the server provides a logout endpoint.

CiteLoom verifies the token signature, issuer, audience, expiry, subject, and scopes.
CiteLoom does not register an OAuth client with the authorization server.

For an interactive MCP connection, use one of these registration paths:

- Register a public client when the MCP host lets you enter a client ID.
- Use a registration method that both the MCP host and authorization server support.

The MCP host owns its callback URI.
Register that exact URI with the authorization server.
Do not use a callback URI from this guide unless the MCP host gives you the same URI.

## Values that you need

Select the public HTTPS origin for CiteLoom before you configure OAuth.
This guide uses `https://citeloom.example`.

| Value | Example or source |
| --- | --- |
| First CiteLoom public origin | `https://citeloom.example` |
| Authorization server issuer | `https://identity.example.com/oidc` |
| Browser API resource | `https://citeloom.example/api` |
| MCP resource | `https://citeloom.example/mcp` |
| Browser callback | `https://citeloom.example/oauth/callback` |
| Browser post-logout redirect | `https://citeloom.example/login` |
| Browser public client ID | The client ID from the authorization server |
| Browser scopes | `openid profile citeloom.app` |
| MCP scopes | `citeloom.search citeloom.answer` |
| MCP callback | The exact callback URI from the MCP host |
| MCP public client ID | The client ID from the authorization server when the host uses a configured client ID |

Put the exact canonical public origin first in the list.
CiteLoom accepts browser requests from every origin in the list.

## Configure CiteLoom with a compatible authorization server

1. Create separate API and MCP resources with the exact audiences shown above.
2. Add `citeloom.app` to the browser API resource.
3. Add `citeloom.search`, `citeloom.answer`, or both to the MCP resource.
4. Register the CiteLoom browser as a public client with Authorization Code and PKCE S256.
5. Register the exact CiteLoom browser callback and post-logout redirect URIs.
6. Configure the MCP client registration path that the MCP host and authorization server support.
7. Set the CiteLoom public origins under **Settings > Web server** and restart the web service.
8. Open **Security > Authentication** and stage the issuer, browser client ID, browser scopes, API scopes, and MCP scopes.
9. Link each external `sub` value to an existing CiteLoom user.
10. Enable host recovery and activate OAuth with a linked global administrator.
11. Test browser sign-in and each MCP host before you end local access.

The [Security reference](../../reference/oauth/) describes the exact token checks, activation behavior, user linking, recovery, and MCP discovery responses.

## Logto example

The remaining steps show one working self-hosted configuration with Logto.
Other compatible authorization servers use different names and administration screens for resources, scopes, public clients, and user grants.

The screen captures use a working test installation.
Replace its domain names, application IDs, user IDs, and callback URIs with values from your installation and MCP hosts.

This example uses these additional values:

| Value | Example |
| --- | --- |
| Logto public endpoint | `https://auth.example.com` |
| Logto admin endpoint | `https://auth-admin.example.com` |
| Logto issuer | `https://auth.example.com/oidc` |

### 1. Start Logto

Copy the `LOGTO_*` names from `.env.example` into your deployment `.env` file.
The following values are an example for the included Compose file:

```dotenv
LOGTO_COMPOSE_PROJECT_NAME=citeloom-logto
LOGTO_IMAGE=ghcr.io/logto-io/logto:1.42.0
LOGTO_POSTGRES_IMAGE=postgres:17-alpine
LOGTO_POSTGRES_USER=logto
LOGTO_POSTGRES_PASSWORD=REPLACE_WITH_A_STRONG_PASSWORD
LOGTO_POSTGRES_DATABASE=logto
LOGTO_DATABASE_URL=postgres://logto:REPLACE_WITH_A_URL_ENCODED_PASSWORD@logto-postgres:5432/logto
LOGTO_ENDPOINT=https://auth.example.com
LOGTO_ADMIN_ENDPOINT=https://auth-admin.example.com
LOGTO_BIND_ADDRESS=127.0.0.1
LOGTO_PUBLIC_PORT=3001
LOGTO_ADMIN_PORT=3002
LOGTO_PUBLIC_CONTAINER_PORT=3001
LOGTO_ADMIN_CONTAINER_PORT=3002
LOGTO_TRUST_PROXY_HEADER=1
LOGTO_POSTGRES_DATA_DIRECTORY=/srv/citeloom/logto-postgres
LOGTO_POSTGRES_DATA_TARGET=/var/lib/postgresql/data
LOGTO_RESTART_POLICY=unless-stopped
```

Use a URL-encoded database password in `LOGTO_DATABASE_URL`.
Do not commit the deployment `.env` file.

Start the independent Logto stack:

```bash
docker compose --env-file .env -f compose.logto.yml up -d --wait
```

#### Upgrade an existing Logto database

Apply the Logto database alterations before you start a newer Logto image with an existing database.
The target version must match `LOGTO_IMAGE`.

For Logto `1.42.0`:

```bash
docker compose --env-file .env -f compose.logto.yml pull logto
docker compose --env-file .env -f compose.logto.yml up -d --wait logto-postgres
docker compose --env-file .env -f compose.logto.yml run --rm --no-deps \
  -e CI=true --entrypoint sh logto \
  -c 'npm run alteration deploy 1.42.0'
docker compose --env-file .env -f compose.logto.yml up -d --wait
```

Run the alteration job once.
If it fails, correct the reported problem and run the same command again.
Logto runs each alteration script in a database transaction.
See the [Logto database-alteration guide](https://docs.logto.io/logto-oss/using-cli/database-alteration) before you upgrade across more than one release.

The Compose file publishes the Logto public service and admin service on separate ports.
Put both services behind trusted HTTPS.
Limit access to the admin endpoint to approved operators.

The public Logto endpoint must serve this OpenID Connect discovery document:

```text
https://auth.example.com/oidc/.well-known/openid-configuration
```

### 2. Create the Logto API resources

Sign in to the Logto admin console.
Open **API resources**.

Create these two resources:

| API name | API identifier | Permissions |
| --- | --- | --- |
| CiteLoom Browser API | `https://citeloom.example/api` | `citeloom.app` |
| CiteLoom MCP | `https://citeloom.example/mcp` | `citeloom.search`, `citeloom.answer` |

The Browser API resource has one permission:

![The Logto Browser API resource uses the API identifier that ends with slash api and has the citeloom.app permission.](/citeloom/images/oauth-logto-browser-api.png)

The MCP resource has separate permissions for search and answers:

![The Logto MCP resource uses the API identifier that ends with slash mcp and has the citeloom.search and citeloom.answer permissions.](/citeloom/images/oauth-logto-mcp-api.png)

Use these permission descriptions:

- `citeloom.app`: Use the CiteLoom browser API.
- `citeloom.search`: Search indexed documents.
- `citeloom.answer`: Ask questions and read saved answer evidence.

Do not make one resource a substitute for the other resource.
CiteLoom checks the exact token audience for each endpoint.

Logto calls an OAuth scope a permission in parts of the admin console.
The [Logto API resource guide](https://docs.logto.io/authorization/global-api-resources) explains this model.

### 3. Create a Logto user role

Open **Roles** and create a **User** role.
For example, use the role name `citeloom`.

Assign these permissions to the role:

- `citeloom.app` from **CiteLoom Browser API**.
- `citeloom.search` from **CiteLoom MCP**.
- `citeloom.answer` from **CiteLoom MCP**.

![The Logto citeloom user role has the browser, search, and answer permissions.](/citeloom/images/oauth-logto-role.png)

Open each Logto user who can use CiteLoom and assign this role.
An application permission list does not replace the user role.
The access token contains only the permissions that Logto grants to the user.

### 4. Create the CiteLoom browser application

Open **Applications** and select **Third-party apps**.
Select **Create application**.
Select **Single Page App** because the CiteLoom browser client is a public client that uses PKCE.

Configure these values:

| Setting | Value |
| --- | --- |
| Application name | `CiteLoom` |
| Redirect URI | `https://citeloom.example/oauth/callback` |
| Post sign-out redirect URI | `https://citeloom.example/login` |
| User permission | `profile` |
| API permission | `citeloom.app` from the Browser API resource |

Save the application.

![The Logto CiteLoom application is a third-party Single Page App with the browser callback, sign-out redirect, and CORS origin.](/citeloom/images/oauth-logto-browser-app.png)

Select `profile` and `citeloom.app` on the **Permissions** tab:

![The Logto CiteLoom application has the profile and citeloom.app permissions.](/citeloom/images/oauth-logto-browser-app-permissions.png)

Do not create or use a client secret for this application.
Copy the Logto **Application ID**.
CiteLoom uses this value as the browser public client ID.

Logto requires an exact redirect URI.
The [Logto application reference](https://docs.logto.io/integrate-logto/application-data-structure) describes public clients, PKCE, and redirect URIs.

### 5. Create the Logto MCP application

Create one shared third-party OIDC application for interactive MCP hosts.
This manual workflow applies when an MCP host lets you set an OAuth client ID.
This workflow does not use CIMD or dynamic client registration.
OAuth client registration and the MCP protocol version are separate.
This setup does not add another MCP protocol version.

In Logto:

1. Open **Applications**.
2. Select **Third-party apps**.
3. Select **Create application**.
4. Select **Native** because the MCP host is a public client that uses Authorization Code with PKCE.
5. Set the application name to `CiteLoom MCP`.
6. Copy the exact callback URI from the MCP host.
7. Add that URI under **Redirect URIs**.
8. Save the application.

Configure the MCP application:

| Setting | Value |
| --- | --- |
| Application name | `CiteLoom MCP` |
| Redirect URIs | The exact callback URI for each MCP host that will use this application |
| API permissions | `citeloom.search`, `citeloom.answer`, or both from the MCP resource |

One shared Native application can contain callback URIs for more than one MCP host.
The screen capture shows three exact callback URIs in one application:

![The shared Logto CiteLoom MCP Native application has three exact loopback callback URIs.](/citeloom/images/oauth-logto-mcp-app.png)

The callback URI comes from the MCP host.
Do not copy a callback URI from the screen capture unless your host gives you the same URI.
Do not use a wildcard callback URI.
Logto can show a consistency warning when callback URIs use both `localhost` and `127.0.0.1`.
Keep the exact host name that each MCP host gives you.

The repository MCP test client uses this callback:

```text
http://127.0.0.1:6276/oauth/callback
```

Open the **Permissions** tab.
Select `citeloom.search` and `citeloom.answer` from **CiteLoom MCP**:

![The Logto CiteLoom MCP application has only the citeloom.search and citeloom.answer permissions.](/citeloom/images/oauth-logto-mcp-app-permissions.png)

The result is one browser application and one shared MCP application:

![The Logto third-party application list contains the CiteLoom Single Page App and the shared CiteLoom MCP Native App.](/citeloom/images/oauth-logto-applications.png)

Do not add a client secret to a Native application.
Copy the Logto **Application ID**.
Enter this ID in each compatible MCP host that uses this shared application.

The unauthenticated `GET /mcp` challenge lets a host discover the Logto issuer and CiteLoom MCP scopes.
It does not register an OAuth client in Logto.
If an MCP host does not let you set an OAuth client ID, it cannot use this manual registration workflow.

The [Logto third-party application guide](https://docs.logto.io/integrate-logto/third-party-applications) describes Native public clients and PKCE.

### 6. Configure the CiteLoom public origins

Sign in to CiteLoom as a global administrator.
Open **Settings** and select **Web server**.
Set **Public origins** to a JSON list of browser origins.
Put the origin used for OAuth and MCP first.
Restart the CiteLoom web service after you save this setting.

For this guide, the value is:

```json
[
  "https://citeloom.example"
]
```

CiteLoom derives the API resource, MCP resource, callback URI, and post-logout URI from the first origin.
CiteLoom accepts state-changing browser requests from every origin in the list.
When OAuth is active, CiteLoom moves browser sessions from another listed origin to the first origin before sign-in.
You do not enter those four derived values in the OAuth form.

### 7. Stage OAuth in CiteLoom

Open **Security** and select **Authentication**.
Select **Configure OAuth**.

Enter these values:

| CiteLoom field | Value |
| --- | --- |
| Authorization server issuer | `https://auth.example.com/oidc` |
| Browser public client ID | The Application ID of the Logto CiteLoom SPA |
| Browser authorization scopes | `openid profile citeloom.app` |
| Browser API scopes | `citeloom.app` |
| MCP scopes | `citeloom.search citeloom.answer` |

![The CiteLoom Stage OAuth form shows the issuer, browser client ID, browser scopes, API scope, and MCP scopes.](/citeloom/images/oauth-citeloom-settings.png)

The screen capture shows the test issuer and browser application ID.
Use the issuer and application ID from your Logto installation.

Select **Verify and stage**.
CiteLoom reads the issuer discovery document and signing keys before it saves the staged configuration.
Cookie sign-in stays active while the configuration is staged.

### 8. Link Logto users to CiteLoom users

Create each user and workspace membership in CiteLoom before you add the OAuth mapping.

In Logto, open the user details and copy the immutable User ID.
The Logto User ID is the OAuth `sub` claim.

In CiteLoom:

1. Open **Security**.
2. Select **Authentication**.
3. Select **Add mapping**.
4. Select the existing CiteLoom user.
5. Enter the Logto User ID in **External subject**.
6. Select **Add mapping**.

CiteLoom links the verified pair of issuer and subject.
It does not link by email address, username, or display name.

### 9. Enable recovery and activate OAuth

Enable **Host recovery** before activation.
This setting lets a host operator return CiteLoom to local sign-in if Logto is unavailable.

Select **Verify and activate**.
Sign in through Logto with the linked global administrator.
Confirm that CiteLoom returns to the application as that administrator.

Activation replaces browser cookie authentication with OAuth bearer tokens.
Activation also revokes the existing CiteLoom cookie sessions.

The Authentication page now shows the active issuer, browser API resource, MCP resource, host recovery state, and user mapping:

![The CiteLoom Authentication page shows active OAuth, the browser and MCP resources, enabled host recovery, and one mapped user.](/citeloom/images/oauth-citeloom-overview.png)

### 10. Configure an MCP host

Enter these values in the MCP host:

| Setting | Value |
| --- | --- |
| Transport | Streamable HTTP |
| Server URL | `https://citeloom.example/mcp` |
| OAuth client ID | The Application ID of the shared Logto MCP application |
| OAuth resource | `https://citeloom.example/mcp` |
| OAuth scopes | `citeloom.search citeloom.answer` |
| Request header | `X-CiteLoom-Workspace-Name: <visible workspace name>` |

Send the workspace header only to the CiteLoom MCP endpoint.
Do not send it to Logto.

Then connect the host:

1. The host sends an unauthenticated request to the CiteLoom MCP URL.
2. CiteLoom returns an OAuth challenge with its protected-resource metadata URL.
3. The host reads the Logto issuer and CiteLoom scopes from that metadata.
4. The host opens Logto in the browser.
5. The user signs in and approves the MCP scopes.
6. Logto redirects the browser to the exact host callback URI.
7. The host exchanges the authorization code for an access token.
8. The host sends the token and workspace header to CiteLoom.

A loopback callback such as `http://127.0.0.1:6276/oauth/callback` runs on the user's computer.
The CiteLoom and Logto servers can be on the internet.
The user's browser must be able to reach the loopback listener that the MCP host starts.

#### Repository MCP client

Use the exact callback URI that you registered in the Logto Native application:

```bash
pnpm mcp:client -- \
  --server-url https://citeloom.example/mcp \
  --client-id 'YOUR_LOGTO_NATIVE_APPLICATION_ID' \
  --callback-url http://127.0.0.1:6276/oauth/callback \
  --workspace 'YOUR_WORKSPACE_NAME' \
  --question 'What policy is documented in this workspace?'
```

If the deployment uses a private certificate authority, add `--ca-file` with the public root certificate path.
Do not disable certificate or host-name verification.

### 11. Verify the complete setup

Complete these checks in order:

1. Open `https://auth.example.com/oidc/.well-known/openid-configuration`.
2. Open `https://citeloom.example/.well-known/oauth-protected-resource/api`.
3. Confirm that the API metadata names the Logto issuer and the Browser API resource.
4. Open `https://citeloom.example/.well-known/oauth-protected-resource/mcp`.
5. Confirm that the MCP metadata shows `citeloom.search` and `citeloom.answer`.
6. Sign out of CiteLoom and complete the browser OAuth flow.
7. Connect the MCP host and approve its Logto consent screen.
8. Read `citeloom://workspace/context`.
9. Confirm the returned username and workspace name.
10. List MCP tools and confirm that the granted scopes expose the expected tools.

The MCP host must support `io.modelcontextprotocol/tasks` to use `citeloom.ask_documents`.
A host without that extension can still use `citeloom.search_sources` when it has `citeloom.search`.

## Correct common errors

| Error | Cause | Correction |
| --- | --- | --- |
| Redirect URI error | The MCP or browser callback does not exactly match the registered public client. | Copy the exact URI from the client configuration into the authorization server. |
| Opaque token or wrong audience | The client did not request the CiteLoom resource. | Use the CiteLoom MCP endpoint and its protected-resource metadata. |
| `insufficient_scope` | The authorization server did not grant the scope that the request needs. | Check the public-client scopes and the user's grants in the authorization server. |
| `invalid_token` | The token is expired, has the wrong issuer, or has the wrong audience. | Reauthorize and check the issuer and resource values. |
| `access_denied` | The subject mapping or CiteLoom workspace membership is missing. | Check the external subject mapping and the local workspace membership. |
| Browser CORS error | The token endpoint does not accept the CiteLoom browser origin. | Check the public-client type, token endpoint, proxy headers, and HTTPS origins. |
| OAuth activation is unavailable | Host recovery is disabled or no linked global administrator exists. | Enable Host recovery and add the administrator mapping. |

See [Configure MCP](../../configuration/mcp/) for the complete MCP capability and error reference.
