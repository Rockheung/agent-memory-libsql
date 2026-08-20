/** LibsqlVectorStore e2e — 실제 Turso 에 스키마 생성 + L0/L1 왕복 + KNN 확인 */
import { readFileSync } from "node:fs";
import { LibsqlVectorStore } from "./libsql-store.js";
const env = Object.fromEntries(readFileSync(process.env.HOME+"/.config/turso.env","utf8")
  .split("\n").filter(Boolean).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1)];}));

const D = 1024;
const vec = (s: number) => Float32Array.from({length:D},(_,i)=>Math.sin(s*7.3+i*0.11));
let pass=0, fail=0;
const ok=(m:string)=>{console.log("  ✅",m);pass++}, ng=(m:string)=>{console.log("  ❌",m);fail++};

const store = new LibsqlVectorStore(
  { url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN }, D,
  { debug:()=>{}, info:()=>{}, warn:(m:string)=>console.log("   warn:",m.slice(0,400)), error:(m:string)=>console.log("   ERR:",m.slice(0,400)) } as any,
);

const t0 = Date.now();
const r = await store.init({ provider:"openai", model:"bge-m3", dimensions:D });
console.log(`  init ${Date.now()-t0}ms  needsReindex=${r.needsReindex}${r.reason?" ("+r.reason+")":""}`);
store.isDegraded() ? ng("degraded 상태") : ok("정상 초기화");
ok(`capabilities: ${JSON.stringify(store.getCapabilities())}`);

// L0 쓰기 + 검색
for (let i=0;i<12;i++) {
  await store.upsertL0({ id:`e2e-l0-${i}`, sessionKey:"sk", sessionId:"s1",
    teamId: i%2 ? "team-A":"team-B", taskId:"", userId:"u1", agentId:"a1",
    role: i%2?"user":"assistant", messageText:`메시지 ${i} 임베딩 검색 테스트`,
    recordedAt:new Date().toISOString(), timestamp:Date.now() }, vec(i));
}
ok("L0 12건 적재");

const t1 = Date.now();
const hits = await store.searchL0Vector(vec(3), 5);
console.log(`  L0 KNN ${Date.now()-t1}ms`);
hits.length && hits[0].record_id==="e2e-l0-3"
  ? ok(`KNN 정확: 1위 ${hits[0].record_id} score=${hits[0].score.toFixed(4)} text="${hits[0].message_text.slice(0,18)}"`)
  : ng(`KNN 1위가 ${hits[0]?.record_id} (${hits.length}건)`);

const filtered = await store.searchL0Vector(vec(3), 5, undefined, { teamId:"team-B" } as any);
filtered.every(h=>h.team_id==="team-B") && filtered.length
  ? ok(`격리 필터 SQL 적용: ${filtered.length}건 전부 team-B`)
  : ng(`격리 결과 ${filtered.length}건, 팀 ${[...new Set(filtered.map(h=>h.team_id))]}`);

// FTS
const fts = await store.searchL0Fts('"임베딩"', 5);
fts.length ? ok(`FTS5 동작: ${fts.length}건`) : ng("FTS5 결과 0건");

// L1
const now = new Date().toISOString();
await store.upsertL1({ id:"e2e-m1", content:"libSQL 네이티브 벡터로 이전했다", type:"episodic",
  priority:50, scene_name:"작업", source_message_ids:["e2e-l0-1"], metadata:{},
  timestamps:[now], createdAt:now, updatedAt:now,
  sessionKey:"sk", sessionId:"s1", teamId:"team-A", taskId:"", userId:"u1", agentId:"a1",
} as any, vec(77));
const l1 = await store.searchL1Vector(vec(77), 3);
l1.length && l1[0].record_id==="e2e-m1" ? ok(`L1 KNN 정확: "${l1[0].content.slice(0,24)}"`) : ng(`L1 KNN ${l1.length}건`);
console.log(`  countL0=${await store.countL0()} countL1=${await store.countL1()}`);

// 정리
for (let i=0;i<12;i++) await store.deleteL0(`e2e-l0-${i}`);
await store.deleteL1("e2e-m1");
store.close();
console.log(`\n  ═══ PASS ${pass} / FAIL ${fail} ═══`);
process.exit(fail?1:0);
