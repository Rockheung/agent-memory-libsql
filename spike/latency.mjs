import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(process.env.HOME+"/.config/turso.env","utf8")
  .split("\n").filter(Boolean).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1)];}));
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const DIM=1024, vec=s=>"["+Array.from({length:DIM},(_,i)=>Math.sin(s*7.3+i*0.11).toFixed(5)).join(",")+"]";

await db.execute("DROP TABLE IF EXISTS m_l1");
await db.execute(`CREATE TABLE m_l1(record_id TEXT PRIMARY KEY, content TEXT, team_id TEXT, agent_id TEXT, embedding F32_BLOB(${DIM}))`);
await db.execute("CREATE INDEX m_l1_emb ON m_l1(libsql_vector_idx(embedding))");

// 2000건 — 실사용 규모에 가깝게. 팀 4개로 분산 (격리 필터 히트율 25%)
const CH=200;
for (let b=0;b<2000;b+=CH){
  await db.batch(Array.from({length:CH},(_,j)=>({sql:"INSERT INTO m_l1 VALUES(?,?,?,?,vector32(?))",
    args:[`r${b+j}`,`기억 ${b+j}`,`team-${(b+j)%4}`,"agt-1",vec(b+j)]})),"write");
}
console.log("적재 2000건 완료\n");

const knn = async (k, team) => {
  const t=Date.now();
  const r = await db.execute({ sql:`SELECT l.record_id, vector_distance_cos(l.embedding, vector32(?)) d
      FROM vector_top_k('m_l1_emb', vector32(?), ?) v JOIN m_l1 l ON l.rowid=v.id
      ${team?"WHERE l.team_id=?":""} ORDER BY d LIMIT 5`,
    args: team?[vec(42),vec(42),k,team]:[vec(42),vec(42),k] });
  return { ms: Date.now()-t, n: r.rows.length };
};

console.log("── 정상상태 KNN 지연 (k=20, 필터 없음) ──");
const lat=[]; for(let i=0;i<8;i++){ const r=await knn(20,null); lat.push(r.ms); }
lat.sort((a,b)=>a-b);
console.log(`  중앙값 ${lat[4]}ms   min ${lat[0]}  max ${lat[7]}`);

console.log("\n── 격리 필터 시 over-fetch 필요량 (목표 5건) ──");
for (const k of [5,10,20,40,80]) {
  const r = await knn(k, "team-2");
  console.log(`  k=${k.toString().padStart(3)}  →  ${r.n}건 확보  ${r.ms}ms  ${r.n>=5?"✅":"❌ 부족"}`);
}
await db.execute("DROP TABLE IF EXISTS m_l1");
