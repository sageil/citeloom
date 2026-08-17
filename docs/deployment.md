# Deployment

CiteLoom is designed to run on a private local network.
The supplied stack includes workspace sign-in, administrator roles, and local HTTPS through Caddy.

## Install from Docker Hub

Use `compose.dockerhub.yml` to run the published images.
Keep it in the repository with [`infra/caddy/Caddyfile`](../infra/caddy/Caddyfile) so the relative mount resolves correctly.

Clone the repository, create the untracked environment file, and choose the exact published release.

```bash
git clone https://github.com/sageil/citeloom.git
cd citeloom
cp .env.example .env
chmod 600 .env
```

Choose the first administrator credentials for a new database.
Migration runs continue to require both values, while an existing database keeps its stored accounts unchanged.
Use the same semantic version for the images and application release.

```dotenv
CITELOOM_ADMIN_USERNAME=Mayhem
CITELOOM_ADMIN_PASSWORD='replace-with-a-private-passphrase'
CITELOOM_IMAGE_TAG=1.1.2
CITELOOM_RELEASE=1.1.2
```

Pull and start the CiteLoom stack.

```bash
docker compose --env-file .env -f compose.dockerhub.yml pull
docker compose --env-file .env -f compose.dockerhub.yml up -d --wait
```

The stack pulls the application, PostgreSQL, Docling, and HHEM images from the `sageil` Docker Hub account.
Caddy uses the version pinned in the Compose file.
Model providers run separately.
Configure them from Settings after the application starts.

Open `https://localhost:3443` and sign in with the administrator account from `.env`.
See [Trust local HTTPS](#trust-local-https) if the browser does not trust the local certificate.

## Choose storage paths

Relative database and source-content paths resolve from the directory containing `compose.dockerhub.yml`.
Set absolute paths before the first start when persistent data belongs elsewhere.

```dotenv
CITELOOM_POSTGRES_DATA_DIRECTORY=/srv/citeloom/postgres
CITELOOM_SOURCE_CONTENT_HOST_DIRECTORY=/srv/citeloom/documents/blobs
```

When reusing existing data, verify both bind paths and back up PostgreSQL and source content together.

The default Compose deployment mounts the source directory at `/app/documents/blobs` in the migration, web, and worker containers.
Application processes stream verified source bytes to Docling, so Docling does not mount this directory.
Migration saves the filesystem configuration in PostgreSQL for application processes to use.

To move an existing source store to a different process-visible path, mount the new directory in the web and worker containers and use Settings > Object storage to test it and start the migration.
The background worker copies and hash-verifies every recorded source before changing the stored path.
It keeps the previous setting and content tree when validation fails.

The `source-content migrate --apply` command remains available for planned offline migration, but ordinary administrator changes should use the durable Settings workflow.

### Opt in to SeaweedFS

The optional `compose.seaweedfs.yml` overlay runs a pinned single-node SeaweedFS service and configures CiteLoom through its S3-compatible endpoint.
Set strong credentials in `.env` before the first start.
If independent CiteLoom environments use the same S3 service, give each environment a different bucket or key prefix.
All web and worker containers in one environment use the same storage location.
During orphan cleanup, one environment can delete an object that only the other environment has in its database when both environments use the same bucket and prefix.

For a fixed single-host example with two stateless S3 gateways behind Caddy, follow [Self-hosted SeaweedFS with Caddy](../deployments/examples/seaweedfs-caddy/README.md).
That example runs exactly three SeaweedFS containers and preserves the same internal S3 endpoint and data directory as this overlay.

```dotenv
CITELOOM_S3_ACCESS_KEY_ID=citeloom-admin
CITELOOM_S3_SECRET_ACCESS_KEY=replace-with-a-long-random-secret
CITELOOM_SEAWEEDFS_DATA_DIRECTORY=/srv/citeloom/seaweedfs
```

Start or update a source-build deployment with the overlay.

```bash
docker compose --env-file .env -f compose.yml -f compose.seaweedfs.yml up -d --build --wait
```

For a Docker Hub deployment, pull and start the selected application release with the overlay.

```bash
docker compose --env-file .env -f compose.dockerhub.yml -f compose.seaweedfs.yml pull
docker compose --env-file .env -f compose.dockerhub.yml -f compose.seaweedfs.yml up -d --wait
```

A new database uses SeaweedFS immediately and does not require a content migration.

#### Move an existing installation to SeaweedFS

An existing filesystem installation uses two different migrations.
The Compose `migrate` service first applies the database schema migration that records durable storage-migration jobs.
This schema migration preserves the active filesystem configuration and does not move or switch source content.
The administrator starts the separate content migration from Settings after the updated application is running.

1. Follow [Backup and restore](operations.md#backup-and-restore) to stop writers and create a backup containing PostgreSQL and the existing source files.
2. Set the SeaweedFS credentials and persistent data directory in `.env` as shown above.
3. Start the updated deployment with both its existing Compose file and `compose.seaweedfs.yml`, using the applicable command above.
4. Sign in as an administrator and open Settings > Object storage.
5. Confirm that Active storage still reports Local filesystem.
6. Select S3-compatible object storage and enter the bundled SeaweedFS connection values below.

| Setting | Value |
| --- | --- |
| Endpoint URL | `http://seaweedfs:8333` |
| Bucket | The value of `CITELOOM_SOURCE_CONTENT_S3_BUCKET`, or `citeloom` by default |
| Object key prefix | The value of `CITELOOM_SOURCE_CONTENT_S3_PREFIX`, or `sources` by default |
| Signing region | The value of `CITELOOM_SOURCE_CONTENT_S3_REGION`, or `us-east-1` by default |
| Credential source | Deployment environment |
| Use path-style URLs | Enabled |

7. Select Test connection and wait for confirmation that the target accepted a write and delete probe.
8. Select Start migration and confirm the requested migration.
9. Monitor the migration on the same page until its status is Completed and Active storage reports S3-compatible storage.

The base Compose service definitions keep the original filesystem mounted in the migration, web, and worker containers while the SeaweedFS overlay makes the target available.
The filesystem remains active for reads and writes while the worker copies and hash-verifies every registered source object.
The worker saves checkpoints in PostgreSQL, resumes after a restart or expired lease, and includes documents written while copying in its final verification.
After verification, CiteLoom changes the active storage setting to SeaweedFS and completes the migration record in one database transaction.

If the migration is cancelled or fails, the filesystem remains active and objects already copied to SeaweedFS are retained.
Cancellation is available until final cutover starts.
Correct the reported problem and start a new migration request when ready.

After a completed migration, the previous filesystem content remains available for a reverse migration but does not receive new writes or deletions.
Retain the old content and mount until the SeaweedFS deployment has been verified for the required recovery period.
Cleanup is a separate explicit operator action because CiteLoom never deletes the previous backend automatically.

#### Return to the local filesystem

Keep SeaweedFS running and keep the S3 environment values available until the reverse migration is complete.
The previous filesystem does not contain documents that CiteLoom added after the S3 cutover.

1. Confirm that the web and worker services still mount the local source directory at `/app/documents/blobs`.
2. Sign in as an administrator and open Settings > Object storage.
3. Select Local filesystem and set Directory to `/app/documents/blobs`.
4. Select Test connection and wait for the successful write and delete probe.
5. Select Start migration and confirm the request.
6. Wait until the migration status is Completed and Active storage reports Local filesystem.
7. Open a representative source document and confirm that its content is unchanged.

After this verification, stop the stack that includes `compose.seaweedfs.yml` and start the base stack without that overlay.
Retain the SeaweedFS data directory for the required recovery period because CiteLoom does not delete the previous S3 objects.

The durable migration and recovery details are documented in [Migrate source-content storage](operations.md#migrate-source-content-storage).

Stop a Docker Hub stack without deleting its bind-mounted data.

```bash
docker compose --env-file .env -f compose.dockerhub.yml -f compose.seaweedfs.yml down
```

For a source-build deployment, replace `compose.dockerhub.yml` with `compose.yml`.

## Build and run locally

Prepare `.env`, the initial administrator, and storage paths as described in [Install from Docker Hub](#install-from-docker-hub).

Build and start the complete stack from the repository root.

```bash
docker compose up -d --build --wait
```

Docker Compose builds and starts the HTTPS, web, worker, PostgreSQL, Docling, and HHEM services.
The migration service creates the database schema and initial administrator before the web application and worker start.
Caddy generates and retains its local certificate authority and HTTPS certificate under the ignored `data/caddy` directory.

The first build may take several minutes while Docker downloads images and model assets.
When the command finishes, CiteLoom is ready at `https://localhost:3443`.

### Resume or reconcile the stack

After an interruption, fix the reported problem and run the same Compose command again.
Docker Compose preserves bind-mounted data and reconciles services with the declared configuration.

Validate the resolved configuration without changing containers.

```bash
docker compose config --quiet
```

The endpoint at `http://localhost:3080` redirects to HTTPS.

## Trust local HTTPS

The supplied Caddy service creates a private local certificate authority for `https://localhost:3443`.
Use the browser's trust or continue flow for an isolated local installation.
Caddy stores the root certificate at `data/caddy/caddy/pki/authorities/local/root.crt` for browsers or operating systems that require manual certificate import.
Keep `data/caddy` private and persistent because it contains the local certificate authority keys.
Reusing that directory preserves the browser trust established for its certificate authority.

Docker web replicas listen only on internal port 3000.
The HTTPS proxy uses Docker DNS to discover replicas, distributes new requests across them, and temporarily avoids replicas that fail.
Scale the web service through the proxy rather than publishing a host port for each replica.

```bash
docker compose up -d --wait --scale web=3
```

Stop all local services without deleting their persistent data.

```bash
docker compose down
```

## Publishing Docker Hub images

The manually dispatched `Build and push CiteLoom images` GitHub Actions workflow publishes the application, PostgreSQL, Docling, and HHEM images.
The workflow uses QEMU and Buildx to publish multi-platform images after validating the release inputs.

Before the first publication:

- Configure the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` GitHub Actions repository secrets.
- Run `pnpm release:version <version>` to update `package.json` and all derived release values.
- Run `pnpm release:check` to confirm that all derived release values match `package.json`.
- Commit the complete release source to the default branch.

Run the workflow with `dry_run` enabled first.
The dry run validates the source branch, synchronized semantic version, unused Git tag, and Dockerfile paths without logging into Docker Hub, building images, or publishing tags.

For publication, disable `dry_run`.
The workflow confirms that the requested semantic-version tags are unpublished, then builds and pushes each exact version tag for `linux/amd64` and `linux/arm64`.
After every remote manifest confirms both required platforms, the workflow points each repository's `latest` tag to the same verified image without rebuilding it.
The workflow then creates the `v<version>` Git tag at the workflow commit and publishes a stable GitHub Release with generated release notes.
Publication completes only after every `latest` tag resolves to the same image digest as its exact version tag and the GitHub Release is verified.

Releases use exact semantic-version tags, with the same `CITELOOM_IMAGE_TAG` applied to all four images.
The workflow treats those version tags as immutable and prevents them from being overwritten.
The `latest` tags are mutable pointers for users who want the newest verified release, while the supplied Compose configuration remains pinned to an exact version by default.
If a run stops after publishing only some version tags, fix the cause and use GitHub's **Re-run failed jobs** action on the original run so every retried build uses the original commit.
If a run stops while updating `latest`, use the same action to safely finish pointing all four repositories to the verified release.
If the release job stops after creating its Git tag or GitHub Release, use the same action to verify and finish the release from the original commit.
The release job accepts an existing release only when its tag points to that commit.
Existing exact-version deployments remain unchanged during a partial publication.

## Configure a production proxy

Set Public origins, Secure session cookie, and Trust reverse proxy on the Web server Settings page for the deployed origins and proxy path.
Put the canonical public origin first in the list.
Restart the web service after saving these values.
Keep secure cookies enabled outside isolated automated tests.
Enable trusted-proxy mode only when a trusted proxy replaces forwarded client headers, as the supplied Caddy service does.
Internet-facing deployments need production TLS, network access controls, and an availability design beyond the supplied local setup.

## Administrator bootstrap

The initial password entered during installation must contain between 15 and 1,024 characters.

For a new database, the data bootstrap creates the active administrator and a `CiteLoom` workspace in the same transaction.
The password is stored as an Argon2id hash.
For an existing database, the bootstrap confirms that an active administrator with a password credential exists.
It leaves existing users and password hashes unchanged.
The migration command still requires both environment variables, but it does not use them to authenticate or replace an existing administrator.

Authentication stores session data in PostgreSQL and uses a host-only cookie with `Secure`, `HttpOnly`, and `SameSite=Strict`.
Regular sessions expire after 2 hours of inactivity or 12 hours in total.
Remembered sessions expire after 7 days of inactivity or 30 days in total.
Administrator-created setup and password-reset links expire after 24 hours and are consumed when the user sets a password.
The database-owned Public origins list contains the origins that can make state-changing browser requests.
The first entry is the canonical origin for OAuth and MCP URLs.
When OAuth is active, the browser moves from another listed origin to the canonical origin before sign-in.

Workspace members can use document, ingestion, reindexing, search, and research APIs.
Workspace administrators can also manage membership, settings, and diagnostics.
Every workspace must retain at least one active administrator.

Configure provider tokens through the application Settings page.
Provider credentials are stored in PostgreSQL.
Protect the database and every backup as you would protect a credentials file.

## Deployment checklist

- Verify exact model identifiers and all service URLs with `pnpm run doctor:docker`.
- Use the migration service before starting the new application version.
- Run web and worker processes with the same production configuration.
- Keep PostgreSQL and the source content store on persistent volumes.
- Terminate TLS and enforce network access outside CiteLoom.
- Back up PostgreSQL and source content together before schema changes or retention operations.
- Confirm worker health and queue progress after deployment.
