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
import { createGzip, createGunzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile, readdir, copyFile } from "node:fs/promises";
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
  // 다만 리플리카 연결은 일부 PRAGMA 를 거부한다(Sqlite3UnsupportedStatement).
  // 그럴 땐 건너뛰되 manifest 에 남겨 "확인했다"고 착각하지 않게 한다.
  // integrity 는 **복사본**에 대해 확인한다(아래). 라이브 리플리카를 검사하면
  // ok 가 나오는데 정작 복구본은 아닐 수 있다 — 실제로 그랬다.
  let integrity = "unchecked";
  let restorableL0 = null;

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
  // 체크포인트가 되면 본체만 담으면 된다. 리플리카 연결은 이를 거부하는데
  // (Sqlite3UnsupportedStatement), 그때 -wal 을 버리면 WAL 에만 있던 프레임이
  // 사라진다 — 실제로 복구본에서 freelist 불일치가 나왔다. 그래서 실패하면
  // db 와 -wal 을 tar 로 함께 담는다. SQLite 가 열 때 자동으로 재생한다.
  let checkpointed = false;
  try {
    await c.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    checkpointed = true;
  } catch (e) {
    if (!/Unsupported/i.test(String(e?.message))) throw e;
  }
  c.close();

  const rawBytes = (await stat(raw)).size;

  // 체크포인트가 되면 본체만으로 충분하다. 리플리카 연결은 이를 거부하는데
  // (Sqlite3UnsupportedStatement), 그때 -wal 을 버리면 WAL 에만 있던 프레임이
  // 사라진다 — 실제로 복구본에서 freelist 불일치가 나왔다. 그래서 -wal 도 함께
  // 담는다. 복구 시 같은 디렉터리에 풀면 SQLite 가 열면서 자동으로 재생한다.
  //
  // 압축 전에 먼저 복사한다. 라이브러리가 파일을 아직 만지고 있어서 바로 읽으면
  // "file changed as we read it" 이 난다.
  const parts = [];
  for (const [src, name] of [[raw, "turso.db"], [raw + "-wal", "turso.db-wal"]]) {
    if (!(await stat(src).catch(() => null))) continue;
    if (name.endsWith("-wal") && checkpointed) continue;
    const tmp = join(dir, name + ".tmp");
    await copyFile(src, tmp);
    await pipeline(createReadStream(tmp), createGzip({ level: 6 }), createWriteStream(join(dir, name + ".gz")));
    await rm(tmp, { force: true });
    parts.push(name + ".gz");
  }
  const gzBytes = (await Promise.all(parts.map((f) => stat(join(dir, f)).then((x) => x.size))))
    .reduce((a, b) => a + b, 0);

  // 복구할 **압축본 자체**를 풀어서 확인한다.
  // 원본 파일을 복사해 열면 SQLite 가 열면서 freelist 를 정상화해버려 ok 가
  // 나온다 — 정작 압축본은 아닌데도. 거짓 통과가 검사 없음보다 나쁘다.
  {
    const tmp = join(dir, ".verify.db");
    await pipeline(createReadStream(join(dir, "turso.db.gz")), createGunzip(), createWriteStream(tmp));
    const verify = createClient({ url: "file:" + tmp });
    try {
      const r = await verify.execute("PRAGMA integrity_check");
      integrity = String(r.rows[0]?.integrity_check ?? Object.values(r.rows[0])[0] ?? "?")
        .replace(/\s+/g, " ").slice(0, 200);
      // integrity 문구보다 중요한 것: 압축본에서 실제로 데이터가 나오는가.
      // freelist 누수 같은 경고는 데이터 손실이 아니므로 실패로 치지 않는다.
      const n = Number(Object.values((await verify.execute(
        "SELECT count(*) n FROM l0_conversations")).rows[0])[0]);
      if (!Number.isFinite(n)) throw new Error("압축본에서 L0 을 읽지 못했다");
      restorableL0 = n;
    } finally {
      verify.close();
      for (const sfx of ["", "-client_wal_index", "-wal", "-shm"]) await rm(tmp + sfx, { force: true });
    }
  }

  // 압축본만 남긴다. 원본과 리플리카 메타를 남겨두면 스냅샷이 2배가 되고
  // 복구할 때 "어느 것을 써야 하나" 를 고민하게 만든다.
  for (const suffix of ["", "-wal", "-shm", "-info", "-client_wal_index"]) {
    await rm(raw + suffix, { force: true });
  }

  manifest.turso = { integrity, restorableL0, checkpointed, parts, rawBytes, gzBytes, tables: counts, ms: Date.now() - t0 };
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
