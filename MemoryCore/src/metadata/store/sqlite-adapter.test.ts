/**
 * SqliteMetadataStore 계약 테스트 하네스.
 *
 * upstream OSS 릴리스에는 *.test.ts 가 하나도 없다 — 계약 스위트 본체
 * (metadata-store.contract.ts, 854 LOC) 는 남아있고 **호출부만 제거**됐다.
 * 다른 백엔드를 붙이기 전에 기준선을 세우기 위해 호출부를 복원한다.
 */
import { runMetadataStoreContract } from "./metadata-store.contract.js";
import { SqliteMetadataStore } from "./sqlite-adapter.js";
import type { IMetadataStore } from "./interface.js";

runMetadataStoreContract(
  "sqlite",
  async (): Promise<IMetadataStore> => new SqliteMetadataStore(":memory:"),
  async (store: IMetadataStore) => { await store.close(); },
);
