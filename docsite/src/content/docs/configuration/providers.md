---
title: Local, remote, or hybrid models
description: Route each CiteLoom capability to a local model, a remote provider, or a deliberate mix.
---

CiteLoom does not require one provider to handle every model capability.
Connections define endpoints and credentials, while feature routes decide which connection and model perform each job.

## Required and optional routes

| Feature | Required | What it does |
| --- | --- | --- |
| Ask | Yes | Generates cited answers to document questions. |
| Chat | Yes | Generates document-grounded conversation turns. |
| Indexing model | Yes | Creates document metadata used during ingestion. |
| Embedding model | Yes | Creates document and query embeddings for semantic or hybrid retrieval. |
| Query Expansion | Only when expansion count is greater than zero | Generates alternate search wording. |
| Search ranking | No | Reorders retrieved candidates before answer generation. |
| Speech input | No | Transcribes browser recordings. |
| Spoken answers | No | Generates audio for completed answers and supported evidence. |

## All-local deployment

Route every required feature to endpoints on infrastructure you control.
This is the clearest option when content must remain on a private network or the installation needs to operate without an external inference service.

The application containers reach a host model service through `host.docker.internal` in the supplied Compose configuration.
Verify the exact endpoint and model identifiers from inside the containers with `pnpm run doctor:docker`.

Local operation still requires you to size memory, accelerator capacity, concurrency, and model context for the configured workload.
CiteLoom does not silently reduce configured retrieval limits when a model cannot accept the resulting context.

## Remote-provider deployment

Route selected features to managed providers when you need elastic capacity, a broader model catalog, or capabilities unavailable locally.
Store provider credentials through Settings; CiteLoom keeps them in PostgreSQL.
Protect database backups as credentials-bearing assets.

Document text or audio sent to a remote provider leaves the CiteLoom host.
Review the chosen provider's data handling and retention terms before enabling the route.

## Hybrid deployment

A common hybrid boundary keeps document conversion, embeddings, and retrieval local while using a remote language model for Ask or Chat.
Another installation may keep answer generation local but use a remote speech or visual model.

Choose the boundary per feature:

1. Create and verify each provider connection.
2. Assign required features to compatible connections.
3. Set a feature-specific model only when it should differ from the connection default.
4. Save the routes.
5. Reindex when the embedding model, dimensions, document section method, or search text format changed.
6. Test representative documents and questions instead of assuming model-family compatibility.

Fresh installations route the required features to Ollama and leave optional routes unassigned.
The [provider reference](../../reference/configuration/#provider-reference) lists the supported profiles, endpoint formats, adapters, and credential behavior.
