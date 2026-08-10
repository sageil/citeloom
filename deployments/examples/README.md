# Deployment examples

These examples extend CiteLoom's root Compose files for specific self-hosted deployment topologies.
Run every documented command from the repository root so Compose resolves bind-mounted configuration files correctly.

| Example | Purpose | Availability boundary |
| --- | --- | --- |
| [SeaweedFS with Caddy](seaweedfs-caddy/README.md) | Balance S3 API traffic across two stateless gateways while retaining one local SeaweedFS data directory | Gateway process failure on one Docker host |

Each example documents its prerequisites, persistent state, verification procedure, and rollback path.
