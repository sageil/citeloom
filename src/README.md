# Server source layout

Server code is grouped by the feature that owns each behavior.
This makes it easier to find a workflow and the code it depends on.
The `src` root contains only the executable `web-server.ts` entry point.

## Directory ownership

| Directory | Responsibility |
| --- | --- |
| `api/` | HTTP server setup, request validation, responses, and web-facing application services |
| `app/` | Runtime setup, settings, and application change signals |
| `answers/` | Answer generation, publishing, citation markup, streaming, and claim verification |
| `auth/` | Sign-in validation, passwords, sessions, tokens, rate limits, and storage |
| `cli/` | Command parsing, execution, and output |
| `config/` | Configuration types, schemas, readers, builders, and the public configuration interface |
| `database/` | Database connection, schema, migrations, and shared SQL queries |
| `docling/` | Docling document conversion, including its client, protocol, elements, and monitoring |
| `documents/` | File formats, source reading, catalog state, and source storage |
| `domain/` | Stable domain types and the schemas that validate them at system boundaries |
| `embedding/` | Embedding generation and embedding-space management |
| `inference/` | Model registry, model-request coordination, and model metrics |
| `ingestion/` | Ingestion workflows, artifacts, retrieval descriptions, and worker execution |
| `observability/` | Diagnostics, run telemetry, telemetry stages, and dashboard storage |
| `providers/` | Configurable provider profiles, model and speech adapters, saved provider settings, and OpenAI Codex device authentication |
| `research/` | Research threads, saved citations and claims, exports, and evidence rendering |
| `retrieval/` | Search workflows, source discovery, indexing, Query Expansion, ranking, and reranking |
| `shared/` | Small technical utilities shared across features |
| `verification/` | Verification services outside configurable model providers, including HHEM |

## Dependency rules

- Put new code in the directory that owns its behavior, not at the `src` root.
- Import modules from the feature directory that owns them instead of creating a repository-wide `src/index.ts` that re-exports unrelated features.
- Keep the source-element types shared by Docling, ingestion, retrieval, answers, and research in `domain/`.
- Keep embedding generation and embedding-space management in `embedding/`.
  Keep vector and keyword index storage in `retrieval/indexing/`.
- Keep Docling separate from `providers/` because it converts documents rather than providing a configurable model capability.
- Keep HHEM in `verification/` so claim-support verification stays separate from provider routing and search-result sufficiency.
- Keep offline evaluation code in [`tools/evaluation/`](../tools/evaluation/).
  Evaluation tools may import the production core, while production code stays independent of evaluation tooling.
- Preserve `web-server.ts`, `cli/index.ts`, and `database/migrate.ts` as stable executable entry points.

## Verification

Run the normal project checks.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm check` also validates the corpus and evaluation definitions before running this sequence.
