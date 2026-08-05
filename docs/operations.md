# Operations

CiteLoom keeps its database definition in three places:

- [`src/database/schema.ts`](../src/database/schema.ts) declares the schema.
- [`drizzle/`](../drizzle/) contains the complete greenfield migration and initial data setup.
- [`queries/`](../queries/) contains SQL used while the application runs.

## Clean setup

Create a complete local Compose installation with one command.

```bash
./infra/scripts/install-local.sh
```

`0000_citeloom_schema.sql` creates the complete schema, required extensions, database functions, and triggers in one migration.
It does not replay earlier development changes.
`bootstrap.sql` then creates the required reference data and settings.
When the database has no users, it creates the first administrator from `CITELOOM_ADMIN_USERNAME` and `CITELOOM_ADMIN_PASSWORD`.
When users already exist, it confirms that an active administrator has a password credential and leaves the stored authentication data unchanged.

## Migrations

During greenfield development, regenerate `0000_citeloom_schema.sql` from `src/database/schema.ts`, then restore and verify the hand-authored extension, function, and trigger definitions that Drizzle does not generate.
Do not keep historical development migrations.
Keep `bootstrap.sql` as the single rerunnable data bootstrap for application defaults, database-owned configuration, and the initial administrator.

```bash
pnpm db:generate
pnpm db:migrate
```

Production builds load `.env` and use the production migration command.

```bash
pnpm db:migrate:production
```

## Backup and restore

Before creating a backup, stop every writer so the database and source files represent the same point in time.

```bash
./infra/compose.sh stop web worker
```

Create a backup that contains both a PostgreSQL dump and the source files.

```bash
pnpm backup
```

The command stops if the Compose web or worker service is still active.
It writes `backups/citeloom-<timestamp>.backup` by default.

Restore requires the web and worker services to remain stopped.
The restore command replaces matching database objects and source files.
Before doing so, it creates a temporary database dump that can be used for rollback and asks for explicit confirmation.

```bash
pnpm restore --confirm backups/citeloom-YYYYMMDDTHHMMSSZ.backup
```

Compose PostgreSQL data is stored under `data/citeloomdb` by default and remains when Compose services stop.
Set `CITELOOM_POSTGRES_DATA_DIRECTORY` in `.env` before the first install to use a different bind-mounted directory.
Compose source content is stored under `documents/blobs` by default.
Set `CITELOOM_SOURCE_CONTENT_HOST_DIRECTORY` in `.env` before installation to use a different bind-mounted directory.
The installer stops writers before migration, creates and validates the selected host directory, and preserves the old directory if migration validation fails.

## Local installer recovery

The installer records its progress in the ignored `data/local-install.state` file.
A first installation moves through `unconfigured`, `configured`, and `starting`.
It reaches `ready` only after the migration, service health checks, and HTTPS check succeed.
Running the installer again safely starts a new attempt from any saved state.
After a failure, the state remains `starting`, and the database and containers remain available for diagnosis and retry.

Validate the current configuration and state without changing the deployment.

```bash
./infra/scripts/install-local.sh --check
```

After recording `ready`, the installer refuses to continue if the data directory is missing or empty.
If an interactive installation finds a nonempty PostgreSQL directory it does not recognize, it shows the exact path and asks you to type `RESET`.
After confirmation, it stops database writers, moves the existing directory to a timestamped recovery path, creates an empty directory, and continues.
Check mode and noninteractive installation never change an unrecognized directory.
A configured directory that does not match the saved installer state is always rejected.
Recovery moves old PostgreSQL data but never permanently deletes it.

## Reindexing

Document TOC routing does not require reindexing existing documents.
After enabling `Document TOC routing`, populate missing maps from stored document elements with:

```bash
pnpm dev document-toc backfill
```

For the supplied container deployment, run:

```bash
./infra/compose.sh --profile worker run --rm --no-deps worker node dist/cli/index.js document-toc backfill
```

The command applies to documents in the active embedding space and is safe to rerun after interruption.
It skips completed generations and does not rerun Docling or embeddings.

Use the document catalog to reindex a document.
A document's current version stays searchable during an ordinary reindex.
The background worker processes queued jobs.
Monitor progress with `pnpm status` or the worker logs.

Use the document controls in the web application to reindex after changing the embedding model, dimensions, input format, retrieval-window policy, or any setting that changes how searchable content is constructed.
The source filename remains the document's catalog identity, while CiteLoom reads the file itself from the content store.
Files supported by Docling are converted again.
Plain-text files are split, prepared for search, embedded, and indexed without Docling.
Each completed job replaces the previous search index in one database operation.
After selecting a different embedding configuration, answers are unavailable until documents are reindexed.
The previous configuration is not kept searchable.
Settings and answer requests explain when reindexing is required.

```bash
docker logs --follow citeloom-worker-1
```

## Embedding-space retention

Before removing old embedding spaces, pin every space you may need for rollback.

```bash
pnpm dev embedding-spaces pin --space <space-id> --reason "known-good rollback"
```

Preview the retention cleanup before applying it.

```bash
pnpm dev embedding-spaces gc --retention-days 30 --dry-run
pnpm dev embedding-spaces gc --retention-days 30 --apply
```

CiteLoom protects the active space, pinned spaces, spaces used by ingestion jobs, and spaces newer than the retention limit.
It removes each eligible space in one database transaction, including its vector rows, keyword rows, document links, and metadata.

Resume an interrupted cleanup with its saved run ID.

```bash
pnpm dev embedding-spaces gc --resume <run-id> --apply
```

The estimated size covers stored table rows.
It excludes PostgreSQL index overhead because that space cannot be assigned exactly to one embedding space.

## Health, diagnostics, and error reports

Open System health to inspect the current application state, configured models, provider and worker capacity, scheduling telemetry, and recent AI request metrics when they are enabled.
The page reads the saved runtime snapshot without contacting every provider.
Choose Run diagnostics as an administrator to check the configured database, document service, claim verifier, and provider model availability without model inference.
Model-response, speech, and reranking probes are optional live tests that must be selected explicitly and can consume provider credits or local compute.

Open Error reports as an administrator to review sanitized failures recorded in PostgreSQL.
The screen separates ingestion, application, and general failures and exposes request, run, job, document, task, release, retry, and Docling context when the event contains it.
The stored messages are diagnostic records and are separate from Docker container output.

Choose Purge logs to remove the operational error rows visible to the current workspace.
CiteLoom shows a confirmation dialog before sending the deletion request.
The purge includes global operational rows visible in that workspace and cannot be undone through the application.
It does not truncate Docker, systemd, or other host process logs.

CiteLoom also enforces age and row-count retention in the background.
Configure those limits with `CITELOOM_APPLICATION_ERROR_RETENTION_DAYS` and `CITELOOM_APPLICATION_ERROR_MAXIMUM_ROWS` before starting the web process.
The cleanup runs in bounded batches under a PostgreSQL advisory lock so multiple web processes do not perform the same retention work concurrently.

AI request diagnostics and Docling conversion diagnostics are separate settings.
AI diagnostics record request timing and usage without saving questions or answers.
Docling conversion diagnostics record conversion timing and outcomes without saving document content and have their own retention period in Settings.

## Routine checks

Check configured dependencies and database readiness.

```bash
pnpm run doctor:docker
pnpm status
```

Investigate failed jobs before retrying them.
Retries resume from the saved phase unless changed conversion settings require discovery to run again.

```bash
pnpm jobs retry --file <stored-source-file>
```

Treat cancellation and unexpected service failures as operational errors.
Do not report them as a successful uncited response or a completed ingestion.
