---
title: Use object storage
description: Store source documents in bundled SeaweedFS or another S3-compatible service.
---

CiteLoom uses local filesystem storage by default.
You do not need to configure object storage for a filesystem-backed installation.

Use this guide when you want to store source documents in an S3-compatible service.
The included Compose overlay uses SeaweedFS.

## Choose your workflow

| Your installation | Workflow |
| --- | --- |
| New installation with SeaweedFS | Configure `.env`, then start CiteLoom with the SeaweedFS overlay. |
| Existing filesystem installation | Start SeaweedFS, then migrate from **Settings > Object storage**. |
| Another S3-compatible service | Start with filesystem storage, then use **Settings > Object storage** to test and migrate. |

## Keep storage locations separate

One CiteLoom environment includes the web and worker containers that use the same PostgreSQL database.
All containers in that environment use the same S3 endpoint, bucket, and key prefix.

If production and test use the same S3 service, give them different buckets or different key prefixes.

For example:

```text
Production: bucket citeloom, prefix production
Test:       bucket citeloom, prefix test
```

Do not configure both environments with the same bucket and prefix on the same S3 service.
During orphan cleanup, one environment can delete an object that only the other environment has in its database.

## New installation with SeaweedFS

### 1. Configure the storage values

Add these values to the deployment `.env` file:

```dotenv
CITELOOM_S3_ACCESS_KEY_ID=citeloom-admin
CITELOOM_S3_SECRET_ACCESS_KEY=replace-with-a-long-random-secret
CITELOOM_SOURCE_CONTENT_S3_BUCKET=citeloom
CITELOOM_SOURCE_CONTENT_S3_PREFIX=sources
CITELOOM_SOURCE_CONTENT_S3_REGION=us-east-1
CITELOOM_SEAWEEDFS_DATA_DIRECTORY=/srv/citeloom/seaweedfs
```

Change the access key and secret key.
Use an absolute persistent path for `CITELOOM_SEAWEEDFS_DATA_DIRECTORY`.

The overlay uses these defaults when you omit them:

- Bucket: `citeloom`
- Key prefix: `sources`
- Signing region: `us-east-1`

The signing region signs S3 requests.
It does not select where SeaweedFS stores its data.

### 2. Start the installation

Pull the published images:

```bash
docker compose --env-file .env \
  -f compose.dockerhub.yml \
  -f compose.seaweedfs.yml pull
```

Start CiteLoom and SeaweedFS:

```bash
docker compose --env-file .env \
  -f compose.dockerhub.yml \
  -f compose.seaweedfs.yml up -d --wait
```

A new CiteLoom environment that starts with this overlay stores source documents in SeaweedFS.

### 3. Verify the active storage

1. Sign in as a global administrator.
2. Open **Settings > Object storage**.
3. Confirm that **S3-compatible storage** is active.
4. Confirm the endpoint, bucket, and prefix.

For the included overlay, the endpoint is `http://seaweedfs:8333`.

The active-storage summary shows the backend that handles new reads, writes, and deletions:

![The CiteLoom active-storage summary shows the S3-compatible backend, SeaweedFS endpoint, bucket, key prefix, and deployment credentials.](/citeloom/images/object-storage-overview.png)

The production form uses the same SeaweedFS values as this guide:

![The CiteLoom migration target form shows the SeaweedFS endpoint, bucket, key prefix, signing region, deployment credentials, and path-style URLs.](/citeloom/images/object-storage-settings.png)

## Existing filesystem installation

Do not change the active storage by editing PostgreSQL or replacing filesystem paths in Compose.
Use the storage migration in CiteLoom.

### 1. Back up the current data

Stop or control writes according to your backup procedure.
Back up PostgreSQL and the current source directory together.

### 2. Start SeaweedFS

Add the values from [Configure the storage values](#1-configure-the-storage-values) to `.env`.

Pull and start the deployment with both Compose files:

```bash
docker compose --env-file .env \
  -f compose.dockerhub.yml \
  -f compose.seaweedfs.yml pull

docker compose --env-file .env \
  -f compose.dockerhub.yml \
  -f compose.seaweedfs.yml up -d --wait
```

The filesystem remains active until the migration completes.

### 3. Configure the migration target

Open **Settings > Object storage**.
Confirm that **Local filesystem** is active.

Select **S3-compatible object storage** and enter these values:

| Field | Value for the included SeaweedFS overlay |
| --- | --- |
| Endpoint URL | `http://seaweedfs:8333` |
| Bucket | The value of `CITELOOM_SOURCE_CONTENT_S3_BUCKET` |
| Object key prefix | The value of `CITELOOM_SOURCE_CONTENT_S3_PREFIX` |
| Signing region | The value of `CITELOOM_SOURCE_CONTENT_S3_REGION` |
| Credential source | **Deployment environment** |
| Use path-style URLs | Enabled |

Select **Test connection**.
CiteLoom must report that the destination is ready before you can start the migration.

### 4. Start and monitor the migration

1. Select **Start migration**.
2. Confirm the number of documents that CiteLoom will copy.
3. Monitor the migration until its status is **Completed**.
4. Confirm that **S3-compatible storage** is now active.

The worker copies and hash-verifies each registered source document.
It keeps the filesystem active until final verification and cutover complete.

The migration resumes from PostgreSQL checkpoints after a restart or an expired worker lease.
If the migration fails or is cancelled before cutover, the filesystem stays active.

### 5. Keep the previous files during recovery

CiteLoom keeps the previous filesystem configuration after cutover.
It does not synchronize new writes or deletions back to that filesystem.

Keep the old source directory and its mount for the recovery period that your policy defines.
CiteLoom does not delete the previous files automatically.

## Use another S3-compatible service

Do not start the SeaweedFS overlay when you use another S3-compatible service.

In **Settings > Object storage**:

1. Select **S3-compatible object storage**.
2. Enter the provider endpoint, bucket, key prefix, and signing region.
3. Select **Deployment environment** or **Enter static credentials**.
4. Enable path-style URLs only when the provider uses them.
5. Test the connection.
6. Start the migration.
7. Wait for **Completed** before you remove access to the old storage.

For a fixed topology with two stateless S3 gateways behind Caddy, use the [self-hosted SeaweedFS with Caddy deployment example](https://github.com/sageil/citeloom/blob/main/deployments/examples/seaweedfs-caddy/README.md).
