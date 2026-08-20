/** Skill 활성 상태로 게이트웨이 기동 → HTTP API 로 끝까지 확인 */
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import http from "node:http";
import { TdaiGateway } from "./src/gateway/server.js";
import { loadGatewayConfig } from "./src/gateway/config.js";

const PORT=18713, KEY="verify-skill";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"vskill-"));
let pass=0, fail=0;
const ok=(m:string)=>{console.log("  ✅",m);pass++}, ng=(m:string)=>{console.log("  ❌",m);fail++};
const req=(p:string,body:unknown,hdr:Record<string,string>={})=>
  new Promise<{status:number;body:any}>((res,rej)=>{const j=JSON.stringify(body);
    const r=http.request(new URL(p,`http://127.0.0.1:${PORT}`),{method:"POST",headers:{
      "Content-Type":"application/json","Content-Length":Buffer.byteLength(j),
      "x-tdai-service-id":"default",Authorization:`Bearer ${KEY}`,...hdr}},
      rs=>{let d="";rs.on("data",c=>d+=c);rs.on("end",()=>{try{res({status:rs.statusCode!,body:JSON.parse(d)})}catch{res({status:rs.statusCode!,body:d})}})});
    r.on("error",rej);r.write(j);r.end();});

{ const { createClient } = await import("@libsql/client");
  const c = createClient({ url: process.env.TDAI_METADATA_LIBSQL_URL!, authToken: process.env.TDAI_METADATA_LIBSQL_AUTH_TOKEN });
  for (const t of ["meta_user_keys","meta_team_members","meta_task_agents","meta_asset_acl","meta_fixed_asset_bindings",
                   "meta_assets","meta_tasks","meta_agents","meta_teams","meta_users",
                   "l0_conversations","l0_vec","l0_fts","l1_records","l1_vec","l1_fts","skills","skill_fts","skill_vec"])
    await c.execute(`DELETE FROM ${t}`).catch(()=>{});
  c.close(); }

const cfg = loadGatewayConfig({
  server:{port:PORT,host:"127.0.0.1",apiKey:KEY}, data:{baseDir:tmp},
  llm:{baseUrl:process.env.LLM_BASE_URL!,apiKey:process.env.LLM_API_KEY!,model:"gpt-5.6-sol-low"},
} as any);
(cfg.memory as any).storeBackend="libsql";
(cfg.memory as any).libsql={url:process.env.TDAI_STORE_LIBSQL_URL,authToken:process.env.TDAI_STORE_LIBSQL_AUTH_TOKEN};
(cfg.memory as any).embedding={enabled:true,provider:"openai",baseUrl:"http://192.168.88.223:11434/v1",
  apiKey:"ollama",model:"bge-m3",dimensions:1024,sendDimensions:false,timeoutMs:30000,
  maxInputChars:5000,conflictRecallTopK:5,recallTimeoutMs:15000};
// ★ Skill 활성
(cfg as any).skill={ enabled:true, routing:{mode:"bm25",searchTopK:20},
  extraction:{enabled:false}, resources:{maxResourceSizeBytes:5000000} };
(cfg.memory as any).skill=(cfg as any).skill;

const gw=new TdaiGateway(cfg);
await gw.start();

const admin=await req("/v3/internal/meta/user/init-admin",{username:`vs-${Date.now().toString(36)}`});
const key=admin.body?.data?.user_key, uid=admin.body?.data?.user_id;
const H={"x-tdai-user-key":key};
const team=await req("/v3/meta/team/create",{name:"vs-team",owner_user_id:uid},H); const tid=team.body?.data?.team_id;
const agent=await req("/v3/meta/agent/create",{team_id:tid,name:"vs-agent",owner_user_id:uid},H); const aid=agent.body?.data?.agent_id;
const ids={team_id:tid,agent_id:aid,user_id:uid};
console.log(`  준비: team=${tid} agent=${aid}\n`);

const create=await req("/v3/skill/create",{...ids,
  name:"s3-compat-storage",
  description:"Oracle/R2 에 S3 백엔드를 붙일 때의 함정",
  // SKILL.md 는 frontmatter 가 필수다 (skill-format.ts:49)
  content:[
    "---",
    "name: s3-compat-storage",
    "description: Oracle/R2 에 S3 백엔드를 붙일 때의 함정",
    "---",
    "",
    "# S3 호환 스토리지 연결",
    "",
    "- AWS SDK v3 checksum 을 WHEN_REQUIRED 로 끌 것",
    "- Oracle 은 로컬 사용자에 secret key 생성 (연합/SAML 사용자는 S3 호환 API 불가)",
    "- 자격증명 전파에 2분+ 걸린다. 병렬 실패를 SDK 버그로 오인하지 말 것",
    "- 벌크 DeleteObjects 는 구현마다 checksum 요구가 달라 개별 삭제가 안전",
  ].join("\n"),
  // 첨부 리소스 — SkillResourceStore 가 주입된 StorageAdapter(S3)로 쓴다
  resources:[{ path:"probe.sh", encoding:"utf-8", is_executable:true,
    content:"#!/bin/sh\n# S3 자격증명 전파 확인\ncurl -sS --aws-sigv4 \"aws:amz:$1:s3\" --user \"$2:$3\" \"$4/?list-type=2\"\n" }],
},H);
// envelope code 가 0 이어야 성공 (HTTP 200 이어도 code 로 실패를 싣는다)
create.body?.code === 0
  ? ok(`skill/create → ${create.body?.data?.skill_id}`)
  : ng(`skill/create code=${create.body?.code}: ${String(create.body?.message).slice(0,140)}`);
const sid=create.body?.data?.skill_id;

const list=await req("/v3/skill/list",{...ids,limit:10},H);
(list.body?.data?.total ?? 0)>=1 ? ok(`skill/list total=${list.body.data.total}`) : ng(`skill/list ${list.status} ${JSON.stringify(list.body).slice(0,120)}`);

const search=await req("/v3/skill/search",{...ids,query:"checksum Oracle 자격증명",limit:5},H);
(search.body?.data?.items?.length ?? 0)>=1
  ? ok(`skill/search → ${search.body.data.items.length}건 "${search.body.data.items[0]?.skill?.name ?? search.body.data.items[0]?.name}"`)
  : ng(`skill/search ${search.status} ${JSON.stringify(search.body).slice(0,150)}`);

if (sid) {
  const get=await req("/v3/skill/get",{...ids,skill_id:sid},H);
  get.status===200 ? ok(`skill/get 왕복`) : ng(`skill/get ${get.status}`);
}


// 첨부가 S3 로 갔는지 manifest 로 확인
if (sid) {
  const g=await req("/v3/skill/get",{...ids,skill_id:sid,include_manifest:true},H);
  const mf=g.body?.data?.manifest ?? g.body?.data?.skill?.manifest;
  Array.isArray(mf) && mf.length
    ? ok(`manifest 에 첨부 ${mf.length}건: ${mf[0]?.path}`)
    : ng(`manifest 비어있음: ${JSON.stringify(g.body?.data).slice(0,140)}`);
}

console.log(`\n  ═══ PASS ${pass} / FAIL ${fail} ═══`);
await gw.stop(); fs.rmSync(tmp,{recursive:true,force:true});
process.exit(fail?1:0);
