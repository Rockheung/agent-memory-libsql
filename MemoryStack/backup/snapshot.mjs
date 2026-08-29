#!/usr/bin/env node
/**
 * 메모리 스택 스냅샷 — Turso DB + S3 마크다운/JSONL 을 한 디렉터리로 내린다.
 *
 * 컨테이너 안에서 돌린다 (core 이미지에 @libsql/client, @aws-sdk/client-s3 가 있다).
 *   docker compose --profile backup run --rm backup
 *
 * 출력: /backup/<YYYYMMDD-HHMMSS>/
 *   turso.db.gz        임베디드 리플리카 동기화본 (그대로 sqlite3 로 열린다)
 *   s3/<key>           버킷 객체를 원본 경로 그대로
 *   manifest.json      행 수·바이트·소요시간·integrity_check 결과
 *
 * 실패하면 0 이 아닌 코드로 죽는다 — systemd 가 failed 로 잡게.
 */
import { createClient } from "@libsql/client";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile, readdir } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";

const OUT_ROOT = process.env.BACKUP_DIR || "/backup";
const KEEP = Number(process.env.BACKUP_KEEP || 14);
const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`env ${k} 가 비었다`); return v; };

// UTC 기준 타임스탬프. 로케일에 따라 이름이 흔들리면 보존 정렬이 깨진다.
const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "-").slice(0, 15);
const dir = join(OUT_ROOT, ts);
const manifest = { startedAt: new Date().toISOString(), snapshot: ts, turso: {}, s3: {} };

async function backupTurso() {
  const t0 = Date.now();
  const raw = join(dir, "turso.db");
  // 자체 호스팅 sqld 는 인증 없이 127.0.0.1 바인딩으로 쓴다 — 토큰이 없다.
  // 관리형 Turso 로 되돌리면 .env 에 토큰이 채워지고 아래가 그대로 붙는다.
  const token = process.env.TURSO_AUTH_TOKEN || undefined;
  const c = createClient({
    url: "file:" + raw,
    syncUrl: need("TURSO_URL"),
    ...(token ? { authToken: token } : {}),
  });
  await c.sync();

  // 받은 파일이 실제로 열리고 온전한지 확인한다. 백업은 복구되어야 백업이다.
  const chk = await c.execute("PRAGMA integrity_check");
  const integrity = String(chk.rows[0]?.integrity_check ?? chk.rows[0]?.[0] ?? "?");
  if (integrity !== "ok") throw new Error(`integrity_check 실패: ${integrity}`);

  const counts = {};
  const tables = await c.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  for (const { name } of tables.rows) {
    const r = await c.execute(`SELECT count(*) n FROM "${name}"`);
    const n = Number(r.rows[0].n);
    if (n > 0) counts[name] = n;
  }
  // gz 를 뜨기 전에 WAL 을 본체로 밀어넣는다. 안 하면 turso.db.gz 만 복구했을 때
  // WAL 에만 있던 프레임이 사라진다 — 조용히 일부만 복구되는 최악의 형태다.
  await c.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  c.close();

  const rawBytes = (await stat(raw)).size;
  await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(raw + ".gz"));
  const gzBytes = (await stat(raw + ".gz")).size;
  // 본체는 gz 안에 있다. 곁딸린 파일은 전부 지운다 — 남겨두면 복구할 때
  // "이것도 같이 복원해야 하나" 를 고민하게 만든다.
  for (const suffix of ["", "-info", "-client_wal_index", "-shm", "-wal"]) {
    await rm(raw + suffix, { force: true });
  }

  manifest.turso = { integrity, rawBytes, gzBytes, tables: counts, ms: Date.now() - t0 };
  console.log(`turso: ${(rawBytes / 1048576).toFixed(1)}MB → gz ${(gzBytes / 1048576).toFixed(1)}MB, ` +
    `${Object.keys(counts).length} 테이블, ${Date.now() - t0}ms`);
}

async function backupS3() {
  const t0 = Date.now();
  const s3 = new S3Client({
    region: process.env.S3_REGION || "us-ashburn-1",
    endpoint: need("S3_ENDPOINT"),
    credentials: { accessKeyId: need("S3_ACCESS_KEY_ID"), secretAccessKey: need("S3_SECRET_ACCESS_KEY") },
    forcePathStyle: true,
    // Oracle 은 기본 체크섬 계산에서 SignatureDoesNotMatch 를 낸다. docs/08 참조.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const Bucket = need("S3_BUCKET");
  const Prefix = process.env.S3_PREFIX || "";
  let token, objects = 0, bytes = 0;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken: token }));
    for (const o of page.Contents || []) {
      const dest = join(dir, "s3", o.Key);
      await mkdir(dirname(dest), { recursive: true });
      const body = await s3.send(new GetObjectCommand({ Bucket, Key: o.Key }));
      await pipeline(body.Body, createWriteStream(dest));
      objects++; bytes += o.Size ?? 0;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  manifest.s3 = { bucket: Bucket, prefix: Prefix, objects, bytes, ms: Date.now() - t0 };
  console.log(`s3: ${objects} 객체 ${(bytes / 1048576).toFixed(1)}MB, ${Date.now() - t0}ms`);
}

async function prune() {
  const all = (await readdir(OUT_ROOT, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && /^\d{8}-\d{6}$/.test(d.name))
    .map((d) => d.name).sort();
  const drop = all.slice(0, Math.max(0, all.length - KEEP));
  for (const d of drop) await rm(join(OUT_ROOT, d), { recursive: true, force: true });
  if (drop.length) console.log(`prune: ${drop.length}개 삭제 (KEEP=${KEEP})`);
  manifest.kept = all.length - drop.length;
}

try {
  await mkdir(dir, { recursive: true });
  await backupTurso();
  await backupS3();
  await prune();
  manifest.finishedAt = new Date().toISOString();
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`OK → ${dir}`);
} catch (e) {
  console.error("스냅샷 실패:", e?.message || e);
  // 반쪽짜리 스냅샷은 남기지 않는다 — 복구 때 온전한 것으로 착각한다.
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
}
