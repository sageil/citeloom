# pnpm commands

This page describes every pnpm script declared in [`package.json`](../package.json).
Run a script with `pnpm <script>`, followed by any arguments the command accepts.

## Application scripts

| Script | Purpose |
| --- | --- |
| `ask` | Ask CiteLoom a question from the development command line. |
| `dev` | Run the general development command-line entry point. |
| `dev:web` | Start the web server from source and restart it when source files change. |
| `documents` | List indexed documents. |
| `ingest` | Add documents to CiteLoom. |
| `jobs` | Retry an ingestion job. |
| `status` | Show application and service status. |
| `web` | Build and start the production web server. |
| `worker` | Run the ingestion worker from source. |
| `worker:production` | Run the compiled production ingestion worker. |

### Command-line subcommands

Run `pnpm dev --help` for the complete command syntax.

| Command | Purpose |
| --- | --- |
| `pnpm dev ask [scope] -- <question>` | Ask a question from an explicit document scope. |
| `pnpm dev doctor` | Check the database, migrations, extensions, and configured services. |
| `pnpm dev documents list` | List documents, jobs, and embedding spaces. |
| `pnpm dev ingest [options] <path>` | Ingest files or directories immediately or enqueue them. |
| `pnpm dev jobs retry --file <path>` | Retry the failed job for a stored source path. |
| `pnpm dev status` | Show queue, worker, retry, and provider-request capacity. |
| `pnpm dev worker [--once]` | Process queued ingestion work continuously or for one pass. |
| `pnpm dev document-toc backfill` | Build missing document-heading maps from stored elements. |
| `pnpm dev embedding-spaces pin --space <id> --reason <reason>` | Protect an embedding space from retention cleanup. |
| `pnpm dev embedding-spaces unpin --space <id>` | Remove that retention protection. |
| `pnpm dev embedding-spaces gc ...` | Preview, apply, or resume embedding-space cleanup. |

Use [Operations](operations.md) for the document-heading backfill and embedding-space retention procedures.

## Build and code quality

| Script | Purpose |
| --- | --- |
| `build` | Run the production server build. |
| `build:server` | Create the production server output in `dist/`. |
| `check` | Validate corpus and evaluation files, lint the code, check types, run isolated tests, and build the production server. |
| `lint` | Check the code with Biome. |
| `lint:fix` | Apply fixes supported by Biome. |
| `typecheck` | Check TypeScript types without generating files. |

## Database commands

| Script | Purpose |
| --- | --- |
| `db:generate` | Generate the Drizzle database migration from the schema. |
| `db:migrate` | Apply migrations using the development configuration. |
| `db:migrate:production` | Apply migrations using the compiled production code. |
| `db:reset:development` | Delete and recreate the guarded local `citeloom` development database. |
| `db:setup` | Apply development database migrations. |

`db:reset:development` permanently deletes the records in the local development database.
It refuses production mode, non-local database hosts, and database names other than `citeloom`.
It does not delete files under `documents/`.

## Services and operations

| Script | Purpose |
| --- | --- |
| `backup` | Back up the CiteLoom database and source files. |
| `restore` | Restore a CiteLoom backup. |
| `doctor:docker` | Check the database, migrations, extensions, and configured services from Docker. |
| `doctor:source` | Run the same diagnostic checks from the source environment. |
| `services:up` | Start the local Compose services. |
| `services:down` | Stop the local Compose services. |
| `services:logs` | Follow logs from the local Compose services. |
| `services:test:up` | Recreate and start a clean temporary test PostgreSQL service. |
| `services:test:stop` | Stop the temporary test PostgreSQL service. |

## Offline evaluation and corpus tools

| Script | Purpose |
| --- | --- |
| `corpus:download` | Download documents used by the evaluation corpus. |
| `corpus:reconcile` | Reconcile the indexed database with the selected evaluation corpus. |
| `docling:benchmark` | Benchmark Docling document processing. |
| `evaluate` | Run evaluation preparation, scoring, tuning, or reporting commands. |
| `evaluate:generate` | Generate an evaluation dataset. |
| `probe:answer-draft:lm-studio` | Probe answer generation through LM Studio. |
| `probe:answer-draft:ollama` | Probe answer generation through Ollama. |
| `probe:query-application` | Probe the retrieval and answer application path with the development environment. |
| `probe:query-application:chat` | Run the saved Chat application probe with `.env`. |
| `probe:query-application:question` | Run the saved Ask application probe with `.env`. |
| `validate:corpus` | Validate evaluation corpus files and metadata. |
| `validate:evaluations` | Validate evaluation datasets and artifacts. |
| `validate:evaluations:live` | Compare evaluation datasets with the currently indexed corpus. |
| `validate:benchmark` | Run all corpus and evaluation validation commands. |

Evaluation commands are offline tools.
They use production application components but are not included in the production server build.

## Tests

| Script | Purpose |
| --- | --- |
| `test` | Run the regular unit-test subset. |
| `test:all` | Run all isolated tests, including offline evaluation, corpus, and command-line tests. |
| `test:backup-restore` | Test the complete backup and restore workflow. |
| `test:coverage` | Run the GitHub-compatible unit and contract suite with production-source coverage thresholds. |
| `test:integration` | Run the database and authentication integration tests. |
| `test:live` | Run the test that uses the live HHEM service. |
| `test:watch` | Run Vitest continuously while files change. |

`test:live` calls a live model service and is not repeatable unit-test coverage.
`test:coverage` does not run corpus, database integration, Docker, live-model, or browser-automation tests.
