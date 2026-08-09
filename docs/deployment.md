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
CITELOOM_IMAGE_TAG=0.2.3
CITELOOM_RELEASE=0.2.3
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

Compose mounts the source directory at `/app/documents/blobs` in the migration, web, worker, and Docling containers.
Docling receives a read-only mount and reads stored sources by content ID.
Migration saves the container path in PostgreSQL for application processes to use.

To move an existing source store to a different process-visible path:

1. Stop every web, worker, and Docling process.
2. Copy the complete `sha256` content tree to the new shared directory.
3. Mount that directory read-only at the same absolute path in every Docling instance.
4. Set `CITELOOM_SOURCE_CONTENT_DIRECTORY` to the path visible to the migration process.
5. Run the migration.

The migration checks every recorded source before changing the stored path.
It keeps the previous setting when validation fails.

Stop the stack without deleting its bind-mounted data.

```bash
docker compose --env-file .env -f compose.dockerhub.yml down
```

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
- Set the same semantic version in `package.json` and every `CITELOOM_IMAGE_TAG` and `CITELOOM_RELEASE` default in `compose.dockerhub.yml`.
- Commit the complete release source to the default branch.

Run the workflow with `dry_run` enabled first.
The dry run validates the source branch, semantic version, Compose release defaults, and Dockerfile paths without logging into Docker Hub, building images, or publishing tags.

For publication, disable `dry_run`.
The workflow confirms that the requested semantic-version tags are unpublished, then builds and pushes each exact version tag for `linux/amd64` and `linux/arm64`.
After every remote manifest confirms both required platforms, the workflow points each repository's `latest` tag to the same verified image without rebuilding it.
Publication completes only after every `latest` tag resolves to the same image digest as its exact version tag.

Releases use exact semantic-version tags, with the same `CITELOOM_IMAGE_TAG` applied to all four images.
The workflow treats those version tags as immutable and prevents them from being overwritten.
The `latest` tags are mutable pointers for users who want the newest verified release, while the supplied Compose configuration remains pinned to an exact version by default.
If a run stops after publishing only some version tags, fix the cause and use GitHub's **Re-run failed jobs** action on the original run so every retried build uses the original commit.
If a run stops while updating `latest`, use the same action to safely finish pointing all four repositories to the verified release.
Existing exact-version deployments remain unchanged during a partial publication.

## Configure a production proxy

Set `CITELOOM_PUBLIC_ORIGIN`, `CITELOOM_SECURE_SESSION_COOKIE`, and `CITELOOM_TRUST_PROXY` for the deployed origin and proxy path.
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
`CITELOOM_PUBLIC_ORIGIN` is the required origin for state-changing browser requests.

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
