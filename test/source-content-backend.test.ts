import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";

import { FilesystemSourceContentBackend } from "../src/documents/storage/filesystem-source-content-backend.js";
import { S3SourceContentBackend } from "../src/documents/storage/s3-source-content-backend.js";
import { SourceContentMissingError } from "../src/documents/storage/source-content-backend-model.js";

const s3Config = {
  bucket: "citeloom",
  credentials: { kind: "environment" as const },
  endpointUrl: "http://seaweedfs:8333",
  forcePathStyle: true,
  kind: "s3" as const,
  prefix: "sources",
  region: "us-east-1",
};

describe("filesystem source-content backend", () => {
  it("opens an empty archive backend in read-only mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-empty-archive-"));
    const backend = new FilesystemSourceContentBackend({
      directory,
      kind: "filesystem",
    });

    await expect(backend.initialize("read")).resolves.toBeUndefined();
    await expect(stat(join(directory, "sha256")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes content atomically and verifies its digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-filesystem-store-"));
    const backend = new FilesystemSourceContentBackend({
      directory,
      kind: "filesystem",
    });
    const content = Buffer.from("durable source content");
    const documentId = createHash("sha256").update(content).digest("hex");

    await backend.publish({
      byteLength: content.byteLength,
      content,
      documentId,
      kind: "buffer",
    });
    await expect(backend.verify({
      byteLength: content.byteLength,
      documentId,
    })).resolves.toBeUndefined();

    const published = await readFile(
      join(directory, "sha256", documentId.slice(0, 2), documentId),
    );
    expect(published).toEqual(content);
  });

  it("continues past retained candidates when applying an orphan limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-orphan-store-"));
    const algorithmDirectory = join(directory, "sha256");
    const shardDirectory = join(algorithmDirectory, "aa");
    await mkdir(shardDirectory, { recursive: true });
    const retainedId = `aa${"0".repeat(62)}`;
    const orphanId = `aa${"1".repeat(62)}`;
    const retainedPath = join(shardDirectory, retainedId);
    const orphanPath = join(shardDirectory, orphanId);
    await writeFile(retainedPath, "retained");
    await writeFile(orphanPath, "orphan");
    const oldDate = new Date("2025-01-01T00:00:00.000Z");
    await utimes(retainedPath, oldDate, oldDate);
    await utimes(orphanPath, oldDate, oldDate);
    const backend = new FilesystemSourceContentBackend({
      directory,
      kind: "filesystem",
    });

    const reconciled = await backend.reconcileOrphans({
      graceMs: 1,
      limit: 1,
      nowMs: Date.now(),
      removeIfOrphan: async (documentId, remove) => {
        if (documentId === retainedId) {
          return false;
        }
        await remove();
        return true;
      },
    });

    expect(reconciled).toBe(1);
    await expect(stat(retainedPath)).resolves.toBeDefined();
    await expect(stat(orphanPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("S3 source-content backend", () => {
  it("uses immutable content-addressed S3 objects with verified metadata", async () => {
    const content = Buffer.from("seaweed source content");
    const documentId = createHash("sha256").update(content).digest("hex");
    const commands: unknown[] = [];
    const send = vi.fn(async (command: unknown) => {
      commands.push(command);
      return {};
    });
    const backend = new S3SourceContentBackend(
      s3Config,
      { send } as unknown as S3Client,
    );

    await backend.publish({
      byteLength: content.byteLength,
      content,
      documentId,
      kind: "buffer",
    });

    expect(commands.some((command) => command instanceof HeadBucketCommand)).toBe(true);
    expect(commands.some((command) => command instanceof ListObjectsV2Command)).toBe(true);
    const contentPut = commands.find((command) => {
      return command instanceof PutObjectCommand
        && command.input.Key?.includes("/sha256/") === true;
    });
    expect(contentPut).toBeInstanceOf(PutObjectCommand);
    expect((contentPut as PutObjectCommand).input).toMatchObject({
      Bucket: "citeloom",
      ContentLength: content.byteLength,
      IfNoneMatch: "*",
      Key: `sources/sha256/${documentId.slice(0, 2)}/${documentId}`,
      Metadata: {
        "citeloom-byte-length": String(content.byteLength),
        "citeloom-sha256": documentId,
      },
    });
    expect(commands.some((command) => command instanceof DeleteObjectCommand)).toBe(true);
  });

  it("verifies object metadata and streamed content", async () => {
    const content = Buffer.from("verified SeaweedFS object");
    const documentId = createHash("sha256").update(content).digest("hex");
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: content.byteLength,
          Metadata: {
            "citeloom-byte-length": String(content.byteLength),
            "citeloom-sha256": documentId,
          },
        };
      }
      if (command instanceof GetObjectCommand) {
        return { Body: Readable.from([content]) };
      }
      throw new Error("Unexpected S3 command.");
    });
    const backend = new S3SourceContentBackend(
      s3Config,
      { send } as unknown as S3Client,
    );

    await expect(backend.verify({
      byteLength: content.byteLength,
      documentId,
    })).resolves.toBeUndefined();
  });

  it("maps missing objects to the storage boundary error", async () => {
    const send = vi.fn(async () => {
      throw { $metadata: { httpStatusCode: 404 } };
    });
    const backend = new S3SourceContentBackend(
      s3Config,
      { send } as unknown as S3Client,
    );

    await expect(backend.assertPresent({
      byteLength: 1,
      documentId: "a".repeat(64),
    })).rejects.toBeInstanceOf(SourceContentMissingError);
  });

  it("continues scanning a page until the orphan deletion limit is reached", async () => {
    const retainedId = "a".repeat(64);
    const orphanId = "b".repeat(64);
    const commands: unknown[] = [];
    const send = vi.fn(async (command: unknown) => {
      commands.push(command);
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: [retainedId, orphanId].map((documentId) => ({
            Key: `sources/sha256/${documentId.slice(0, 2)}/${documentId}`,
            LastModified: new Date("2025-01-01T00:00:00.000Z"),
          })),
          IsTruncated: false,
        };
      }
      return {};
    });
    const backend = new S3SourceContentBackend(
      s3Config,
      { send } as unknown as S3Client,
    );

    const reconciled = await backend.reconcileOrphans({
      graceMs: 1,
      limit: 1,
      nowMs: Date.now(),
      removeIfOrphan: async (documentId, remove) => {
        if (documentId === retainedId) {
          return false;
        }
        await remove();
        return true;
      },
    });

    expect(reconciled).toBe(1);
    const deletion = commands.find((command) => command instanceof DeleteObjectCommand);
    expect(deletion).toBeInstanceOf(DeleteObjectCommand);
    expect((deletion as DeleteObjectCommand).input.Key).toContain(orphanId);
  });
});

describe.runIf(process.env.CITELOOM_SEAWEEDFS_LIVE_TEST === "true")(
  "live SeaweedFS source-content backend",
  () => {
    it("publishes, reads, verifies, and removes an object through the S3 API", async () => {
      const content = Buffer.from("live SeaweedFS source content");
      const documentId = createHash("sha256").update(content).digest("hex");
      const backend = new S3SourceContentBackend({
        bucket: process.env.CITELOOM_SOURCE_CONTENT_S3_BUCKET ?? "citeloom",
        credentials: { kind: "environment" },
        endpointUrl: process.env.CITELOOM_SOURCE_CONTENT_S3_ENDPOINT
          ?? "http://127.0.0.1:8333",
        forcePathStyle: true,
        kind: "s3",
        prefix: `live-test/${randomUUID()}`,
        region: "us-east-1",
      });
      const metadata = { byteLength: content.byteLength, documentId };

      await backend.publish({ ...metadata, content, kind: "buffer" });
      await expect(backend.read(metadata)).resolves.toEqual(content);
      await expect(backend.verify(metadata)).resolves.toBeUndefined();
      await backend.remove(documentId);
      await expect(backend.assertPresent(metadata))
        .rejects.toBeInstanceOf(SourceContentMissingError);
    });
  },
);
