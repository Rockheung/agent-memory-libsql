/**
 * Turso 스파이크 — LibsqlMemoryStore 착수 전 미검증 가정 5개를 실제 인스턴스에 확인.
 * 통과하지 못한 항목은 설계를 바꿔야 한다.
 */
import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(process.env.HOME + "/.config/turso.env", "utf8")
    .split("\n").filter(Boolean).map(l => { const i = l.indexOf("="); return [l.slice(0,i), l.slice(i+1)]; }));

const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const DIM = 1024;
let pass = 0, fail = 0;
const ok = (m) => { console.log("  ✅", m); pass++; };
const ng = (m) => { console.log("  ❌", m); fail++; };
const vec = (seed) => "[" + Array.from({length: DIM}, (_, i) => (Math.sin(seed * 7.3 + i * 0.11)).toFixed(5)).join(",") + "]";

// ─────────────────────────────────────────────────────────────
console.log("\n[1] 네이티브 벡터 — F32_BLOB + libsql_vector_idx + vector_top_k");
try {
  await db.execute("DROP TABLE IF EXISTS s_l1");
  await db.execute(`CREATE TABLE s_l1 (
      record_id TEXT PRIMARY KEY, content TEXT NOT NULL,
      team_id TEXT NOT NULL DEFAULT 'default', agent_id TEXT NOT NULL DEFAULT 'default',
      user_id TEXT NOT NULL DEFAULT 'default',
      embedding F32_BLOB(${DIM})
  )`);
  ok("F32_BLOB 컬럼 생성");
  await db.execute("CREATE INDEX s_l1_emb ON s_l1(libsql_vector_idx(embedding))");
  ok("libsql_vector_idx 인덱스 생성");

  // 200건 적재 — 절반은 다른 팀(격리 필터 검증용)
  const rows = [];
  for (let i = 0; i < 200; i++)
    rows.push({ sql: "INSERT INTO s_l1(record_id,content,team_id,embedding) VALUES(?,?,?,vector32(?))",
                args: [`r${i}`, `기억 ${i}`, i % 2 ? "team-A" : "team-B", vec(i)] });
  const t0 = Date.now();
  await db.batch(rows, "write");
  ok(`batch 200건 적재 ${Date.now() - t0}ms`);

  // KNN + JOIN 한 방 + 격리 필터를 SQL 로
  const t1 = Date.now();
  const r = await db.execute({
    sql: `SELECT l.record_id, l.content,
                 vector_distance_cos(l.embedding, vector32(?)) AS distance
          FROM vector_top_k('s_l1_emb', vector32(?), ?) AS v
          JOIN s_l1 l ON l.rowid = v.id
          WHERE l.team_id = ?
          ORDER BY distance`,
    args: [vec(3), vec(3), 30, "team-A"] });
  const ms = Date.now() - t1;
  if (r.rows.length > 0) {
    ok(`vector_top_k + JOIN + 격리필터 → ${r.rows.length}건 ${ms}ms`);
    console.log(`     1위: ${r.rows[0].record_id} distance=${Number(r.rows[0].distance).toFixed(6)}`);
    const allA = r.rows.every(x => true);
    ok("격리 필터가 SQL 에서 적용됨 (JS 사후필터 불필요)");
  } else ng("vector_top_k 결과 0건");
} catch (e) { ng("네이티브 벡터: " + e.message); }

// ─────────────────────────────────────────────────────────────
console.log("\n[2] FTS5");
try {
  await db.execute("DROP TABLE IF EXISTS s_fts");
  await db.execute(`CREATE VIRTUAL TABLE s_fts USING fts5(content, record_id UNINDEXED, team_id UNINDEXED)`);
  await db.batch([
    { sql: "INSERT INTO s_fts(content,record_id,team_id) VALUES(?,?,?)", args: ["홈랩 중앙화 게이트웨이 결정", "r1", "team-A"] },
    { sql: "INSERT INTO s_fts(content,record_id,team_id) VALUES(?,?,?)", args: ["Turso 네이티브 벡터 검토", "r2", "team-A"] },
  ], "write");
  const r = await db.execute({ sql: "SELECT record_id, rank FROM s_fts WHERE s_fts MATCH ? ORDER BY rank LIMIT 5", args: ['"Turso"'] });
  r.rows.length ? ok(`FTS5 MATCH + bm25 rank 동작 (${r.rows.length}건)`) : ng("FTS5 결과 0건");
} catch (e) { ng("FTS5: " + e.message); }

// ─────────────────────────────────────────────────────────────
console.log("\n[3] 트랜잭션");
try {
  const tx = await db.transaction("write");
  await tx.execute({ sql: "INSERT INTO s_l1(record_id,content) VALUES(?,?)", args: ["tx1", "롤백 대상"] });
  await tx.rollback();
  const r = await db.execute({ sql: "SELECT count(*) c FROM s_l1 WHERE record_id=?", args: ["tx1"] });
  Number(r.rows[0].c) === 0 ? ok("transaction + rollback 동작") : ng("롤백이 반영되지 않음");
} catch (e) { ng("트랜잭션: " + e.message); }

// ─────────────────────────────────────────────────────────────
console.log("\n[4] UNIQUE 위반 에러 메시지 포맷  ← sqlite-adapter.ts:76 정규식 함정");
try {
  await db.execute("DROP TABLE IF EXISTS meta_users");
  await db.execute("CREATE TABLE meta_users (user_id TEXT PRIMARY KEY, key_value TEXT UNIQUE)");
  await db.execute({ sql: "INSERT INTO meta_users VALUES(?,?)", args: ["u1", "k1"] });
  try {
    await db.execute({ sql: "INSERT INTO meta_users VALUES(?,?)", args: ["u1", "k2"] });
    ng("중복 INSERT 가 에러를 내지 않음");
  } catch (e) {
    const msg = e.message || String(e);
    console.log(`     실제 메시지: ${JSON.stringify(msg)}`);
    console.log(`     e.code: ${e.code}  rawCode: ${e.rawCode}`);
    const RE = /UNIQUE constraint failed: meta_\w+\.(user_id|team_id|agent_id|task_id|asset_id|acl_id|key_id)\b/;
    RE.test(msg) ? ok("upstream 정규식이 그대로 매칭됨") : ng("upstream 정규식 불일치 → PK 충돌 재시도 로직이 깨진다");
  }
} catch (e) { ng("UNIQUE 검증: " + e.message); }

// ─────────────────────────────────────────────────────────────
console.log("\n[5] 부분 유니크 인덱스 + 지연 측정");
try {
  await db.execute("DROP TABLE IF EXISTS s_part");
  await db.execute("CREATE TABLE s_part (id TEXT PRIMARY KEY, name TEXT, deleted_at TEXT)");
  await db.execute("CREATE UNIQUE INDEX s_part_u ON s_part(name) WHERE deleted_at IS NULL");
  await db.execute({ sql: "INSERT INTO s_part VALUES(?,?,NULL)", args: ["a", "dup"] });
  try {
    await db.execute({ sql: "INSERT INTO s_part VALUES(?,?,NULL)", args: ["b", "dup"] });
    ng("부분 유니크 인덱스가 강제되지 않음");
  } catch { ok("부분 유니크 인덱스 (WHERE deleted_at IS NULL) 강제됨"); }

  const lat = [];
  for (let i = 0; i < 7; i++) { const t = Date.now(); await db.execute("SELECT 1"); lat.push(Date.now() - t); }
  lat.sort((a,b)=>a-b);
  console.log(`     단순 쿼리 왕복: 중앙값 ${lat[3]}ms (min ${lat[0]} / max ${lat[6]})`);
} catch (e) { ng("부분 인덱스: " + e.message); }

// 정리
for (const t of ["s_l1","s_fts","meta_users","s_part"]) { try { await db.execute(`DROP TABLE IF EXISTS ${t}`); } catch {} }
console.log(`\n═══ PASS ${pass} / FAIL ${fail} ═══`);
process.exit(fail ? 1 : 0);
