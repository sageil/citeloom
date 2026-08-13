# Logto OAuth

CiteLoom provides the OAuth protected-resource configuration and verification boundary needed by non-browser endpoints while continuing to use its existing session-cookie authentication for the browser application.
OAuth is opt-in and disabled until a global administrator verifies and saves a complete configuration on the Security page.
Existing browser APIs remain session-authenticated.
Configuring OAuth does not turn existing browser API routes into bearer-token endpoints.

## Trust and authorization model

Logto authenticates clients and issues access tokens.
CiteLoom's OAuth request authenticator validates each access token's signature, issuer, audience, expiry, workspace claim, and operation-specific scopes when an OAuth-protected endpoint invokes it.
CiteLoom does not persist access tokens or Logto secrets.

A valid token is not sufficient by itself.
A global CiteLoom administrator must explicitly link the token subject to an existing CiteLoom user and the external workspace claim to an existing CiteLoom workspace on the Security page.
CiteLoom then verifies that the linked user is active, the linked workspace is active, and the user has enabled membership in that workspace on every request.

Linking a pending CiteLoom user activates that user in the same database transaction that creates the identity link.
If link creation fails, the activation is rolled back.
Repeating the same link request is safe and returns the existing result, while attempts to reuse either immutable identifier for a different local record are rejected.
Removing either link is idempotent and prevents subsequent OAuth requests from resolving an authorized principal.
Removing a user identity link does not suspend or delete the local CiteLoom user.

OAuth principals are always workspace-scoped, including principals whose linked CiteLoom user is a global administrator.
OAuth authentication never grants CiteLoom global-administrator authority.
The resolved principal receives only the linked local workspace membership role.

## CiteLoom configuration

A global administrator configures OAuth under Security > OAuth resource access.
The configuration contains the authorization-server issuer, CiteLoom resource identifier, supported scopes, and the access-token claim containing the external workspace identifier.
CiteLoom requires HTTPS for the issuer, resource identifier, and discovered signing-key URL.
CiteLoom verifies authorization-server discovery and signing-key metadata before it saves and enables the configuration.
The configuration is stored in the CiteLoom database, not in process environment variables, so all web replicas use the same versioned settings without restart-specific configuration.

Saving a verified configuration enables OAuth resource access immediately.
Concurrent edits use the stored configuration version and reject stale updates.
Repeating the same update is safe.
Disabling OAuth takes effect immediately but preserves the saved configuration and identity mappings so it can be re-enabled later.
Changing the issuer preserves mappings associated with the old issuer, but only mappings for the current issuer are active and visible.
If CiteLoom's public origin changes, OAuth access is held inactive until a global administrator verifies and saves a resource identifier that uses the new origin.

When enabled, CiteLoom publishes protected-resource metadata at the RFC 9728 location derived from the configured resource identifier.
For example, a resource path of `/mcp` produces a metadata path of `/.well-known/oauth-protected-resource/mcp`.
An incomplete configuration cannot be enabled.

## Logto container deployment

The optional [`compose.logto.yml`](../compose.logto.yml) file follows Logto's database-seeding container entrypoint but does not provide deployment-specific defaults.
Supply every `LOGTO_*` variable shown in [`.env.example`](../.env.example), including immutable image references, externally reachable endpoints, database credentials, bound host ports, and the PostgreSQL data directory.
The Compose stack exposes Logto's HTTP container ports and does not terminate TLS, so publish the configured Logto endpoints through a trusted HTTPS reverse proxy before enabling OAuth in CiteLoom.

Start Logto independently from the CiteLoom application stack:

```sh
docker compose --env-file .env -f compose.logto.yml up -d --wait
```

Configure an API resource in Logto whose resource indicator exactly matches the resource identifier saved in CiteLoom.
Configure the resource permissions that CiteLoom will advertise as supported scopes.
Configure organization-context access tokens to include the workspace claim named in CiteLoom's OAuth configuration.

After Logto and CiteLoom are configured, create the corresponding local users, workspaces, and memberships in CiteLoom.
Use Security > OAuth resource access to enter each immutable Logto subject and organization identifier.
Do not use mutable email addresses, usernames, or display names as identity links.
