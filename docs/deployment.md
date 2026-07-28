# Deployment

CiteLoom is designed to run on a private local network.
The supplied stack includes workspace sign-in, administrator roles, and local HTTPS through Caddy.
Internet-facing deployments need their own production TLS, network access policy, and availability design.

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
CITELOOM_IMAGE_TAG=0.1.1
CITELOOM_RELEASE=0.1.1
```

Pull and start the CiteLoom stack.

```bash
docker compose --env-file .env -f compose.dockerhub.yml pull
docker compose --env-file .env -f compose.dockerhub.yml up -d --wait
```

The stack pulls the application, PostgreSQL, Docling, and HHEM images from the `sageil` Docker Hub account.
Caddy uses the version pinned in the Compose file.
Model providers run separately.
A fresh database points the required routes to LM Studio and leaves reranking and speech ready for the administrator to configure.

Open `https://localhost:3443`.
If the browser warns about the local development certificate, use its trust or continue flow for this local site.

### Choose storage paths

Relative database and source-content paths resolve from the directory containing `compose.dockerhub.yml`.
Set absolute paths before the first start when persistent data belongs elsewhere.

```dotenv
CITELOOM_POSTGRES_DATA_DIRECTORY=/srv/citeloom/postgres
CITELOOM_SOURCE_CONTENT_HOST_DIRECTORY=/srv/citeloom/documents/blobs
```

When reusing existing data, verify both bind paths and back up PostgreSQL and source content together.
The path guard described under [Local installer recovery](operations.md#local-installer-recovery) applies to the local build installer.

Stop the stack without deleting its bind-mounted data.

```bash
docker compose --env-file .env -f compose.dockerhub.yml down
```

## Build and install locally

Run the installer from the repository root.
The host needs Bash, Docker Compose, and curl.

```bash
./infra/scripts/install-local.sh
```

The installer:

- Creates `.env` from `.env.example` when the file is absent.
- Asks for the administrator credentials required by migrations and saves them in the untracked `.env` file.
- Uses `data/citeloomdb` for PostgreSQL by default.
- Starts Caddy, which generates and retains its local certificate authority and HTTPS certificate under the ignored `data/caddy` directory.
- Builds and starts the HTTPS, web, worker, PostgreSQL, Docling, and HHEM services.
- Creates the database schema and initial administrator before starting the web application and worker.
- Reports success only after migration, container health, and `https://localhost:3443` are verified.

The first build may take several minutes while Docker downloads images and model assets.
When the command finishes, CiteLoom is ready at `https://localhost:3443`.

### Resume an installation

After an interruption, fix the reported problem and run the installer again.
It resumes from the saved state while keeping the database and containers available for diagnosis.
See [Local installer recovery](operations.md#local-installer-recovery) for data-directory checks and recovery behavior.

To check prerequisites, configuration, storage paths, and installer state without changing anything, run:

```bash
./infra/scripts/install-local.sh --check
```

Open `https://localhost:3443` after installation.
The endpoint at `http://localhost:3080` redirects to HTTPS.
If the browser reports an untrusted certificate, use its trust or continue flow for this local site.
Caddy stores the root certificate at `data/caddy/caddy/pki/authorities/local/root.crt` for browsers or operating systems that require manual certificate import.
Keep `data/caddy` private and persistent because it contains the local certificate authority keys.
Reusing that directory preserves the browser trust established for its certificate authority.

Docker web replicas listen only on internal port 3000.
The HTTPS proxy uses Docker DNS to discover replicas, distributes new requests across them, and temporarily avoids replicas that fail.
Scale the web service through the proxy rather than publishing a host port for each replica.

```bash
./infra/compose.sh --profile https --profile worker up -d --wait --scale web=3
```

Stop all local services without deleting their persistent data.

```bash
./infra/compose.sh --profile https --profile worker down
```

## Publishing Docker Hub images

The manually dispatched `Build and push CiteLoom images` GitHub Actions workflow publishes the application, PostgreSQL, Docling, and HHEM images.
The workflow follows the same QEMU, Buildx, Docker Hub login, semantic-version validation, and dry-run approach as the `crewai-docker-image` release workflow.

Before the first publication:

- Configure the `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` GitHub Actions repository secrets.
- Set the same semantic version in `package.json` and every `CITELOOM_IMAGE_TAG` and `CITELOOM_RELEASE` default in `compose.dockerhub.yml`.
- Commit the complete release source to the default branch.

Run the workflow with `dry_run` enabled first.
The dry run validates the source branch, semantic version, Compose release defaults, and Dockerfile paths without logging into Docker Hub, building images, or publishing tags.

For publication, disable `dry_run`.
The workflow confirms that the requested semantic-version tags are unpublished, then builds and pushes each exact version tag for `linux/amd64` and `linux/arm64`.
Publication completes after each remote manifest confirms both required platforms.

Releases use immutable semantic-version tags, with the same `CITELOOM_IMAGE_TAG` applied to all four images.
The workflow protects existing version tags from being overwritten.
If a run stops after publishing only some version tags, fix the cause and use GitHub's **Re-run failed jobs** action on the original run so every retried build uses the original commit.
Existing exact-version deployments remain unchanged during a partial publication.

## Configuration and storage

The default Compose bind mount resolves to `data/citeloomdb` under the directory containing the Compose file.
Override it in `.env` with an absolute bind path or a path relative to that directory.

```dotenv
CITELOOM_POSTGRES_DATA_DIRECTORY=./data/citeloomdb
```

Compose stores unmodified source files under `CITELOOM_SOURCE_CONTENT_HOST_DIRECTORY`, which defaults to `documents/blobs` under the same directory.
The installer creates that host directory and mounts it at `/app/documents/blobs` in the migration, web, worker, and Docling containers.
Docling mounts it read-only and accepts content IDs instead of uploaded document bytes.
Migration bootstrap stores `/app/documents/blobs` in `application_settings`, and application processes read the path from there.

To move the source store outside the supplied Compose setup:

1. Stop every web, worker, and Docling process.
2. Copy the complete `sha256` content tree to the new shared directory.
3. Mount that directory read-only at the same absolute path in every Docling instance.
4. Set `CITELOOM_SOURCE_CONTENT_DIRECTORY` to the path visible to the process running the migration.
5. Run the migration.

The migration checks every recorded source document before changing the database setting.
The previous directory remains intact.

Set `CITELOOM_PUBLIC_ORIGIN`, `CITELOOM_SECURE_SESSION_COOKIE`, and `CITELOOM_TRUST_PROXY` for your proxy setup.
Place Fastify behind a trusted production proxy for public deployments.

## Administrator bootstrap

Set `CITELOOM_ADMIN_USERNAME` and `CITELOOM_ADMIN_PASSWORD` in the untracked environment file before running migrations.
Use a password between 15 and 1,024 characters.

```dotenv
CITELOOM_ADMIN_USERNAME=Mayhem
CITELOOM_ADMIN_PASSWORD='replace-with-a-private-passphrase'
```

For a new database, the first migration creates the active administrator and a `CiteLoom` workspace in the same transaction.
The password is stored as an Argon2id hash.
For an existing database, the bootstrap confirms that an active administrator with a password credential exists.
It leaves existing users and password hashes unchanged.
The migration command still requires both environment variables, but it does not use them to authenticate or replace an existing administrator.

Authentication stores session data in PostgreSQL and uses a host-only cookie with `Secure`, `HttpOnly`, and `SameSite=Strict`.
`CITELOOM_PUBLIC_ORIGIN` is the required origin for state-changing browser requests.
Keep `CITELOOM_SECURE_SESSION_COOKIE=true` outside isolated automated tests.
Set `CITELOOM_TRUST_PROXY=true` only when a trusted proxy replaces forwarded client headers, as the included Caddy service does.

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
