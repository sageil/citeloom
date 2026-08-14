---
title: Configuration overview
description: Know which values belong in CiteLoom Settings and which remain deployment bootstrap configuration.
---

CiteLoom stores application behavior in PostgreSQL and exposes it through matching Settings pages.
Compose remains responsible for process bootstrap, host paths, published ports, image selection, and the database connection needed to read those settings.

## Configure in the application

| Settings page | Examples |
| --- | --- |
| Providers and feature routes | Endpoints, credentials, models, request limits, thinking modes, speech, and ranking. |
| Search and answers | Retrieval method, candidate limits, answer evidence limits, query expansion, and temperatures. |
| Database | Maximum connections per web or worker process. |
| Docling | Connection, conversion modes, additional services, threads, batches, queues, local workers, and diagnostics. |
| Hughes Hallucination Evaluation Model | Token, attention, batch, and Torch-thread limits. |
| Web server | Public origin, secure cookies, trusted proxy, and maximum upload request size. |
| Usage diagnostics | Application-error row and age limits. |
| Object storage | Active filesystem or S3-compatible source-content backend and durable migrations. |
| Security | Users, workspaces, OAuth, identity links, and MCP API keys. |

Web and worker processes use one bootstrap database connection, read their saved settings, and then open the configured pools.
Docling and HHEM also read their process settings from PostgreSQL before starting.

## Keep in deployment configuration

- `DATABASE_URL`, because every process needs it before it can read database-owned settings.
- Image tags and the release identifier.
- Initial administrator credentials required by migration bootstrap.
- Persistent host directories and fresh-database storage defaults.
- Web listener address, listener port, and upload staging directory.
- Published host ports such as `HHEM_PORT`.
- Credentials passed to the optional SeaweedFS and Logto Compose services.

## Apply changes at the right boundary

| Change | Required action |
| --- | --- |
| Provider route, search, or answer behavior | Save in Settings; new work uses the saved configuration. |
| Web server process settings | Save, then restart web replicas. |
| Worker database pool | Save, then restart worker replicas. |
| Docling process settings | Save, then restart Docling instances. |
| HHEM process settings | Save, then restart HHEM instances. |
| Embedding model, dimensions, section method, or search text format | Save, then reindex affected documents. |

The [complete configuration reference](../reference/configuration/) documents every provider profile, route, setting, default, and reindex boundary.
