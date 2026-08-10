import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  GetObjectCommandOutput,
  HeadObjectCommandOutput,
  S3ClientConfig,
} from "@aws-sdk/client-s3";

import type { S3SourceContentConfig } from "../../config/index.js";
import type {
  SourceContentBackend,
  SourceContentAccessMode,
  SourceContentMetadata,
  SourceContentOrphanReconciliationRequest,
  SourceContentWrite,
} from "./source-content-backend-contract.js";
import { SourceContentMissingError } from "./source-content-backend-contract.js";

const SOURCE_CONTENT_ALGORITHM = "sha256";
const contentIdPattern = /^[0-9a-f]{64}$/u;

export class S3SourceContentBackend implements SourceContentBackend {
  public readonly identity: string;
  private initializedMode: "none" | SourceContentAccessMode = "none";
  private readonly keyPrefix: string;

  public constructor(
    private readonly config: S3SourceContentConfig,
    private readonly client: S3Client = new S3Client(buildS3ClientConfig(config)),
  ) {
    this.keyPrefix = config.prefix.replace(/^\/+|\/+$/gu, "");
    this.identity = [
      "s3",
      config.endpointUrl,
      config.region,
      config.bucket,
      this.keyPrefix,
    ].join(":");
  }

  public async initialize(
    mode: SourceContentAccessMode = "write",
  ): Promise<void> {
    if (
      this.initializedMode === "write"
      || (this.initializedMode === "read" && mode === "read")
    ) {
      return;
    }
    if (this.initializedMode === "none") {
      await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
      await this.client.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        MaxKeys: 1,
        Prefix: `${this.keyPrefix}/`,
      }));
      this.initializedMode = "read";
    }
    if (mode === "read") {
      return;
    }
    const probeKey = `${this.keyPrefix}/.probe/${randomUUID()}`;
    let probePublished = false;
    try {
      await this.client.send(new PutObjectCommand({
        Body: "ready",
        Bucket: this.config.bucket,
        ContentLength: 5,
        IfNoneMatch: "*",
        Key: probeKey,
      }));
      probePublished = true;
      await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: probeKey,
      }));
    } finally {
      if (probePublished) {
        await this.client.send(new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: probeKey,
        }));
      }
    }
    this.initializedMode = "write";
  }

  public async publish(
    document: SourceContentWrite,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    abortSignal?.throwIfAborted();
    await this.initialize();
    let body: Buffer | Readable;
    if (document.kind === "buffer") {
      body = document.content;
    } else if (document.kind === "file") {
      body = createReadStream(document.sourceFile);
    } else {
      body = await document.open(abortSignal);
    }
    try {
      await this.client.send(new PutObjectCommand({
        Body: body,
        Bucket: this.config.bucket,
        ContentLength: document.byteLength,
        IfNoneMatch: "*",
        Key: this.contentKey(document.documentId),
        Metadata: {
          "citeloom-byte-length": String(document.byteLength),
          "citeloom-sha256": document.documentId,
        },
      }), abortSignal === undefined ? undefined : { abortSignal });
    } catch (error: unknown) {
      if (body instanceof Readable) {
        body.destroy();
      }
      if (!isPreconditionFailure(error)) {
        throw error;
      }
      await this.assertPresent(document);
    }
  }

  public async assertPresent(document: SourceContentMetadata): Promise<void> {
    let output: HeadObjectCommandOutput;
    try {
      output = await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: this.contentKey(document.documentId),
      }));
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        throw error;
      }
      throw new SourceContentMissingError(document.documentId);
    }
    const storedByteLength = output.Metadata?.["citeloom-byte-length"];
    const storedDocumentId = output.Metadata?.["citeloom-sha256"];
    if (
      output.ContentLength !== document.byteLength
      || storedByteLength !== String(document.byteLength)
      || storedDocumentId !== document.documentId
    ) {
      throw new Error(
        `Published source content is missing or invalid: ${document.documentId}`,
      );
    }
  }

  public async read(document: SourceContentMetadata): Promise<Buffer> {
    const stream = await this.openRead(document);
    const chunks: Buffer[] = [];
    for await (const value of stream) {
      chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
    }
    const content = Buffer.concat(chunks);
    if (content.byteLength !== document.byteLength) {
      throw new Error(
        `Stored source document length does not match: ${document.documentId}`,
      );
    }
    return content;
  }

  public async openRead(
    document: SourceContentMetadata,
    abortSignal?: AbortSignal,
  ): Promise<Readable> {
    let output: GetObjectCommandOutput;
    try {
      output = await this.client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.contentKey(document.documentId),
      }), abortSignal === undefined ? undefined : { abortSignal });
    } catch (error: unknown) {
      if (!isNotFound(error)) {
        throw error;
      }
      throw new SourceContentMissingError(document.documentId);
    }
    if (output.Body === undefined) {
      throw new SourceContentMissingError(document.documentId);
    }
    return output.Body as Readable;
  }

  public async verify(
    document: SourceContentMetadata,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    await this.assertPresent(document);
    const hash = createHash(SOURCE_CONTENT_ALGORITHM);
    const stream = await this.openRead(document, abortSignal);
    await pipeline(stream, hash);
    if (hash.digest("hex") !== document.documentId) {
      throw new Error(
        `Published source content hash does not match: ${document.documentId}`,
      );
    }
  }

  public async remove(documentId: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: this.contentKey(documentId),
    }));
  }

  public async reconcileOrphans(
    request: SourceContentOrphanReconciliationRequest,
  ): Promise<number> {
    let continuationToken: string | undefined;
    let reconciled = 0;
    do {
      const output = await this.client.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        ContinuationToken: continuationToken,
        MaxKeys: 1_000,
        Prefix: `${this.keyPrefix}/${SOURCE_CONTENT_ALGORITHM}/`,
      }));
      for (const object of output.Contents ?? []) {
        if (reconciled >= request.limit) {
          return reconciled;
        }
        const candidate = this.readCanonicalObject(object.Key, object.LastModified);
        if (candidate === null) {
          continue;
        }
        if (request.nowMs - candidate.lastModified.getTime() < request.graceMs) {
          continue;
        }
        const removed = await request.removeIfOrphan(
          candidate.documentId,
          async () => {
            await this.client.send(new DeleteObjectCommand({
              Bucket: this.config.bucket,
              Key: candidate.key,
            }));
          },
        );
        if (removed) {
          reconciled += 1;
        }
      }
      if (reconciled >= request.limit || output.IsTruncated !== true) {
        return reconciled;
      }
      continuationToken = output.NextContinuationToken;
    } while (continuationToken !== undefined);
    return reconciled;
  }

  private contentKey(documentId: string): string {
    return `${this.keyPrefix}/${SOURCE_CONTENT_ALGORITHM}/${documentId.slice(0, 2)}/${documentId}`;
  }

  private readCanonicalObject(
    key: string | undefined,
    lastModified: Date | undefined,
  ): { documentId: string; key: string; lastModified: Date } | null {
    if (key === undefined || lastModified === undefined) {
      return null;
    }
    const prefix = `${this.keyPrefix}/${SOURCE_CONTENT_ALGORITHM}/`;
    if (!key.startsWith(prefix)) {
      return null;
    }
    const suffix = key.slice(prefix.length);
    const parts = suffix.split("/");
    if (parts.length !== 2) {
      return null;
    }
    const documentId = parts[1];
    if (
      documentId === undefined
      || !contentIdPattern.test(documentId)
      || parts[0] !== documentId.slice(0, 2)
    ) {
      return null;
    }
    return { documentId, key, lastModified };
  }
}

function buildS3ClientConfig(config: S3SourceContentConfig): S3ClientConfig {
  const clientConfig: S3ClientConfig = {
    endpoint: config.endpointUrl,
    forcePathStyle: config.forcePathStyle,
    region: config.region,
  };
  if (config.credentials.kind === "environment") {
    return clientConfig;
  }
  return {
    ...clientConfig,
    credentials: {
      accessKeyId: config.credentials.accessKeyId,
      secretAccessKey: config.credentials.secretAccessKey,
    },
  };
}

function isPreconditionFailure(error: unknown): boolean {
  return readHttpStatusCode(error) === 412;
}

function isNotFound(error: unknown): boolean {
  return readHttpStatusCode(error) === 404;
}

function readHttpStatusCode(error: unknown): number | null {
  if (
    typeof error === "object"
    && error !== null
    && "$metadata" in error
    && typeof error.$metadata === "object"
    && error.$metadata !== null
    && "httpStatusCode" in error.$metadata
    && typeof error.$metadata.httpStatusCode === "number"
  ) {
    return error.$metadata.httpStatusCode;
  }
  return null;
}
