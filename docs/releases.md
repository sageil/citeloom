# Release notes

## v0.3.5

CiteLoom 0.3.5 adds optional S3-compatible object storage for original source documents, including a bundled SeaweedFS deployment option.
Filesystem storage remains supported, and administrators can test a target and run a verified background migration from Settings > Object storage.

Object storage keeps source bytes independent from application containers and lets operators use self-hosted infrastructure or another S3-compatible service.
This provides more control over storage placement, separates application scaling from source-content storage, and retains the previous backend for a reverse migration.

To try the self-hosted topology with SeaweedFS, two stateless S3 gateways, and Caddy load balancing, follow the [`deployments/examples/seaweedfs-caddy`](../deployments/examples/seaweedfs-caddy/README.md) example.
The example improves S3 gateway availability on one Docker host, but it does not provide storage-node or host-level high availability.
