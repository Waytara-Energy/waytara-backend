import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * A place that keeps whole files by name (Cloudflare R2 today; any S3-style store works). Files are written whole and replaced whole:
 * nothing here can append, which is why cadence data is written as small parts (plan section 11.5).
 */
export interface ObjectStore {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  /** null when there is no such file */
  get(key: string): Promise<Buffer | null>;
  /** every file whose name starts with the prefix, in name order */
  list(prefix: string): Promise<StoredFile[]>;
  /** names one level below the prefix, e.g. list "cadence/v1/" gives "cadence/v1/<equipment id>/" for each equipment */
  listFolders(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
  /** throws when the store cannot be reached with these credentials */
  ping(): Promise<void>;
}

export interface StoredFile {
  key: string;
  size: number;
  /** when the file was last written, epoch milliseconds */
  modified: number;
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export interface R2Settings {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

const isMissing = (error: unknown): boolean => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
};

export class R2ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(s: R2Settings, client?: S3Client) {
    this.bucket = s.bucket;
    this.client =
      client ??
      new S3Client({
        region: "auto",
        endpoint: `https://${s.accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
        maxAttempts: 3,
        requestHandler: { requestTimeout: 20_000, connectionTimeout: 5_000 },
      });
  }

  private fail(what: string, error: unknown): never {
    // The message never carries the keys; the SDK's own message names the problem (AccessDenied, ...).
    const name = (error as { name?: string })?.name ?? "error";
    throw new StoreError(`the file store could not ${what} (${name})`);
  }

  async put(key: string, body: Buffer, contentType = "application/octet-stream"): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    } catch (error) {
      this.fail("save a file", error);
    }
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (error) {
      if (isMissing(error)) return null;
      this.fail("read a file", error);
    }
  }

  async list(prefix: string): Promise<StoredFile[]> {
    const out: StoredFile[] = [];
    try {
      let token: string | undefined;
      do {
        const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, modified: o.LastModified?.getTime() ?? 0 });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
    } catch (error) {
      this.fail("list files", error);
    }
    return out;
  }

  async listFolders(prefix: string): Promise<string[]> {
    const out: string[] = [];
    try {
      let token: string | undefined;
      do {
        const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, Delimiter: "/", ContinuationToken: token }));
        for (const p of r.CommonPrefixes ?? []) if (p.Prefix) out.push(p.Prefix);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
    } catch (error) {
      this.fail("list folders", error);
    }
    return out;
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      this.fail("delete a file", error);
    }
  }

  async ping(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      this.fail("reach the bucket", error);
    }
  }
}

/** In memory, for tests and for running without a bucket. */
export class MemoryObjectStore implements ObjectStore {
  constructor(private readonly clock: () => number = Date.now) {}

  readonly files = new Map<string, Buffer>();
  readonly modified = new Map<string, number>();
  failNext = 0;
  reads = 0;
  writes = 0;

  private maybeFail() {
    if (this.failNext > 0) {
      this.failNext--;
      throw new StoreError("the file store is down");
    }
  }

  async put(key: string, body: Buffer): Promise<void> {
    this.maybeFail();
    this.writes++;
    this.files.set(key, Buffer.from(body));
    this.modified.set(key, this.clock());
  }

  async get(key: string): Promise<Buffer | null> {
    this.maybeFail();
    this.reads++;
    const f = this.files.get(key);
    return f ? Buffer.from(f) : null;
  }

  async list(prefix: string): Promise<StoredFile[]> {
    this.maybeFail();
    return [...this.files].filter(([k]) => k.startsWith(prefix)).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, v]) => ({ key, size: v.length, modified: this.modified.get(key) ?? 0 }));
  }

  async listFolders(prefix: string): Promise<string[]> {
    this.maybeFail();
    const out = new Set<string>();
    for (const k of this.files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const i = rest.indexOf("/");
      if (i >= 0) out.add(prefix + rest.slice(0, i + 1));
    }
    return [...out].sort();
  }

  async delete(key: string): Promise<void> {
    this.maybeFail();
    this.files.delete(key);
    this.modified.delete(key);
  }

  async ping(): Promise<void> {
    this.maybeFail();
  }
}
