# Release notes

## v1.1.0

V1.1.0 adds optional OAuth, MCP 2026 access, database-backed runtime settings, and a new documentation site.

A global administrator can stage and verify an OAuth configuration before activation.
Use OpenID Connect compatible providers, and the documentation includes a complete Logto example.
OAuth identities use a verified issuer and subject link to an existing CiteLoom user.
CiteLoom continues to control users, workspace memberships, roles, and source-library access.
The Public origins setting now accepts more than one origin and uses the first origin as the canonical public address.

MCP clients can use OAuth bearer tokens or user-bound API keys with separate Search and Ask permissions.
The repository includes a browser-based MCP Inspector configuration and a smoke-test client.

Most service configurations are now managed in the application settings.
Administrators can manage public origins and service settings in CiteLoom instead of maintaining separate process values for each service.
Work that is already in progress keeps the settings snapshot that it started with.

## v1.0.0

CiteLoom 1.0.0 adds optional S3-compatible object storage for original source documents, including a bundled SeaweedFS deployment option.
Filesystem storage remains supported, and administrators can test a target and run a verified background migration from Settings > Object storage.

Object storage keeps source bytes independent from application containers and lets operators use self-hosted infrastructure or another S3-compatible service.
This provides more control over storage placement, separates application scaling from source-content storage, and retains the previous backend for a reverse migration.

To try the self-hosted topology with SeaweedFS, two stateless S3 gateways, and Caddy load balancing, follow the [`deployments/examples/seaweedfs-caddy`](../deployments/examples/seaweedfs-caddy/README.md) example.
The example improves S3 gateway availability on one Docker host, but it does not provide storage-node or host-level high availability.
