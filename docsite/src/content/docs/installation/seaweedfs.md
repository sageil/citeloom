---
title: SeaweedFS object storage
description: Add the optional SeaweedFS overlay for S3-compatible source-content storage.
---

The optional SeaweedFS overlay stores CiteLoom source documents through an S3-compatible API.
It is not required for a filesystem-backed installation.

## Before the first start

Set strong credentials and a persistent data directory in `.env`.
Keep each CiteLoom database on an exclusive bucket and object-key prefix because orphan reconciliation treats objects outside that database as removable.

```dotenv
CITELOOM_S3_ACCESS_KEY_ID=citeloom-admin
CITELOOM_S3_SECRET_ACCESS_KEY=replace-with-a-long-random-secret
CITELOOM_SEAWEEDFS_DATA_DIRECTORY=/srv/citeloom/seaweedfs
```

## New installation from published images

```bash
docker compose --env-file .env \
  -f compose.dockerhub.yml \
  -f compose.seaweedfs.yml pull

docker compose --env-file .env \
  -f compose.dockerhub.yml \
  -f compose.seaweedfs.yml up -d --wait
```

A new database created with the overlay uses SeaweedFS immediately.

## Existing filesystem installation

Do not change the active backend by editing the database or replacing paths in Compose.
Use CiteLoom's durable storage migration:

1. Back up PostgreSQL and the current source directory together.
2. Start the updated deployment with the base Compose file and `compose.seaweedfs.yml`.
3. Open Settings > Object storage and confirm that Local filesystem is still active.
4. Select S3-compatible object storage and use endpoint `http://seaweedfs:8333`.
5. Use the configured bucket, prefix, and signing region, choose Deployment environment credentials, and enable path-style URLs.
6. Test the connection.
7. Start the migration and monitor it until the status is Completed and the active backend changes.

The worker copies and hash-verifies every registered source object while the filesystem remains active.
The migration resumes from PostgreSQL checkpoints after restarts or expired leases.
If it is cancelled or fails before cutover, the filesystem remains active.

Retain the old filesystem and its mount for the required recovery period after cutover because CiteLoom does not automatically delete the previous backend.

For a fixed topology with two stateless S3 gateways behind Caddy, use the [self-hosted SeaweedFS with Caddy reference](../../reference/seaweedfs-caddy-example/).
