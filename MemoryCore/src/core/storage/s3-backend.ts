/**
 * S3StorageBackend — S3 호환 오브젝트 스토리지 구현체.
 *
 * Oracle Object Storage / Cloudflare R2 / MinIO / AWS S3 어디든 붙는다.
 * `LocalStorageBackend` 와 동일한 시맨틱을 목표로 하되, S3 에 없는 기능
 * (원자적 append) 은 아래 "Append 전략" 방식으로 대체한다.
 *
 * ## type 이 "cos" 인 이유
 * `IStorageBackend.type` 은 `"local" | "cos"` 유니온이고 분기점이 두 곳뿐이다:
 *   - `core/hooks/auto-recall.ts:232` — scene navigation 경로를 로컬 절대경로가
 *     아니라 오브젝트 키로 렌더링할지 결정
 *   - `core/memory-generation-log/store.ts:97` — "local" 일 때만 `instances/{id}`
 *     스코프를 덧댄다 (COS 는 자격증명이 prefix 를 이미 들고 있으므로)
 * 원격 오브젝트 스토리지로서 두 분기 모두 COS 와 동일하게 동작해야 하므로
 * 유니온을 넓히지 않고 `"cos"` 로 신고한다. 대신 COS 자격증명이 갖는 prefix 를
 * 이 구현은 `keyPrefix` 옵션으로 받는다.
 *
 * ## Append 전략 (S3 에는 원자적 append 가 없다)
 * `appendObject` 는 L0/L1 JSONL 기록 경로에서 실제로 쓰인다
 * (`core/record/l1-writer.ts:259`, `core/conversation/l0-recorder.ts:298` 등 7곳).
 * read-modify-write 는 동시 쓰기에서 데이터를 잃는다 — upstream 이 CR-1 감사에서
 * "100 병렬 쓰기 시 99% 손실" 로 확인하고 폐기한 방식이다.
 *
 * ETag 기반 낙관적 동시성(If-Match) 도 불가능하다: Oracle Object Storage 의
 * S3 호환 API 는 `If-Match` 를 서명에 포함하지 않아 SignatureDoesNotMatch 가 난다
 * (2026-08-20 실측). 반면 `If-None-Match: *` 는 정상 동작한다.
 *
 * 그래서 **세그먼트 방식**을 쓴다:
 *   appendObject(k, data)  →  PUT {k}/.seg/{시각}-{난수}   (If-None-Match: *)
 *   getObject(k)           →  {k}/.seg/ 를 나열해 키 순서대로 이어붙임
 *
 * 각 append 가 서로 다른 키에 쓰므로 경합이 없고 손실이 없다. 키에 시각 접두사를
 * 넣어 사전순 = 시간순이 되게 했다. 대가는 읽기 비용(LIST + N GET)인데,
 * 이 JSONL 들은 거의 읽히지 않는 감사/백업용이라 수용 가능하다.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import type {
  IStorageBackend,
  StorageObject,
  PutObjectOptions,
  ListObjectsOptions,
  ListResult,
  ListEntry,
  StorageLogger,
} from "./types.js";

const TAG = "[storage][s3]";

/** append 세그먼트가 모이는 하위 경로. 일반 키와 충돌하지 않도록 점으로 시작한다. */
const SEG_DIR = "/.seg/";

export interface S3StorageBackendOptions {
  /** 예: https://<ns>.compat.objectstorage.ap-seoul-1.oraclecloud.com */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 모든 키 앞에 붙는 접두사 (COS 자격증명의 prefix 와 같은 역할). 예: "tenant-a/" */
  keyPrefix?: string;
  /** MinIO/Oracle 등은 path-style 이 필요하다. 기본 true. */
  forcePathStyle?: boolean;
  logger?: StorageLogger;
}

export class S3StorageBackend implements IStorageBackend {
  /** @see 파일 상단 "type 이 cos 인 이유" */
  readonly type = "cos" as const;

  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly logger?: StorageLogger;

  constructor(opts: S3StorageBackendOptions) {
    this.bucket = opts.bucket;
    this.logger = opts.logger;
    const p = (opts.keyPrefix ?? "").replace(/^\/+/, "");
    this.keyPrefix = p && !p.endsWith("/") ? `${p}/` : p;

    this.s3 = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region,
      forcePathStyle: opts.forcePathStyle ?? true,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      // AWS SDK v3 가 기본으로 붙이는 flexible checksum 헤더를 일부 S3 호환
      // 구현(Oracle 포함)이 서명에 넣지 않아 SignatureDoesNotMatch 가 난다.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  // ── 키 처리 ──────────────────────────────────────────────

  /**
   * 스토리지 키를 검증하고 버킷 내 오브젝트 키로 변환한다.
   * LocalStorageBackend.resolvePath 의 CR-6 가드와 동일한 규칙을 적용한다 —
   * 오브젝트 스토리지엔 경로 탈출 개념이 없지만, keyPrefix 밖으로 새어나가는
   * 것을 막고 두 백엔드의 동작을 일치시키기 위해 같은 입력을 거부한다.
   */
  private toKey(key: string): string {
    if (!key || typeof key !== "string") {
      throw new Error(`Invalid storage key: ${JSON.stringify(key)}`);
    }
    if (key.includes("\0")) {
      throw new Error("Storage key must not contain NUL character");
    }
    if (key.startsWith("/") || key.startsWith("\\")) {
      throw new Error(`Storage key must be relative, got absolute: ${key}`);
    }
    const norm = key.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
    if (norm.split("/").some((s) => s === "..")) {
      throw new Error(`Path traversal rejected: key "${key}"`);
    }
    return this.keyPrefix + norm;
  }

  /**
   * 접두사를 오브젝트 키 접두사로 변환한다. 키와 달리 **빈 문자열을 허용**하며
   * 이는 "이 백엔드가 담당하는 keyPrefix 아래 전부" 를 뜻한다 (인스턴스 파기 용도).
   * LocalStorageBackend 는 빈 접두사를 거부하지만, 거부는 기능이 아니라 제약이므로
   * 여기서는 상위 호환으로 허용한다.
   */
  private toPrefix(prefix: string): string {
    if (!prefix) return this.keyPrefix;
    return this.toKey(prefix);
  }

  /** 오브젝트 키에서 호출자가 준 키로 되돌린다. */
  private fromKey(objectKey: string): string {
    return this.keyPrefix && objectKey.startsWith(this.keyPrefix)
      ? objectKey.slice(this.keyPrefix.length)
      : objectKey;
  }

  private async body(r: { Body?: unknown }): Promise<Buffer> {
    const b = r.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!b?.transformToByteArray) return Buffer.alloc(0);
    return Buffer.from(await b.transformToByteArray());
  }

  private isNotFound(err: unknown): boolean {
    const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    return e?.name === "NoSuchKey" || e?.name === "NotFound" ||
           e?.Code === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
  }

  // ── 쓰기 ────────────────────────────────────────────────

  async putObject(key: string, content: string | Buffer, opts?: PutObjectOptions): Promise<void> {
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.toKey(key),
      Body: buf,
      ContentType: opts?.contentType,
      // S3 사용자 메타데이터 키는 소문자로 정규화된다. 값은 ASCII 만 안전하므로
      // 비 ASCII 가 섞일 수 있는 값은 호출자가 인코딩해 보내야 한다.
      Metadata: opts?.metadata,
    }));
    this.logger?.debug?.(`${TAG} putObject: ${key} (${buf.length} bytes)`);
  }

  /**
   * 세그먼트 추가. 각 호출이 고유 키에 쓰므로 원자적이고 경합이 없다.
   * 키 접두사에 epoch 밀리초를 0 패딩해 넣어 사전순 = 시간순을 보장한다.
   * (동일 ms 에 겹치면 UUID 로 갈리고, 그 경우의 순서는 정의되지 않는다 —
   *  JSONL 라인 단위 기록이라 줄 순서가 뒤집혀도 의미가 깨지지 않는다.)
   */
  async appendObject(key: string, content: string | Buffer): Promise<void> {
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    const seg = `${String(Date.now()).padStart(14, "0")}-${randomUUID()}`;
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${this.toKey(key)}${SEG_DIR}${seg}`,
      Body: buf,
      IfNoneMatch: "*", // 같은 키를 덮어쓰는 일이 없도록 (충돌 시 예외 → 상위에서 인지)
    }));
    this.logger?.debug?.(`${TAG} appendObject: ${key} (+${buf.length} bytes, seg=${seg})`);
  }

  // ── 읽기 ────────────────────────────────────────────────

  async getObject(key: string): Promise<StorageObject | null> {
    const k = this.toKey(key);

    // 1) 일반 오브젝트 우선
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: k }));
      return {
        key,
        content: await this.body(r),
        contentType: r.ContentType,
        metadata: r.Metadata,
        lastModified: r.LastModified,
        size: r.ContentLength,
      };
    } catch (err) {
      if (!this.isNotFound(err)) throw err;
    }

    // 2) append 로 만들어진 키라면 세그먼트를 이어붙인다
    const segs = await this.listAllKeys(`${k}${SEG_DIR}`);
    if (segs.length === 0) return null;
    segs.sort((a, b) => (a.Key! < b.Key! ? -1 : a.Key! > b.Key! ? 1 : 0));

    const parts: Buffer[] = [];
    for (const s of segs) {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: s.Key! }));
      parts.push(await this.body(r));
    }
    const content = Buffer.concat(parts);
    const last = segs[segs.length - 1];
    this.logger?.debug?.(`${TAG} getObject(append): ${key} ← ${segs.length} segments`);
    return { key, content, lastModified: last.LastModified, size: content.length };
  }

  async exists(key: string): Promise<boolean> {
    const k = this.toKey(key);
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: k }));
      return true;
    } catch (err) {
      if (!this.isNotFound(err)) throw err;
    }
    const segs = await this.listAllKeys(`${k}${SEG_DIR}`, 1);
    return segs.length > 0;
  }

  /** 접두사 아래 오브젝트를 전부(또는 limit 까지) 모은다. */
  private async listAllKeys(prefix: string, limit = 10_000) {
    const out: Array<{ Key?: string; Size?: number; LastModified?: Date }> = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: prefix, ContinuationToken: token,
        MaxKeys: Math.min(1000, limit - out.length),
      }));
      out.push(...(r.Contents ?? []));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token && out.length < limit);
    return out;
  }

  /**
   * 접두사 아래 나열. LocalStorageBackend 와 시맨틱을 맞춘다:
   *   recursive=false → 바로 아래 항목만. 하위 디렉터리는 isDirectory 로 표기
   *   recursive=true  → 전부 평탄하게
   * append 세그먼트 디렉터리는 내부 구현이므로 목록에서 감추고, 대신 그 부모를
   * 하나의 파일 항목처럼 보이게 한다.
   */
  async listObjects(prefix: string, opts?: ListObjectsOptions): Promise<ListResult> {
    const maxKeys = opts?.maxKeys ?? 100;
    const recursive = opts?.recursive ?? false;
    const raw = this.toPrefix(prefix);
    const base = raw.endsWith("/") || raw === "" ? raw : `${raw}/`;

    const entries: ListEntry[] = [];
    const seen = new Set<string>();
    let token: string | undefined;

    do {
      const r = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: base,
        Delimiter: recursive ? undefined : "/",
        ContinuationToken: token,
        MaxKeys: 1000,
      }));

      for (const c of r.Contents ?? []) {
        if (!c.Key) continue;
        const segAt = c.Key.indexOf(SEG_DIR);
        // 세그먼트는 부모 키 하나로 접어서 보여준다
        const key = segAt >= 0 ? this.fromKey(c.Key.slice(0, segAt)) : this.fromKey(c.Key);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({
          key, size: segAt >= 0 ? 0 : (c.Size ?? 0),
          lastModified: c.LastModified ?? new Date(0), isDirectory: false,
        });
      }
      for (const p of r.CommonPrefixes ?? []) {
        if (!p.Prefix) continue;
        if (p.Prefix.includes(SEG_DIR)) continue;     // 세그먼트 디렉터리는 숨긴다
        const key = this.fromKey(p.Prefix.replace(/\/$/, ""));
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ key, size: 0, lastModified: new Date(0), isDirectory: true });
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token && entries.length < 10_000);

    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    // marker 기반 페이지네이션 — LocalStorageBackend 와 동일한 방식
    let start = 0;
    if (opts?.marker) {
      const i = entries.findIndex((e) => e.key === opts.marker);
      if (i >= 0) start = i + 1;
    }
    const page = entries.slice(start, start + maxKeys);
    const hasMore = start + maxKeys < entries.length;
    return {
      entries: page,
      nextMarker: hasMore ? page[page.length - 1]?.key : undefined,
      total: entries.length,
    };
  }

  // ── 삭제 ────────────────────────────────────────────────

  /** 멱등. 존재하지 않아도 예외를 던지지 않는다. 세그먼트도 함께 지운다. */
  async deleteObject(key: string): Promise<void> {
    const k = this.toKey(key);
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: k }));
    } catch (err) {
      if (!this.isNotFound(err)) throw err;
    }
    const segs = await this.listAllKeys(`${k}${SEG_DIR}`);
    if (segs.length) await this.deleteKeys(segs.map((s) => s.Key!));
    this.logger?.debug?.(`${TAG} deleteObject: ${key}`);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const raw = this.toPrefix(prefix);
    if (!raw && !this.keyPrefix) {
      throw new Error("deleteByPrefix(\"\") 는 keyPrefix 가 설정된 백엔드에서만 허용된다 (버킷 전체 삭제 방지)");
    }
    // "a/b" 로 지울 때 "a/bc" 가 딸려가지 않도록 정확한 오브젝트와 하위를 나눠 센다
    const exact = await this.listAllKeys(raw).then((l) => l.filter((o) => o.Key === raw));
    const under = await this.listAllKeys(raw.endsWith("/") ? raw : `${raw}/`);
    const segs = await this.listAllKeys(`${raw}${SEG_DIR}`);
    const keys = [...new Set([...exact, ...under, ...segs].map((o) => o.Key!))];
    if (keys.length) await this.deleteKeys(keys);
    this.logger?.debug?.(`${TAG} deleteByPrefix: ${prefix} → ${keys.length} objects`);
    return keys.length;
  }

  /**
   * 개별 삭제를 제한된 동시성으로 실행한다.
   *
   * 벌크 `DeleteObjects` 를 쓰지 않는 이유: Oracle Object Storage 는 이 API 에
   * `Content-MD5` 또는 `x-amz-checksum-*` 헤더를 요구하는데, 다른 S3 호환 구현과
   * 요구사항이 제각각이라 이식성이 떨어진다 (2026-08-20 실측: InvalidRequest 400).
   * 삭제는 인스턴스 파기 등 드문 경로라 개별 호출 비용이 문제되지 않는다.
   */
  private async deleteKeys(keys: string[]): Promise<void> {
    const CONCURRENCY = 8;
    for (let i = 0; i < keys.length; i += CONCURRENCY) {
      await Promise.all(keys.slice(i, i + CONCURRENCY).map((Key) =>
        this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }))
          .catch((err) => { if (!this.isNotFound(err)) throw err; })));
    }
  }
}
