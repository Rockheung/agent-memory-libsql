import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync } from "fs";
import { randomUUID } from "crypto";
const e = Object.fromEntries(readFileSync(process.env.HOME+"/.config/oci-s3.env","utf8")
  .split("\n").filter(Boolean).map(l=>{const i=l.indexOf("=");return [l.slice(0,i),l.slice(i+1)];}));
const base = { endpoint:e.S3_ENDPOINT, region:e.S3_REGION, forcePathStyle:true,
  credentials:{accessKeyId:e.S3_ACCESS_KEY_ID,secretAccessKey:e.S3_SECRET_ACCESS_KEY},
  requestChecksumCalculation:"WHEN_REQUIRED", responseChecksumValidation:"WHEN_REQUIRED" };
const put = (c) => c.send(new PutObjectCommand({Bucket:e.S3_BUCKET,Key:"disc2/"+randomUUID(),Body:"x"}));
const show = (l,r) => { const b=r.filter(x=>x.status==="rejected");
  console.log(`  ${l} → ${8-b.length}/8` + (b.length?`  [${[...new Set(b.map(x=>x.reason?.Code))]}]`:"  ✅")); };

const shared = new S3Client(base);
show("공유 client       ", await Promise.allSettled(Array.from({length:8},()=>put(shared))));
show("요청마다 새 client", await Promise.allSettled(Array.from({length:8},()=>put(new S3Client(base)))));

// credentials 를 함수로 주면 SDK 가 memoize 경로를 탄다 — 캐시 레이스 여부 확인
const fnCreds = new S3Client({...base, credentials: async () => ({
  accessKeyId:e.S3_ACCESS_KEY_ID, secretAccessKey:e.S3_SECRET_ACCESS_KEY })});
show("credentials=함수  ", await Promise.allSettled(Array.from({length:8},()=>put(fnCreds))));
