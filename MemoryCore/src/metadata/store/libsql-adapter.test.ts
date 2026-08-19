/**
 * LibsqlMetadataStore 계약 테스트.
 *
 * SqliteMetadataStore 와 **동일한 스위트**(metadata-store.contract.ts)를 돌린다.
 * 로컬 libSQL 파일에 대해 검증하며, 원격 Turso 는 별도 e2e 로 확인한다
 * (계약 테스트는 케이스마다 새 DB 를 만들므로 원격에 돌리면 느리고 쿼터를 먹는다).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMetadataStoreContract } from "./metadata-store.contract.js";
import { LibsqlMetadataStore } from "./libsql-adapter.js";
import type { IMetadataStore } from "./interface.js";

const dirs: string[] = [];

runMetadataStoreContract(
  "libsql",
  async (): Promise<IMetadataStore> => {
    const dir = mkdtempSync(join(tmpdir(), "libsql-meta-"));
    dirs.push(dir);
    return new LibsqlMetadataStore({ url: `file:${join(dir, "metadata.db")}` });
  },
  async (store: IMetadataStore) => {
    await store.close();
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  },
);
