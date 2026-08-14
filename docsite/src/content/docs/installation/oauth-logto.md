---
title: OAuth with Logto
description: Operate the optional Logto stack and connect it to CiteLoom's database-owned OAuth configuration.
---

CiteLoom works in local authentication mode without Logto.
Add Logto only when browser users or interactive MCP clients should authenticate through OAuth.

## 1. Operate Logto separately

Copy the `LOGTO_*` values from `.env.example` into the deployment `.env` and replace every placeholder with deployment-specific values.
Expose the public and administration endpoints through trusted HTTPS before configuring CiteLoom.

```bash
docker compose --env-file .env -f compose.logto.yml up -d --wait
```

The Logto stack owns its own PostgreSQL database.
Its environment values configure Logto's process and deployment, not CiteLoom's OAuth behavior.

## 2. Register CiteLoom resources

In the authorization server, register two distinct API resources derived from CiteLoom's public origin:

| Resource | Indicator | CiteLoom scope |
| --- | --- | --- |
| Browser API | `https://citeloom.example/api` | The required API scope configured in CiteLoom. |
| MCP | `https://citeloom.example/mcp` | `citeloom.search` and `citeloom.answer` as needed. |

Register the browser as a public client with these exact URIs:

- Redirect URI: `https://citeloom.example/oauth/callback`
- Post-logout redirect URI: `https://citeloom.example/login`

Register each native MCP client separately with its exact loopback redirect URI.
For the repository smoke client, an example is `http://127.0.0.1:6276/oauth/callback`.

## 3. Configure CiteLoom

Open Security > Authentication as a global administrator.
Enter the HTTPS issuer, browser public-client ID, browser authorization scopes, required API scopes, and required MCP scopes.
CiteLoom derives its API and MCP resource indicators and browser redirects from the stored Public origin.

Enable Host recovery before activation.
CiteLoom will reject activation when that recovery setting is disabled.

## 4. Link immutable identities

Create each user and workspace membership in CiteLoom first.
Then link the authorization server's verified `(issuer, subject)` pair to that existing CiteLoom user.
CiteLoom does not link by email address, username, or display name.

Staging OAuth does not affect current local sessions.
A linked global administrator must complete the staged OAuth flow and activate the exact staged configuration before CiteLoom switches authentication modes.

See the [complete OAuth reference](../../reference/oauth/) for browser token storage, authorization checks, protected-resource metadata, disabling OAuth, and host recovery.
