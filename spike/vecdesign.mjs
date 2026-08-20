import { createClient } from "@libsql/client";
import { readFileSync } from "fs";
const e=Object.fromEntries(readFileSync(process.env.HOME+"/.config/turso.env","utf8")
  .split("\n").filter(Boolean).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1)];}));
const db=createClient({url:e.TURSO_DATABASE_URL,authToken:e.TURSO_AUTH_TOKEN});
const D=1024, vec=s=>"["+Array.from({length:D},(_,i)=>Math.sin(s*7.3+i*0.11).toFixed(5)).join(",")+"]";
const ok=m=>console.log("  ✅",m), ng=m=>console.log("  ❌",m);

for (const t of ["d_l1_vec","d_l1_records"]) await db.execute(`DROP TABLE IF EXISTS ${t}`);

// 안 A: 벡터를 별도 테이블에 두고 record_id 로 본표와 조인 (기존 구조 보존)
await db.execute(`CREATE TABLE d_l1_records(
  record_id TEXT PRIMARY KEY, content TEXT, type TEXT,
  team_id TEXT NOT NULL DEFAULT 'default', agent_id TEXT NOT NULL DEFAULT 'default',
  user_id TEXT NOT NULL DEFAULT 'default', updated_time TEXT DEFAULT '')`);
await db.execute(`CREATE TABLE d_l1_vec(
  record_id TEXT PRIMARY KEY, embedding F32_BLOB(${D}), updated_time TEXT DEFAULT '')`);
try {
  await db.execute("CREATE INDEX d_l1_vec_idx ON d_l1_vec(libsql_vector_idx(embedding))");
  ok("TEXT PRIMARY KEY 테이블에 벡터 인덱스 생성");
} catch(x){ ng("벡터 인덱스: "+x.message); process.exit(1); }

const N=300;
for (let b=0;b<N;b+=100) {
  await db.batch(Array.from({length:100},(_,j)=>{
    const i=b+j, team=`team-${i%4}`;
    return [{sql:"INSERT INTO d_l1_records VALUES(?,?,?,?,?,?,?)",args:[`r${i}`,`내용 ${i}`,"episodic",team,"agt-1","usr-1","2026-08-20"]},
            {sql:"INSERT INTO d_l1_vec VALUES(?,vector32(?),?)",args:[`r${i}`,vec(i),"2026-08-20"]}];
  }).flat(),"write");
}
ok(`적재 ${N}건 (본표 + 벡터표)`);

// 이중 JOIN + 격리 필터 + 메타데이터 동시 취득 (= N+1 제거)
const t0=Date.now();
const r=await db.execute({sql:`
  SELECT v.record_id, r.content, r.type, r.team_id,
         vector_distance_cos(v.embedding, vector32(?)) AS distance
  FROM vector_top_k('d_l1_vec_idx', vector32(?), ?) AS k
  JOIN d_l1_vec v ON v.rowid = k.id
  JOIN d_l1_records r ON r.record_id = v.record_id
  WHERE r.team_id = ?
  ORDER BY distance LIMIT 5`,
  args:[vec(42),vec(42),40,"team-2"]});
const ms=Date.now()-t0;
if (r.rows.length) {
  ok(`이중 JOIN + 격리필터 + 메타 동시취득 → ${r.rows.length}건 ${ms}ms`);
  console.log(`     1위 ${r.rows[0].record_id} d=${Number(r.rows[0].distance).toFixed(6)} team=${r.rows[0].team_id} content="${r.rows[0].content}"`);
  r.rows.every(x=>x.team_id==="team-2") ? ok("모든 결과가 격리 조건 충족") : ng("격리 위반 결과 포함");
} else ng("결과 0건");

// upsert = delete + insert 가 벡터 인덱스에서도 되는가
await db.execute({sql:"DELETE FROM d_l1_vec WHERE record_id=?",args:["r42"]});
await db.execute({sql:"INSERT INTO d_l1_vec VALUES(?,vector32(?),?)",args:["r42",vec(999),"2026-08-21"]});
const r2=await db.execute({sql:`SELECT v.record_id FROM vector_top_k('d_l1_vec_idx', vector32(?), 3) AS k
  JOIN d_l1_vec v ON v.rowid=k.id`,args:[vec(999)]});
r2.rows[0]?.record_id==="r42" ? ok("delete+insert 후 인덱스 반영 (upsert 경로)") : ng(`upsert 후 1위가 ${r2.rows[0]?.record_id}`);

// 만료 삭제 (updated_time 기준)
const d=await db.execute({sql:"DELETE FROM d_l1_vec WHERE updated_time != '' AND updated_time < ?",args:["2026-08-21"]});
ok(`만료 삭제 ${d.rowsAffected}건`);

for (const t of ["d_l1_vec","d_l1_records"]) await db.execute(`DROP TABLE IF EXISTS ${t}`);
