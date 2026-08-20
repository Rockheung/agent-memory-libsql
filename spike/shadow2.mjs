import { createClient } from "@libsql/client";
import { readFileSync } from "fs";
const e=Object.fromEntries(readFileSync(process.env.HOME+"/.config/turso.env","utf8")
  .split("\n").filter(Boolean).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1)];}));
const db=createClient({url:e.TURSO_DATABASE_URL,authToken:e.TURSO_AUTH_TOKEN});
const D=8, vec=s=>"["+Array.from({length:D},(_,i)=>Math.sin(s+i)).join(",")+"]";

const reset = async () => {
  await db.execute("DROP TABLE IF EXISTS sh2");
  await db.execute(`CREATE TABLE sh2(id TEXT PRIMARY KEY, embedding F32_BLOB(${D}))`);
  await db.execute("CREATE INDEX sh2_idx ON sh2(libsql_vector_idx(embedding))");
  for (let i=0;i<3;i++) await db.execute({sql:"INSERT INTO sh2 VALUES(?,vector32(?))",args:[`r${i}`,vec(i)]});
};
const tryIns = async (label) => {
  try { await db.execute({sql:"INSERT INTO sh2 VALUES(?,vector32(?))",args:["z"+Math.random(),vec(9)]});
        console.log("  ✅", label, "→ 이후 삽입 정상"); }
  catch(x){ console.log("  ❌", label, "→ 인덱스 깨짐"); }
};

await reset(); await db.execute("DELETE FROM sh2");                 await tryIns("DELETE FROM t (WHERE 없음)");
await reset(); await db.execute("DELETE FROM sh2 WHERE 1=1");        await tryIns("DELETE FROM t WHERE 1=1");
await reset(); await db.execute("DELETE FROM sh2 WHERE id IS NOT NULL"); await tryIns("DELETE FROM t WHERE id IS NOT NULL");

// 복구 방법이 있는가
await reset(); await db.execute("DELETE FROM sh2");
try { await db.execute("REINDEX sh2_idx"); await tryIns("전체삭제 후 REINDEX"); }
catch(x){ console.log("  —  REINDEX 미지원:", x.message.slice(0,60)); }
await reset();
await db.execute("DROP TABLE IF EXISTS sh2");
console.log("\n  → 복구는 DROP/CREATE 로 가능 (reset 이 매번 성공했다)");
