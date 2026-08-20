/** LibsqlSkillStore e2e — 실제 Turso 에 대해 스키마·CRUD·버전·검색 확인 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { LibsqlSkillStore } from "./libsql-skill-store.js";
const env = Object.fromEntries(readFileSync(process.env.HOME+"/.config/turso.env","utf8")
  .split("\n").filter(Boolean).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1)];}));

let pass=0, fail=0;
const ok=(m:string)=>{console.log("  ✅",m);pass++}, ng=(m:string)=>{console.log("  ❌",m);fail++};
const store = new LibsqlSkillStore({
  url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN, dimensions: 1024,
  logger: { debug:()=>{}, info:()=>{}, warn:(m:string)=>console.log("   warn:",m.slice(0,200)),
            error:(m:string)=>console.log("   ERR:",m.slice(0,300)) } as any,
});

const t0=Date.now(); await store.init(); console.log(`  init ${Date.now()-t0}ms`);
store.isDegraded() ? ng("degraded") : ok("정상 초기화");
ok(`capabilities: ${JSON.stringify(store.getCapabilities())}`);

const scope = { team_id:"team-e2e", agent_id:"agt-e2e", user_id:"usr-e2e", task_id:"" };
const SKILL_ID = "sk-e2e-" + Date.now().toString(36);
const hash = (c: string) => createHash("sha256").update(c).digest("hex").slice(0, 32);
const c1 = `# S3 호환 스토리지 연결\n\n- AWS SDK v3 checksum 을 WHEN_REQUIRED 로 끌 것\n- Oracle 은 연합(SAML) 사용자 말고 로컬 사용자에 secret key 생성\n- 자격증명 전파에 2분+ 걸린다. 병렬 실패를 SDK 버그로 오인하지 말 것`;
const s1 = await store.appendVersion({ ...scope, skill_id: SKILL_ID, content_hash: hash(c1),
  name:"s3-호환-스토리지-붙이기",
  description:"Oracle/R2 에 S3 백엔드를 붙일 때의 함정 모음",
  content: c1,
  manifest: [], storage_dir:"skills/s3", metadata:{},
} as any);
s1?.skill_id ? ok(`appendVersion → ${s1.skill_id} v${s1.version}`) : ng("appendVersion 실패");

const head = await store.getHead(s1.skill_id, scope.team_id);
head?.name===s1.name ? ok(`getHead 왕복: "${head.name}"`) : ng("getHead 불일치");

const c2 = s1.content + "\n- 벌크 DeleteObjects 는 구현마다 checksum 요구가 달라 개별 삭제가 안전";
const s2 = await store.appendVersion({ ...scope, skill_id:s1.skill_id, content_hash: hash(c2),
  name:s1.name, description:s1.description, content: c2,
  manifest: [], storage_dir:"skills/s3", metadata:{} } as any);
s2.version === s1.version+1 ? ok(`버전 증가: v${s1.version} → v${s2.version}`) : ng(`버전 ${s2.version}`);
const vs = await store.listVersions(s1.skill_id, scope.team_id);
vs.length===2 ? ok(`listVersions 2건`) : ng(`listVersions ${vs.length}건`);

const list = await store.listSkills({ team_id:scope.team_id, limit:10, offset:0 } as any);
list.total>=1 ? ok(`listSkills total=${list.total}`) : ng("listSkills 0건");

const found = await store.searchSkills({ query:"checksum 스토리지", team_id:scope.team_id, limit:5 } as any);
found.length ? ok(`searchSkills(BM25): ${found.length}건 — "${found[0].skill.name}"`) : ng("searchSkills 0건");

const arch = await store.archiveHead(s1.skill_id, scope.team_id);
arch.archived ? ok("archiveHead") : ng("archive 실패");
(await store.getHead(s1.skill_id, scope.team_id))===null ? ok("보관 후 getHead=null") : ng("보관 후에도 조회됨");

console.log(`\n  ═══ PASS ${pass} / FAIL ${fail} ═══`);
process.exit(fail?1:0);
