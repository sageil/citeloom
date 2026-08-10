import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  createReadStream,
  createWriteStream,
  type Stats,
} from "node:fs";
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { FilesystemSourceContentConfig } from "../../config/index.js";
import type {
  SourceContentBackend,
  SourceContentAccessMode,
  SourceContentMetadata,
  SourceContentOrphanReconciliationRequest,
  SourceContentWrite,
} from "./source-content-backend-contract.js";
import { SourceContentMissingError } from "./source-content-backend-contract.js";

const SOURCE_CONTENT_ALGORITHM = "sha256";
const contentDirectoryPattern = /^[0-9a-f]{2}$/u;
const contentIdPattern = /^[0-9a-f]{64}$/u;
const temporaryContentPattern =
  /^(?:\.write-probe-[0-9a-f-]+|(?:[0-9a-f]{64}\.)?[0-9a-f-]+\.(?:staged|tmp))$/u;

export class FilesystemSourceContentBackend implements SourceContentBackend {
  public readonly identity: string;
  private initializedMode: "none" | SourceContentAccessMode = "none";

  public constructor(
    private readonly config: FilesystemSourceContentConfig,
  ) {
    this.identity = `filesystem:${config.directory}`;
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
    if (mode === "read") {
      await access(
        this.config.directory,
        constants.R_OK | constants.X_OK,
      );
      this.initializedMode = "read";
      return;
    }
    await mkdir(this.algorithmDirectory(), { recursive: true });
    const probePath = join(
      this.algorithmDirectory(),
      `.write-probe-${randomUUID()}`,
    );
    const handle = await open(
      probePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile("ready");
      await handle.sync();
    } finally {
      try {
        await handle.close();
      } finally {
        await removeFileIfPresent(probePath);
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
    if (document.kind === "file") {
      await this.publishFile(document);
      return;
    }
    const temporaryPath = join(
      this.algorithmDirectory(),
      `${document.documentId}.${randomUUID()}.staged`,
    );
    try {
      if (document.kind === "buffer") {
        const handle = await open(
          temporaryPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        try {
          await handle.writeFile(document.content);
          await handle.sync();
        } finally {
          await handle.close();
        }
      } else {
        const source = await document.open(abortSignal);
        await pipeline(
          source,
          createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
          abortSignal === undefined ? {} : { signal: abortSignal },
        );
      }
      await this.publishFile({
        byteLength: document.byteLength,
        documentId: document.documentId,
        kind: "file",
        sourceFile: temporaryPath,
      });
    } finally {
      await removeFileIfPresent(temporaryPath);
    }
  }

  public async read(document: SourceContentMetadata): Promise<Buffer> {
    let content: Buffer;
    try {
      content = await readFile(this.contentPath(document.documentId));
    } catch (error: unknown) {
      if (readFileSystemErrorCode(error) !== "ENOENT") {
        throw error;
      }
      throw new SourceContentMissingError(document.documentId);
    }
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
    await this.assertPresent(document);
    return createReadStream(
      this.contentPath(document.documentId),
      abortSignal === undefined ? {} : { signal: abortSignal },
    );
  }

  public async assertPresent(document: SourceContentMetadata): Promise<void> {
    let metadata: Stats;
    try {
      metadata = await stat(this.contentPath(document.documentId));
    } catch (error: unknown) {
      if (readFileSystemErrorCode(error) !== "ENOENT") {
        throw error;
      }
      throw new SourceContentMissingError(document.documentId);
    }
    if (!metadata.isFile() || metadata.size !== document.byteLength) {
      throw new Error(
        `Published source content is missing or invalid: ${document.documentId}`,
      );
    }
  }

  public async verify(
    document: SourceContentMetadata,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    await this.assertPresent(document);
    const hash = createHash(SOURCE_CONTENT_ALGORITHM);
    await pipeline(
      createReadStream(
        this.contentPath(document.documentId),
        abortSignal === undefined ? {} : { signal: abortSignal },
      ),
      hash,
    );
    if (hash.digest("hex") !== document.documentId) {
      throw new Error(
        `Published source content hash does not match: ${document.documentId}`,
      );
    }
  }

  public async remove(documentId: string): Promise<void> {
    const contentDirectory = join(
      this.algorithmDirectory(),
      documentId.slice(0, 2),
    );
    await removeFileIfPresent(this.contentPath(documentId));
    await this.syncDirectoryIfPresent(contentDirectory);
  }

  public async reconcileOrphans(
    request: SourceContentOrphanReconciliationRequest,
  ): Promise<number> {
    const algorithmDirectory = this.algorithmDirectory();
    const rootEntries = await readdir(algorithmDirectory, {
      withFileTypes: true,
    });
    let reconciled = 0;
    for (const entry of rootEntries) {
      if (reconciled >= request.limit) {
        return reconciled;
      }
      const path = join(algorithmDirectory, entry.name);
      if (entry.isFile() && temporaryContentPattern.test(entry.name)) {
        if (await isOlderThanGracePeriod(path, request.nowMs, request.graceMs)) {
          await removeFileIfPresent(path);
          reconciled += 1;
        }
        continue;
      }
      if (!entry.isDirectory() || !contentDirectoryPattern.test(entry.name)) {
        continue;
      }
      reconciled += await this.reconcileContentDirectory(
        path,
        entry.name,
        request,
        request.limit - reconciled,
      );
    }
    return reconciled;
  }

  private algorithmDirectory(): string {
    return join(this.config.directory, SOURCE_CONTENT_ALGORITHM);
  }

  private contentPath(documentId: string): string {
    return join(this.algorithmDirectory(), documentId.slice(0, 2), documentId);
  }

  private async publishFile(
    document: SourceContentMetadata & { kind: "file"; sourceFile: string },
  ): Promise<void> {
    await this.syncFile(document.sourceFile);
    const stagedMetadata = await stat(document.sourceFile);
    if (!stagedMetadata.isFile() || stagedMetadata.size !== document.byteLength) {
      throw new Error(`Staged source content changed: ${document.sourceFile}`);
    }
    const destination = this.contentPath(document.documentId);
    const destinationDirectory = join(
      this.algorithmDirectory(),
      document.documentId.slice(0, 2),
    );
    await mkdir(destinationDirectory, { recursive: true });
    const temporaryPath = `${destination}.${randomUUID()}.tmp`;
    let published = false;
    try {
      await pipeline(
        createReadStream(document.sourceFile),
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
      );
      await this.syncFile(temporaryPath);
      try {
        await link(temporaryPath, destination);
        published = true;
      } catch (error: unknown) {
        if (readFileSystemErrorCode(error) !== "EEXIST") {
          throw error;
        }
      }
    } finally {
      await removeFileIfPresent(temporaryPath);
    }
    if (published) {
      await this.syncDirectory(destinationDirectory);
      return;
    }
    await this.verify(document);
  }

  private async reconcileContentDirectory(
    directory: string,
    documentIdPrefix: string,
    request: SourceContentOrphanReconciliationRequest,
    limit: number,
  ): Promise<number> {
    const entries = await readdir(directory, { withFileTypes: true });
    let reconciled = 0;
    for (const entry of entries) {
      if (reconciled >= limit) {
        return reconciled;
      }
      if (
        !entry.isFile()
        || !contentIdPattern.test(entry.name)
        || !entry.name.startsWith(documentIdPrefix)
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      if (!await isOlderThanGracePeriod(path, request.nowMs, request.graceMs)) {
        continue;
      }
      const removed = await request.removeIfOrphan(
        entry.name,
        async () => {
          await removeFileIfPresent(path);
        },
      );
      if (removed) {
        reconciled += 1;
      }
    }
    if (reconciled > 0) {
      await this.syncDirectoryIfPresent(directory);
    }
    return reconciled;
  }

  private async syncFile(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectoryIfPresent(path: string): Promise<void> {
    try {
      await this.syncDirectory(path);
    } catch (error: unknown) {
      if (readFileSystemErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function removeFileIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error: unknown) {
    if (readFileSystemErrorCode(error) !== "ENOENT") {
      throw error;
    }
    return false;
  }
}

function readFileSystemErrorCode(error: unknown): string | null {
  if (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

async function isOlderThanGracePeriod(
  path: string,
  nowMs: number,
  graceMs: number,
): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return nowMs - metadata.mtimeMs >= graceMs;
  } catch (error: unknown) {
    if (readFileSystemErrorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}
