import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand
} from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
const TAG = "[storage][s3]";
const SEG_DIR = "/.seg/";
class S3StorageBackend {
  /** @see 파일 상단 "type 이 cos 인 이유" */
  type = "cos";
  s3;
  bucket;
  keyPrefix;
  logger;
  constructor(opts) {
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
      responseChecksumValidation: "WHEN_REQUIRED"
    });
  }
  // ── 키 처리 ──────────────────────────────────────────────
  /**
   * 스토리지 키를 검증하고 버킷 내 오브젝트 키로 변환한다.
   * LocalStorageBackend.resolvePath 의 CR-6 가드와 동일한 규칙을 적용한다 —
   * 오브젝트 스토리지엔 경로 탈출 개념이 없지만, keyPrefix 밖으로 새어나가는
   * 것을 막고 두 백엔드의 동작을 일치시키기 위해 같은 입력을 거부한다.
   */
  toKey(key) {
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
  toPrefix(prefix) {
    if (!prefix) return this.keyPrefix;
    return this.toKey(prefix);
  }
  /** 오브젝트 키에서 호출자가 준 키로 되돌린다. */
  fromKey(objectKey) {
    return this.keyPrefix && objectKey.startsWith(this.keyPrefix) ? objectKey.slice(this.keyPrefix.length) : objectKey;
  }
  async body(r) {
    const b = r.Body;
    if (!b?.transformToByteArray) return Buffer.alloc(0);
    return Buffer.from(await b.transformToByteArray());
  }
  isNotFound(err) {
    const e = err;
    return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.Code === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
  }
  // ── 쓰기 ────────────────────────────────────────────────
  async putObject(key, content, opts) {
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.toKey(key),
      Body: buf,
      ContentType: opts?.contentType,
      // S3 사용자 메타데이터 키는 소문자로 정규화된다. 값은 ASCII 만 안전하므로
      // 비 ASCII 가 섞일 수 있는 값은 호출자가 인코딩해 보내야 한다.
      Metadata: opts?.metadata
    }));
    this.logger?.debug?.(`${TAG} putObject: ${key} (${buf.length} bytes)`);
  }
  /**
   * 세그먼트 추가. 각 호출이 고유 키에 쓰므로 원자적이고 경합이 없다.
   * 키 접두사에 epoch 밀리초를 0 패딩해 넣어 사전순 = 시간순을 보장한다.
   * (동일 ms 에 겹치면 UUID 로 갈리고, 그 경우의 순서는 정의되지 않는다 —
   *  JSONL 라인 단위 기록이라 줄 순서가 뒤집혀도 의미가 깨지지 않는다.)
   */
  async appendObject(key, content) {
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    const seg = `${String(Date.now()).padStart(14, "0")}-${randomUUID()}`;
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: `${this.toKey(key)}${SEG_DIR}${seg}`,
      Body: buf,
      IfNoneMatch: "*"
      // 같은 키를 덮어쓰는 일이 없도록 (충돌 시 예외 → 상위에서 인지)
    }));
    this.logger?.debug?.(`${TAG} appendObject: ${key} (+${buf.length} bytes, seg=${seg})`);
  }
  // ── 읽기 ────────────────────────────────────────────────
  async getObject(key) {
    const k = this.toKey(key);
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: k }));
      return {
        key,
        content: await this.body(r),
        contentType: r.ContentType,
        metadata: r.Metadata,
        lastModified: r.LastModified,
        size: r.ContentLength
      };
    } catch (err) {
      if (!this.isNotFound(err)) throw err;
    }
    const segs = await this.listAllKeys(`${k}${SEG_DIR}`);
    if (segs.length === 0) return null;
    segs.sort((a, b) => a.Key < b.Key ? -1 : a.Key > b.Key ? 1 : 0);
    const parts = [];
    for (const s of segs) {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: s.Key }));
      parts.push(await this.body(r));
    }
    const content = Buffer.concat(parts);
    const last = segs[segs.length - 1];
    this.logger?.debug?.(`${TAG} getObject(append): ${key} \u2190 ${segs.length} segments`);
    return { key, content, lastModified: last.LastModified, size: content.length };
  }
  async exists(key) {
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
  async listAllKeys(prefix, limit = 1e4) {
    const out = [];
    let token;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        ContinuationToken: token,
        MaxKeys: Math.min(1e3, limit - out.length)
      }));
      out.push(...r.Contents ?? []);
      token = r.IsTruncated ? r.NextContinuationToken : void 0;
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
  async listObjects(prefix, opts) {
    const maxKeys = opts?.maxKeys ?? 100;
    const recursive = opts?.recursive ?? false;
    const raw = this.toPrefix(prefix);
    const base = raw.endsWith("/") || raw === "" ? raw : `${raw}/`;
    const entries = [];
    const seen = /* @__PURE__ */ new Set();
    let token;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: base,
        Delimiter: recursive ? void 0 : "/",
        ContinuationToken: token,
        MaxKeys: 1e3
      }));
      for (const c of r.Contents ?? []) {
        if (!c.Key) continue;
        const segAt = c.Key.indexOf(SEG_DIR);
        const key = segAt >= 0 ? this.fromKey(c.Key.slice(0, segAt)) : this.fromKey(c.Key);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({
          key,
          size: segAt >= 0 ? 0 : c.Size ?? 0,
          lastModified: c.LastModified ?? /* @__PURE__ */ new Date(0),
          isDirectory: false
        });
      }
      for (const p of r.CommonPrefixes ?? []) {
        if (!p.Prefix) continue;
        if (p.Prefix.includes(SEG_DIR)) continue;
        const key = this.fromKey(p.Prefix.replace(/\/$/, ""));
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ key, size: 0, lastModified: /* @__PURE__ */ new Date(0), isDirectory: true });
      }
      token = r.IsTruncated ? r.NextContinuationToken : void 0;
    } while (token && entries.length < 1e4);
    entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    let start = 0;
    if (opts?.marker) {
      const i = entries.findIndex((e) => e.key === opts.marker);
      if (i >= 0) start = i + 1;
    }
    const page = entries.slice(start, start + maxKeys);
    const hasMore = start + maxKeys < entries.length;
    return {
      entries: page,
      nextMarker: hasMore ? page[page.length - 1]?.key : void 0,
      total: entries.length
    };
  }
  // ── 삭제 ────────────────────────────────────────────────
  /** 멱등. 존재하지 않아도 예외를 던지지 않는다. 세그먼트도 함께 지운다. */
  async deleteObject(key) {
    const k = this.toKey(key);
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: k }));
    } catch (err) {
      if (!this.isNotFound(err)) throw err;
    }
    const segs = await this.listAllKeys(`${k}${SEG_DIR}`);
    if (segs.length) await this.deleteKeys(segs.map((s) => s.Key));
    this.logger?.debug?.(`${TAG} deleteObject: ${key}`);
  }
  async deleteByPrefix(prefix) {
    const raw = this.toPrefix(prefix);
    if (!raw && !this.keyPrefix) {
      throw new Error('deleteByPrefix("") \uB294 keyPrefix \uAC00 \uC124\uC815\uB41C \uBC31\uC5D4\uB4DC\uC5D0\uC11C\uB9CC \uD5C8\uC6A9\uB41C\uB2E4 (\uBC84\uD0B7 \uC804\uCCB4 \uC0AD\uC81C \uBC29\uC9C0)');
    }
    const exact = await this.listAllKeys(raw).then((l) => l.filter((o) => o.Key === raw));
    const under = await this.listAllKeys(raw.endsWith("/") ? raw : `${raw}/`);
    const segs = await this.listAllKeys(`${raw}${SEG_DIR}`);
    const keys = [...new Set([...exact, ...under, ...segs].map((o) => o.Key))];
    if (keys.length) await this.deleteKeys(keys);
    this.logger?.debug?.(`${TAG} deleteByPrefix: ${prefix} \u2192 ${keys.length} objects`);
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
  async deleteKeys(keys) {
    const CONCURRENCY = 8;
    for (let i = 0; i < keys.length; i += CONCURRENCY) {
      await Promise.all(keys.slice(i, i + CONCURRENCY).map((Key) => this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key })).catch((err) => {
        if (!this.isNotFound(err)) throw err;
      })));
    }
  }
}
export {
  S3StorageBackend
};
