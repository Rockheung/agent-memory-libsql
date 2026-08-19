import Database from "libsql";
import { readFileSync } from "fs";
const e = Object.fromEntries(readFileSync(process.env.HOME+"/.config/turso.env","utf8")
  .split("\n").filter(Boolean).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1)];}));
const db = new Database(e.TURSO_DATABASE_URL, { authToken: e.TURSO_AUTH_TOKEN });
db.prepare("select 1").get();   // 워밍업

// 1) 정상상태 지연
const lat=[]; for(let i=0;i<10;i++){const t=Date.now();db.prepare("select 1 as x").get();lat.push(Date.now()-t);}
lat.sort((a,b)=>a-b);
console.log(`  동기 호출 지연: 중앙값 ${lat[5]}ms (min ${lat[0]} / max ${lat[9]})`);

// 2) 이벤트 루프 차단 측정 — 타이머가 얼마나 밀리는가
let maxDelay = 0, ticks = 0;
let last = Date.now();
const timer = setInterval(() => { const now=Date.now(); maxDelay=Math.max(maxDelay, now-last-10); last=now; ticks++; }, 10);
await new Promise(r => setTimeout(r, 100));   // 기준선
const baseline = maxDelay; maxDelay = 0; last = Date.now();

const t0 = Date.now();
for (let i=0;i<10;i++) db.prepare("select 1 as x").get();   // 동기 10회
const elapsed = Date.now()-t0;
await new Promise(r => setTimeout(r, 50));
clearInterval(timer);

console.log(`  기준선 타이머 지터: ${baseline}ms`);
console.log(`  동기 10회 중 타이머 최대 지연: ${maxDelay}ms  (총 소요 ${elapsed}ms)`);
console.log(maxDelay > 50 ? "  ⚠️  이벤트 루프가 막힌다 — 게이트웨이가 요청을 직렬화한다"
                          : "  ✅ 이벤트 루프 차단 없음 (내부적으로 비동기 처리)");

// 3) _metadata 필드 유무 (행 순회 코드가 깨질 수 있다)
db.exec("CREATE TABLE IF NOT EXISTS mt(id TEXT PRIMARY KEY, v TEXT)");
db.prepare("INSERT OR REPLACE INTO mt VALUES(?,?)").run("a","1");
const g = db.prepare("SELECT * FROM mt").get();
const a = db.prepare("SELECT * FROM mt").all();
console.log(`  get() 키: ${Object.keys(g)}`);
console.log(`  all() 키: ${Object.keys(a[0])}`);
console.log(Object.keys(g).includes("_metadata") ? "  ⚠️  get() 에 _metadata 가 섞인다 — 행 스프레드/키순회 주의" : "  ✅ 여분 필드 없음");
const r = db.prepare("INSERT OR REPLACE INTO mt VALUES(?,?)").run("b","2");
console.log(`  run() 반환: ${JSON.stringify(r)}`);
db.exec("DROP TABLE mt");
