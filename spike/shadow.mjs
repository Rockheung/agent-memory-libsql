import { createClient } from "@libsql/client";
import { readFileSync } from "fs";
const e=Object.fromEntries(readFileSync(process.env.HOME+"/.config/turso.env","utf8")
  .split("\n").filter(Boolean).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1)];}));
const db=createClient({url:e.TURSO_DATABASE_URL,authToken:e.TURSO_AUTH_TOKEN});
const D=8, vec=s=>"["+Array.from({length:D},(_,i)=>Math.sin(s+i)).join(",")+"]";
const ok=m=>console.log("  ✅",m), ng=m=>console.log("  ❌",m);

await db.execute("DROP TABLE IF EXISTS sh_t");
await db.execute(`CREATE TABLE sh_t(id TEXT PRIMARY KEY, embedding F32_BLOB(${D}))`);
await db.execute("CREATE INDEX sh_idx ON sh_t(libsql_vector_idx(embedding))");
const ins = async (i) => db.execute({sql:"INSERT INTO sh_t VALUES(?,vector32(?))",args:[`r${i}`,vec(i)]});
for (let i=0;i<5;i++) await ins(i);
ok("초기 5건 적재");

// 1) 개별 DELETE 후 재삽입 (스토어의 upsert = delete+insert 경로)
await db.execute({sql:"DELETE FROM sh_t WHERE id=?",args:["r2"]});
try { await ins(2); ok("개별 DELETE → 재삽입 정상 (upsert 경로 안전)"); }
catch(x){ ng("개별 DELETE 후 재삽입 실패: "+x.message.slice(0,80)); }

// 2) 조건부 대량 DELETE 후 삽입 (만료 삭제 경로)
await db.execute("DELETE FROM sh_t WHERE id LIKE 'r%'");
try { await ins(99); ok("조건부 대량 DELETE → 삽입 정상 (만료 삭제 경로 안전)"); }
catch(x){ ng("대량 DELETE 후 삽입 실패: "+x.message.slice(0,80)); }

// 3) 전체 DELETE (내 정리 스크립트가 한 것)
await db.execute("DELETE FROM sh_t");
try { await ins(100); ok("전체 DELETE → 삽입 정상"); }
catch(x){ ng("전체 DELETE 후 삽입 실패 → 이것이 원인: "+x.message.slice(0,90)); }
await db.execute("DROP TABLE IF EXISTS sh_t");
