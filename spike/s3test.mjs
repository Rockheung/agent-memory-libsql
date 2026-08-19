// S3StorageBackend 를 실제 Oracle Object Storage 에 대해 검증한다.
// LocalStorageBackend 와 동작이 일치해야 하는 지점을 중심으로 본다.
import { readFileSync } from "node:fs";
import { S3StorageBackend } from "./t/s3-backend.mjs";
const e = Object.fromEntries(readFileSync(process.env.HOME+"/.config/oci-s3.env","utf8")
  .split("\n").filter(Boolean).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1)];}));

const be = new S3StorageBackend({
  endpoint: e.S3_ENDPOINT, region: e.S3_REGION, bucket: e.S3_BUCKET,
  accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY,
  keyPrefix: "itest/",
});
let pass=0, fail=0;
const ok=m=>{console.log("  ✅",m);pass++}, ng=m=>{console.log("  ❌",m);fail++};

await be.deleteByPrefix("");   // 초기화

console.log("\n[1] put / get / metadata");
await be.putObject("profiles/persona.md", "# 페르소나\n한국어 본문", { contentType:"text/markdown", metadata:{layer:"l3"} });
const g = await be.getObject("profiles/persona.md");
g && g.content.toString("utf-8").includes("한국어 본문") ? ok("UTF-8 본문 왕복") : ng("본문 불일치");
g?.contentType === "text/markdown" ? ok("contentType 보존") : ng(`contentType=${g?.contentType}`);
g?.metadata?.layer === "l3" ? ok("metadata 보존") : ng(`metadata=${JSON.stringify(g?.metadata)}`);

console.log("\n[2] 없는 키 → null (예외 아님)");
(await be.getObject("nope/missing.md")) === null ? ok("null 반환") : ng("null 이 아님");
(await be.exists("nope/missing.md")) === false ? ok("exists=false") : ng("exists 오류");

console.log("\n[3] append — 순차");
for (const l of ["a","b","c"]) await be.appendObject("records/2026-08-20.jsonl", JSON.stringify({l})+"\n");
const j = await be.getObject("records/2026-08-20.jsonl");
const lines = j.content.toString("utf-8").trim().split("\n");
lines.length===3 ? ok(`3줄 이어붙임: ${lines.map(x=>JSON.parse(x).l).join("")}`) : ng(`줄수 ${lines.length}`);
(await be.exists("records/2026-08-20.jsonl")) ? ok("append 키 exists=true") : ng("append 키 exists 실패");

console.log("\n[4] append — 병렬 50 (원자성: 손실 0 이어야 함)");
await Promise.all(Array.from({length:50},(_,i)=>be.appendObject("records/par.jsonl", JSON.stringify({i})+"\n")));
const p = await be.getObject("records/par.jsonl");
const ids = new Set(p.content.toString("utf-8").trim().split("\n").map(x=>JSON.parse(x).i));
ids.size===50 ? ok("50/50 무손실") : ng(`${ids.size}/50 — 손실 발생`);

console.log("\n[5] listObjects");
const nonRec = await be.listObjects("", { maxKeys:50 });
const dirs = nonRec.entries.filter(x=>x.isDirectory).map(x=>x.key).sort();
JSON.stringify(dirs)===JSON.stringify(["profiles","records"]) ? ok(`비재귀 디렉터리: ${dirs}`) : ng(`디렉터리 ${JSON.stringify(dirs)}`);
const rec = await be.listObjects("records", { recursive:true, maxKeys:50 });
const keys = rec.entries.map(x=>x.key).sort();
JSON.stringify(keys)===JSON.stringify(["records/2026-08-20.jsonl","records/par.jsonl"])
  ? ok(`세그먼트가 부모 키로 접힘: ${keys.length}건`) : ng(`키 ${JSON.stringify(keys)}`);

console.log("\n[6] 경로 탈출 거부");
for (const bad of ["../escape.md","/abs.md","a/../../x.md"]) {
  try { await be.putObject(bad,"x"); ng(`거부 안 됨: ${bad}`); } catch { ok(`거부: ${bad}`); }
}

console.log("\n[7] 삭제 (멱등 + 세그먼트 동반)");
await be.deleteObject("records/par.jsonl");
(await be.getObject("records/par.jsonl"))===null ? ok("append 키 삭제 (세그먼트 포함)") : ng("삭제 후에도 남음");
await be.deleteObject("records/par.jsonl");  // 두 번째 호출
ok("두 번 삭제해도 예외 없음 (멱등)");
const n = await be.deleteByPrefix("");
ok(`deleteByPrefix → ${n}개 정리`);

console.log(`\n═══ PASS ${pass} / FAIL ${fail} ═══`);
process.exit(fail?1:0);
