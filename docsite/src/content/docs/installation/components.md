---
title: Component map
description: Understand which CiteLoom components are required, optional, or operated separately.
---

The supplied deployment separates persistent state, document conversion, citation-support scoring, web requests, and background work.
This boundary makes each service replaceable or scalable without hiding where data flows.

| Component | Required in the supplied stack | Responsibility | Configuration owner |
| --- | --- | --- | --- |
| PostgreSQL with `pg_textsearch` | Yes | Application state, authorization, jobs, settings, lexical search, and vector metadata. | Connection and host volume in Compose; pool size in Settings > Database. |
| Migration service | Yes | Applies schema migrations and creates the first administrator on a fresh database. | Bootstrap environment variables. |
| CiteLoom web | Yes | Browser UI, APIs, OAuth callback, MCP endpoint, and upload staging. | Settings > Web server plus listener values in Compose. |
| CiteLoom worker | Yes | Ingestion, indexing, research tasks, retention, and durable background operations. | Database-owned application settings. |
| Docling | Yes | Converts uploaded documents into structured content and recoverable PDF checkpoints. | Settings > Docling. |
| HHEM | Yes | Produces advisory claim-support scores for completed answers. | Settings > Hughes Hallucination Evaluation Model. |
| Caddy | Yes in the supplied local stack | Terminates local HTTPS and distributes requests across web replicas. | `infra/caddy/Caddyfile` and persistent Caddy data. |
| Model providers | Yes, but external to the stack | Language generation, embeddings, optional ranking, VLM conversion, and speech. | Settings > Providers and feature routes. |
| SeaweedFS | No | Optional S3-compatible source-content storage. | Compose overlay plus Settings > Object storage for migrations. |
| Logto | No | Optional OAuth authorization server for browser and MCP users. | Independent Compose stack, Logto console, and Settings > Authentication. |
| MCP client | No | Uses CiteLoom search, asynchronous answers, saved threads, and citations from an external host. | OAuth client registration or a CiteLoom MCP API key. |

## Restart boundaries

- Web server settings and the worker database-pool setting take effect after restarting the affected application process.
- Docling process settings take effect after restarting Docling.
- HHEM process settings take effect after restarting HHEM.
- Provider, retrieval, answer, and most application settings are read from PostgreSQL without editing Compose.

See the [configuration overview](../../configuration/) for the distinction between deployment bootstrap values and database-owned application settings.
