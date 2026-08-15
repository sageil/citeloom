# Operations

This guide covers maintenance and recovery for an existing CiteLoom deployment.
Use [Deployment](deployment.md) for installation and [Configuration](configuration.md) for settings.

## Apply migrations

Run migrations before starting a new application version.
The migration applies the schema and reruns the database bootstrap without replacing existing accounts or saved credentials.

Use the development command from a source checkout:

```bash
pnpm db:migrate
```

Production builds load `.env` and use the production migration command.

```bash
pnpm db:migrate:production
```

The schema source is `src/database/schema.ts`, the greenfield migration is `drizzle/0000_citeloom_schema.sql`, and `drizzle/bootstrap.sql` owns initial reference data and settings.
Contributors changing these files should follow the database workflow in [Contributing](../CONTRIBUTING.md).

## Backup and restore

Before creating a backup, stop the web and worker services and do not run commands that change the database or source files.

```bash
docker compose stop web worker
```

Create a backup that contains both a PostgreSQL dump and the source files.

```bash
pnpm backup
```

The command stops if the Compose migration, web, or worker service is still active.
It writes `backups/citeloom-<timestamp>.backup` by default.
For SeaweedFS deployments, run the scripts with the same Compose overlay so the one-off exporter has the S3 endpoint and credentials.

```bash
COMPOSE_FILE=compose.yml:compose.seaweedfs.yml pnpm backup
```

Restore requires the migration, web, and worker services to remain stopped.
The restore command replaces matching database objects and source files.
Before doing so, it creates a temporary database dump that can be used for rollback and asks for explicit confirmation.

```bash
pnpm restore --confirm backups/citeloom-YYYYMMDDTHHMMSSZ.backup
```

Use the same `COMPOSE_FILE` value when restoring a SeaweedFS backup.
The restore imports and verifies content-addressed objects before reporting success, and a failed import restores the previous database dump.

After backup or restore completes, start the stopped services and confirm that the web application, worker, document catalog, and a retained source file are available.
Storage path selection belongs to the [deployment procedure](deployment.md#choose-storage-paths).

## Migrate source-content storage

Open Settings > Object storage as an administrator to change between a mounted filesystem and S3-compatible storage such as SeaweedFS.
Test the target connection before starting the migration.
Only one migration can be active, and CiteLoom keeps the current backend active while the worker copies and verifies content-addressed objects.
The worker saves progress in PostgreSQL and resumes an interrupted migration after its lease expires.
Documents written while the copy is running are copied during final verification under the cutover lock.
The active configuration and completed migration record change in one database transaction.

Cancellation is available until final cutover starts.
A cancelled or failed migration leaves the current backend active and retains any objects already copied to the target.
A completed migration retains the previous backend, but new writes and deletions are not mirrored there.
Reverse migration is the rollback path; cleanup of the old backend is a separate explicit operation.

Static S3 credentials entered through Settings are never returned by the API, but they are stored in PostgreSQL and included in database backups.
Deployment environment credentials must be present in every web, worker, migration, backup, and restore process that accesses the S3 backend.

## Compose recovery

Validate the current configuration without changing the deployment.

```bash
docker compose config --quiet
```

Inspect service state and logs after a failed start.

```bash
docker compose ps
docker compose logs migrate web worker
```

After correcting the configuration or dependency failure, rerun the normal `docker compose up` command.
Do not change persistent database or source-content paths when resuming an existing deployment.

## Recover local authentication

Before activating OAuth, a global administrator must enable Host recovery under Security > Authentication.
The setting is stored in PostgreSQL, must remain enabled while OAuth is active, and is not controlled by a new environment variable.

If the authorization server is unavailable, inspect the current authentication mode from a source checkout without changing it:

```bash
pnpm dev auth recover-local
```

For the supplied container deployment, run the report from the application host with the existing worker service database configuration:

```bash
docker compose run --rm --no-deps worker node dist/cli/index.js auth recover-local
```

When recovery is available and OAuth is active, the report ends with `Recovery would switch authentication to local mode. Run with --apply to continue.`
If it reports `Host recovery: disabled`, do not apply the command because the required recovery control was not enabled before the outage.
Restore authorization-server access so a global administrator can enable the control before any later OAuth activation.

Apply the switch to local authentication only after reviewing the report:

```bash
docker compose run --rm --no-deps worker node dist/cli/index.js auth recover-local --apply
```

The apply operation contacts only PostgreSQL and completes the mode change, OAuth configuration staging, settings-version increment, local-session deletion, and recovery audit event in one transaction.
It does not change usernames, passwords, memberships, or identity links, and it does not restore or create a session.
After recovery, every user signs in normally with a CiteLoom username and password.
Successful recovery ends with `Authentication recovered to local mode. Users can now sign in with their CiteLoom username and password.`
Rerun the report command and verify that it shows `Authentication mode: local` and `No recovery is required.`
If the apply command fails, use its error ID to inspect the application logs, resolve the recorded cause, and rerun the report because the transactional operation does not leave a partially committed mode change.

## Update document heading routes

The `Use document headings in search` setting does not require reindexing existing documents.
After enabling it, populate missing maps from stored document elements with:

```bash
pnpm dev document-toc backfill
```

For the supplied container deployment, run:

```bash
docker compose run --rm --no-deps worker node dist/cli/index.js document-toc backfill
```

The command applies to documents in the active embedding space and is safe to rerun after interruption.
It skips completed maps and does not rerun Docling or embeddings.

## Reindex documents

Use the document catalog to reindex a document.
A document's current version stays searchable during an ordinary reindex.
The background worker processes queued jobs.
Monitor progress with `pnpm status` or the worker logs.

Use the document controls in the web application to reindex after changing the embedding model, dimensions, search text format, document section method, search-index name, or another setting that changes searchable content.
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
Configure those limits under Usage diagnostics in Settings.
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
