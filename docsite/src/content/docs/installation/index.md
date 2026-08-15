---
title: Installation overview
description: Choose the smallest complete CiteLoom deployment and add optional services only when needed.
---

CiteLoom has one base Docker Compose stack.
Object storage and OAuth services are optional additions.
Start with the base stack and verify it before you add another service.

## Deployment choices

| Deployment | Use it when | Compose files |
| --- | --- | --- |
| Published images | You want the supported installation path without compiling locally. | `compose.dockerhub.yml` |
| Source build | You are developing CiteLoom or validating local code changes. | `compose.yml` |
| SeaweedFS | Source documents should live in S3-compatible object storage instead of the local filesystem. | Base Compose file plus `compose.seaweedfs.yml` |
| Authorization server | Browser and MCP users should authenticate through OAuth. | Operated separately; the Logto example uses `compose.logto.yml` |

The base stack includes PostgreSQL, migrations, the web application, the background worker, Docling, HHEM, and a local Caddy HTTPS proxy.
Model providers run separately and are configured from CiteLoom Settings after installation.

## Recommended sequence

1. Complete the [minimum installation](docker-compose/).
2. Sign in with the first administrator account and configure the core model routes.
3. Run the deployment verification checks.
4. Add [SeaweedFS](seaweedfs/) if the source-content store needs S3-compatible storage.
5. Configure a [compatible authorization server](oauth/) if the installation needs application-wide OAuth.
6. Configure an [MCP client](../configuration/mcp/) with OAuth or a user-bound API key.

The [complete deployment reference](../reference/deployment/) covers storage migration, scaling, production proxy settings, release publication, and the full verification checklist.
