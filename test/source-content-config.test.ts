import { describe, expect, it } from "vitest";

import { readSourceContentBootstrapConfig } from "../src/database/administrator-bootstrap.js";
import { parseSourceContentConfig } from "../src/providers/settings-persistence.js";

describe("source-content configuration boundary", () => {
  it("normalizes the legacy filesystem setting", () => {
    expect(parseSourceContentConfig({
      directory: "/srv/citeloom/documents/blobs",
    })).toEqual({
      directory: "/srv/citeloom/documents/blobs",
      kind: "filesystem",
    });
  });

  it("reads an explicit S3-compatible backend", () => {
    expect(readSourceContentBootstrapConfig({
      CITELOOM_SOURCE_CONTENT_BACKEND: "s3",
      CITELOOM_SOURCE_CONTENT_S3_BUCKET: "citeloom-test",
      CITELOOM_SOURCE_CONTENT_S3_ENDPOINT: "http://seaweedfs:8333",
      CITELOOM_SOURCE_CONTENT_S3_FORCE_PATH_STYLE: "true",
      CITELOOM_SOURCE_CONTENT_S3_PREFIX: "tenant/source-content",
      CITELOOM_SOURCE_CONTENT_S3_REGION: "us-east-1",
    })).toEqual({
      bucket: "citeloom-test",
      credentials: { kind: "environment" },
      endpointUrl: "http://seaweedfs:8333",
      forcePathStyle: true,
      kind: "s3",
      prefix: "tenant/source-content",
      region: "us-east-1",
    });
  });

  it("rejects unsupported S3 endpoint protocols", () => {
    expect(() => parseSourceContentConfig({
      bucket: "citeloom",
      credentials: { kind: "environment" },
      endpointUrl: "ftp://seaweedfs/source-content",
      forcePathStyle: true,
      kind: "s3",
      prefix: "sources",
      region: "us-east-1",
    })).toThrow("S3 endpoint must use http or https");
  });

  it("rejects unsupported S3 endpoint protocols from the environment", () => {
    expect(() => readSourceContentBootstrapConfig({
      CITELOOM_SOURCE_CONTENT_BACKEND: "s3",
      CITELOOM_SOURCE_CONTENT_S3_ENDPOINT: "ftp://seaweedfs/source-content",
    })).toThrow("S3 endpoint must use http or https");
  });

  it("normalizes S3 key prefixes at the configuration boundary", () => {
    expect(parseSourceContentConfig({
      bucket: "citeloom",
      credentials: { kind: "environment" },
      endpointUrl: "http://seaweedfs:8333",
      forcePathStyle: true,
      kind: "s3",
      prefix: "/tenant/sources/",
      region: "us-east-1",
    })).toMatchObject({ prefix: "tenant/sources" });
  });
});
