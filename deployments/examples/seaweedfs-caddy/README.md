# Self-hosted SeaweedFS with Caddy

Use this example to place two stateless SeaweedFS S3 gateways behind Caddy while keeping source content in one local SeaweedFS data directory.
The deployment runs exactly three SeaweedFS containers: one `weed mini` core and two `weed s3` gateways.
It does not automatically add or remove replicas.

This is a single-host availability and gateway-load-balancing example.
It does not protect source content from host or disk failure, and it does not provide master, filer, or volume-server high availability.

## Understand the topology

```text
CiteLoom
   |
   v
Caddy: seaweedfs:8333
   |
   +--> seaweedfs-s3-a:8333
   +--> seaweedfs-s3-b:8333
                 |
                 v
        seaweedfs-core:8888
          master + filer + volume server
                 |
                 v
       CITELOOM_SEAWEEDFS_DATA_DIRECTORY
```

Caddy retains the internal hostname `seaweedfs`, so CiteLoom continues to use `http://seaweedfs:8333`.
The S3 gateways authenticate requests and translate the S3 API to filer operations, but they do not store object data.
The `seaweedfs-core` container stores source bytes and SeaweedFS metadata under `/data`, which is bind-mounted from `CITELOOM_SEAWEEDFS_DATA_DIRECTORY`.
The example does not enable SeaweedFS SSE-S3 encryption on the standalone gateways.
Use encrypted host storage when source content requires encryption at rest, or configure and manage a shared SeaweedFS SSE key separately.

## Prerequisites

- Run the commands from the CiteLoom repository root.
- Install Docker with Docker Compose.
- Prepare the repository-root `.env` file as described in [`docs/deployment.md`](../../../docs/deployment.md).
- Give each CiteLoom database an exclusive bucket and object-key prefix.
- Back up PostgreSQL and source content before replacing an existing storage deployment.

Use this example instead of `compose.seaweedfs.yml`.
Never pass both SeaweedFS overlays to the same Compose command.

## Configure the deployment

Copy the values from [`.env.example`](.env.example) into the repository-root `.env` file.
Replace both credential placeholders with private values before starting the deployment.

```dotenv
CITELOOM_S3_ACCESS_KEY_ID=replace-with-a-private-access-key
CITELOOM_S3_SECRET_ACCESS_KEY=replace-with-a-long-random-secret
CITELOOM_SEAWEEDFS_DATA_DIRECTORY=/srv/citeloom/seaweedfs
```

The example publishes the Caddy-balanced S3 endpoint on `127.0.0.1:8333` and the SeaweedFS master diagnostics endpoint on `127.0.0.1:9333`.
Change `CITELOOM_SEAWEEDFS_S3_PORT` or `CITELOOM_SEAWEEDFS_MASTER_PORT` only when those host ports are already occupied.
CiteLoom containers always connect through the internal endpoint `http://seaweedfs:8333`.

Compose resolves bind-mounted files relative to the first Compose file.
When that file is outside the repository root, set `CITELOOM_SEAWEEDFS_CADDYFILE` to the absolute path of this example's `Caddyfile`.

## Start a source-build deployment

Validate the merged configuration before creating containers.

```bash
docker compose --env-file .env \
  -f compose.yml \
  -f deployments/examples/seaweedfs-caddy/compose.yml \
  config --quiet
```

Build and start the deployment.

```bash
docker compose --env-file .env \
  -f compose.yml \
  -f deployments/examples/seaweedfs-caddy/compose.yml \
  up -d --build --wait
```

## Start a Docker Hub deployment

Pull the selected release and the example's pinned infrastructure images.

```bash
docker compose --env-file .env \
  -f compose.dockerhub.yml \
  -f deployments/examples/seaweedfs-caddy/compose.yml \
  pull
```

Start the deployment.

```bash
docker compose --env-file .env \
  -f compose.dockerhub.yml \
  -f deployments/examples/seaweedfs-caddy/compose.yml \
  up -d --wait
```

A new database uses this S3 endpoint immediately.
For an existing filesystem-backed installation, start the deployment and then follow [Move an existing installation to SeaweedFS](../../../docs/deployment.md#move-an-existing-installation-to-seaweedfs).

## Replace the bundled single-node overlay

Use this procedure when an installation already runs `compose.seaweedfs.yml` and must retain its existing objects.
The old and new storage containers use the same data directory, so they must never run concurrently.

1. Follow [Backup and restore](../../../docs/operations.md#backup-and-restore) to create a consistent backup.
2. Stop the existing stack without deleting its bind-mounted data.

   ```bash
   docker compose --env-file .env \
     -f compose.dockerhub.yml \
     -f compose.seaweedfs.yml \
     down
   ```

   For a source-build deployment, replace `compose.dockerhub.yml` with `compose.yml`.

3. Start the stack with this example and the applicable command above.
4. Confirm that `seaweedfs-core`, `seaweedfs-s3-a`, `seaweedfs-s3-b`, and `seaweedfs` are healthy.
5. Test the active storage connection from Settings > Object storage.

The endpoint, bucket, prefix, credentials, image version, and data directory remain unchanged.
No CiteLoom database or content migration is required when replacing only the bundled SeaweedFS topology.

## Verify the deployment

List the running containers.

```bash
docker compose --env-file .env \
  -f compose.dockerhub.yml \
  -f deployments/examples/seaweedfs-caddy/compose.yml \
  ps
```

For a source-build deployment, replace `compose.dockerhub.yml` with `compose.yml`.
The output should show healthy `seaweedfs-core`, `seaweedfs-s3-a`, `seaweedfs-s3-b`, and `seaweedfs` services.

Check the Caddy-balanced endpoint from the host.

```bash
curl --fail http://127.0.0.1:8333/healthz
```

Sign in as an administrator, open Settings > Object storage, and select Test connection.
The application test verifies authenticated bucket access and a write-delete probe, while `/healthz` verifies only gateway reachability.

## Verify gateway failover

Stop one gateway.

```bash
docker compose --env-file .env \
  -f compose.dockerhub.yml \
  -f deployments/examples/seaweedfs-caddy/compose.yml \
  stop seaweedfs-s3-a
```

Run Test connection again from Settings > Object storage.
The test should succeed through `seaweedfs-s3-b`.

Restart the stopped gateway before testing the other one.

```bash
docker compose --env-file .env \
  -f compose.dockerhub.yml \
  -f deployments/examples/seaweedfs-caddy/compose.yml \
  start seaweedfs-s3-a
```

For a source-build deployment, replace `compose.dockerhub.yml` with `compose.yml`.
Do not stop `seaweedfs-core` during this test because it owns the single storage and metadata path.

## Stop or roll back

Stop the example without deleting its bind-mounted data.

```bash
docker compose --env-file .env \
  -f compose.dockerhub.yml \
  -f deployments/examples/seaweedfs-caddy/compose.yml \
  down
```

For a source-build deployment, replace `compose.dockerhub.yml` with `compose.yml`.

To restore the original bundled topology, start the stack with `compose.seaweedfs.yml` only after the example has stopped completely.
Both deployments use SeaweedFS 4.40 and the same configured data directory.
Never start both overlays together.

## Diagnose failures

Inspect the storage, gateway, and proxy logs.

```bash
docker compose --env-file .env \
  -f compose.dockerhub.yml \
  -f deployments/examples/seaweedfs-caddy/compose.yml \
  logs seaweedfs-core seaweedfs-s3-a seaweedfs-s3-b seaweedfs
```

For a source-build deployment, replace `compose.dockerhub.yml` with `compose.yml`.

If Caddy reports that both gateways are unavailable, confirm that both gateway containers are healthy and can reach `seaweedfs-core:8888`.
If gateway authentication fails, confirm that the core and both gateways received the same `CITELOOM_S3_ACCESS_KEY_ID` and `CITELOOM_S3_SECRET_ACCESS_KEY` values.
If `seaweedfs-core` does not become healthy, stop the deployment and verify that no other SeaweedFS container is using `CITELOOM_SEAWEEDFS_DATA_DIRECTORY`.
