---
title: Installation overview
description: Choose the smallest complete CiteLoom deployment and add optional services only when needed.
---

CiteLoom ships as a Docker Compose application with one required stack and two optional overlays.
Start with the required stack, verify it, and add optional components only when their operational value is clear.

## Deployment choices

| Deployment | Use it when | Compose files |
| --- | --- | --- |
| Published images | You want the supported installation path without compiling locally. | `compose.dockerhub.yml` |
| Source build | You are developing CiteLoom or validating local code changes. | `compose.yml` |
| SeaweedFS | Source documents should live in S3-compatible object storage instead of the local filesystem. | Base Compose file plus `compose.seaweedfs.yml` |
| Logto | Browser and MCP users should authenticate through an OAuth authorization server. | `compose.logto.yml`, operated independently from the CiteLoom stack |

The base stack includes PostgreSQL, migrations, the web application, the background worker, Docling, HHEM, and a local Caddy HTTPS proxy.
Model providers run separately and are configured from CiteLoom Settings after installation.

## Recommended sequence

1. Install the [required Docker Compose stack](docker-compose/).
2. Sign in with the bootstrap administrator and configure at least the required model routes.
3. Run the deployment verification checks.
4. Add [SeaweedFS](seaweedfs/) if the source-content store needs S3-compatible storage.
5. Add [Logto](oauth-logto/) if the installation needs application-wide OAuth.
6. Configure an [MCP client](../configuration/mcp/) with OAuth or a workspace-bound API key.

The [complete deployment reference](../reference/deployment/) covers storage migration, scaling, production proxy settings, release publication, and the full verification checklist.
