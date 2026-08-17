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
| AWS S3 or another S3-compatible service | Keep the current backend running, then use **Settings > Object storage** to test and migrate. |

## Keep storage locations separate

One CiteLoom environment includes the web and worker containers that use the same PostgreSQL database.
All containers in that environment use the same S3 endpoint, bucket, and key prefix.

If production and test use the same S3 service, give them different buckets or different key prefixes.

For example:

```text
Production: bucket citeloom, prefix production
Test:       bucket citeloom, prefix test
```

:::danger[Keep storage locations separate]
Do not configure both environments with the same bucket and prefix on the same S3 service.
During orphan cleanup, one environment can delete an object that only the other environment has in its database.
:::

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

:::danger[Use the storage migration]
Do not change the active storage by editing PostgreSQL or replacing filesystem paths in Compose.
Use the storage migration in CiteLoom.
:::

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

## Return to local filesystem storage

Keep SeaweedFS running until the reverse migration is complete.
The previous filesystem does not contain documents that CiteLoom added after the S3 cutover.

1. Confirm that the web and worker services still mount the local source directory at `/app/documents/blobs`.
2. Open **Settings > Object storage**.
3. Select **Local filesystem**.
4. Set **Directory** to `/app/documents/blobs`.
5. Select **Test connection**.
6. Select **Start migration**.
7. Wait until the status is **Completed** and **Local filesystem** is active.
8. Open a representative source document and confirm that its content is unchanged.

After this verification, start CiteLoom without the SeaweedFS overlay.
Keep the SeaweedFS data directory until your recovery period ends because CiteLoom does not delete the previous S3 objects.

## Migrate from SeaweedFS to AWS S3

Use this workflow when **S3-compatible storage** is active and the endpoint is the bundled SeaweedFS service.
Keep SeaweedFS running until the AWS migration completes and your recovery period ends.

### 1. Prepare the AWS bucket and credentials

Create the destination bucket in the AWS region that you want to use.
Choose a key prefix that no other CiteLoom environment uses.

The AWS identity needs these permissions:

- `s3:ListBucket` for the destination bucket.
- `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` for objects below the selected key prefix.

The connection test lists the bucket and creates, reads, and deletes a temporary probe object.
The migration reads and verifies every copied source object.

### 2. Keep the SeaweedFS deployment active

:::danger[Keep SeaweedFS available]
Do not remove `compose.seaweedfs.yml` or stop SeaweedFS before cutover.
CiteLoom must read from SeaweedFS while it copies documents to AWS S3.
:::

The bundled overlay uses `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for the active SeaweedFS connection.
Those environment variables cannot also contain different AWS credentials during the same migration.

### 3. Configure AWS S3 as the migration target

Sign in as a global administrator and open **Settings > Object storage**.
Confirm that the active endpoint is `http://seaweedfs:8333` before you continue.

Enter these target values:

| Field | AWS S3 value |
| --- | --- |
| Backend | **S3-compatible object storage** |
| Endpoint URL | `https://s3.<region>.amazonaws.com` |
| Bucket | The destination AWS bucket name. |
| Object key prefix | A prefix reserved for this CiteLoom environment. |
| Signing region | The AWS region that contains the bucket. |
| Credential source | **Enter static credentials** |
| Access key ID | The AWS access key ID. |
| Secret access key | The AWS secret access key. |
| Use path-style URLs | Disabled. |

Replace `<region>` with the bucket region.
For example, use `https://s3.ca-central-1.amazonaws.com` for `ca-central-1`.

:::caution[Protect database backups]
Static credentials entered in Settings are write-only through the API.
CiteLoom stores them in PostgreSQL, so database backups contain them.
:::

### 4. Test the AWS connection

:::caution[Test the destination first]
Select **Test connection**.
Do not start the migration unless CiteLoom reports that the destination is ready.
:::

If the test fails, confirm the endpoint, region, bucket, credentials, IAM permissions, and path-style setting.
The active SeaweedFS backend remains unchanged after a failed test.

### 5. Start and monitor the migration

1. Select **Start migration**.
2. Confirm the document count.
3. Keep the worker and SeaweedFS services running.
4. Wait until the migration status is **Completed**.
5. Confirm that **Active storage** shows the AWS endpoint, bucket, and prefix.

CiteLoom keeps SeaweedFS active while it copies and hash-verifies documents.
The active configuration changes to AWS S3 only after final verification and cutover complete.

If the migration fails or is cancelled before cutover, SeaweedFS stays active.
Correct the reported problem and start a new migration.

### 6. Verify AWS storage and keep rollback available

Upload a representative document after cutover and confirm that CiteLoom can open and process it.
Confirm that AWS S3 contains objects below the configured prefix.

Keep the SeaweedFS service, its credentials, and its data directory for the recovery period that your policy defines.
New writes and deletions are not copied back to SeaweedFS after cutover.

To roll back during that period, configure SeaweedFS as the migration target with its original values, enable path-style URLs, test the connection, and complete the reverse migration.
After the recovery period, remove the SeaweedFS overlay from the deployment and recreate the application services with all other required overlays.

## Use another S3-compatible service

:::caution[Use only one S3 service]
Do not start the SeaweedFS overlay when you use another S3-compatible service.
:::

In **Settings > Object storage**:

1. Select **S3-compatible object storage**.
2. Enter the provider endpoint, bucket, key prefix, and signing region.
3. Select **Deployment environment** or **Enter static credentials**.
4. Enable path-style URLs only when the provider uses them.
5. Test the connection.
6. Start the migration.
7. Wait for **Completed** before you remove access to the old storage.

For a fixed topology with two stateless S3 gateways behind Caddy, use the [self-hosted SeaweedFS with Caddy deployment example](https://github.com/sageil/citeloom/blob/main/deployments/examples/seaweedfs-caddy/README.md).
