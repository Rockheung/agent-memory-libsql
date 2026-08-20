/**
 * Manifest — self-describing metadata for a memory-tdai data directory.
 *
 * Lives at `<dataDir>/.metadata/manifest.json`.
 *
 * - **store**: written once on first successful store init; never overwritten.
 *   On subsequent starts the current config is compared against the persisted
 *   store binding — mismatches are logged at debug level (informational only).
 * - **seed**: written once when a seed run completes; null for live-runtime dirs.
 *
 * This file is informational / read-only from the user's perspective.
 * The plugin reads it on startup for consistency checks.
 *
 * ## 왜 이 파일만 `IStorageBackend` 를 안 거치고 `node:fs` 를 직접 쓰는가
 *
 * manifest 의 목적이 **"이 데이터 디렉터리가 어떤 스토어에 묶여 있었나"** 를 확인하는
 * 것이라, 스토어/스토리지가 준비되기 **전에** 읽혀야 한다. 이걸 스토리지 추상화로
 * 읽으면 "스토리지를 확인하려고 스토리지를 써야 하는" 순환이 된다.
 *
 * 따라서 원격 백엔드(libsql/S3)를 쓰더라도 이 파일 하나는 로컬에 남는다. **의도된
 * 예외다.** 정보성 파일이라 유실돼도 다음 기동에 다시 만들어지고, 기억 데이터
 * (L0~L3 / Skill)는 전혀 영향받지 않는다.
 */

import fs from "node:fs";
import path from "node:path";

// ============================
// Types
// ============================

export interface ManifestStoreInfo {
  type: "sqlite" | "libsql" | "tcvdb";
  sqlite?: {
    /** Relative path to the SQLite DB file (relative to dataDir). */
    path: string;
  };
  libsql?: {
    /** libSQL/Turso 접속 URL. 인증 토큰은 비밀정보라 기록하지 않는다. */
    url: string;
  };
  tcvdb?: {
    url: string;
    database: string;
    /** User-friendly alias (optional). */
    alias?: string;
  };
}

export interface ManifestSeedInfo {
  /** Original input file name (basename only). */
  inputFile?: string;
  sessions: number;
  rounds: number;
  messages: number;
  startedAt: string;
  completedAt: string;
}

export interface Manifest {
  /** Schema version for future migrations. */
  version: 1;
  /** Timestamp when the manifest was first created. */
  createdAt: string;
  /** Store binding — written once on first init. */
  store: ManifestStoreInfo;
  /** Seed run info — null for live-runtime directories. */
  seed: ManifestSeedInfo | null;
}

// ============================
// Paths
// ============================

const METADATA_DIR = ".metadata";
const MANIFEST_FILE = "manifest.json";

export function manifestPath(dataDir: string): string {
  return path.join(dataDir, METADATA_DIR, MANIFEST_FILE);
}

// ============================
// Read / Write
// ============================

/**
 * Read an existing manifest from disk. Returns `null` if not found or unparseable.
 */
export function readManifest(dataDir: string): Manifest | null {
  const p = manifestPath(dataDir);
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

/**
 * Write a manifest to disk (creates `.metadata/` if needed).
 */
export function writeManifest(dataDir: string, manifest: Manifest): void {
  const dir = path.join(dataDir, METADATA_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    manifestPath(dataDir),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
}

// ============================
// Store binding helpers
// ============================

export interface StoreConfigSnapshot {
  type: "sqlite" | "libsql" | "tcvdb";
  sqlitePath?: string;
  /** libSQL/Turso 접속 URL (type="libsql"). 토큰은 담지 않는다. */
  libsqlUrl?: string;
  tcvdbUrl?: string;
  tcvdbDatabase?: string;
  tcvdbAlias?: string;
}

/**
 * Build a ManifestStoreInfo from the current store config snapshot.
 */
export function buildStoreInfo(snapshot: StoreConfigSnapshot): ManifestStoreInfo {
  const info: ManifestStoreInfo = { type: snapshot.type };
  if (snapshot.type === "sqlite") {
    info.sqlite = { path: snapshot.sqlitePath ?? "vectors.db" };
  } else if (snapshot.type === "libsql") {
    info.libsql = { url: snapshot.libsqlUrl ?? "" };
  } else {
    info.tcvdb = {
      url: snapshot.tcvdbUrl!,
      database: snapshot.tcvdbDatabase!,
      alias: snapshot.tcvdbAlias || undefined,
    };
  }
  return info;
}

/**
 * Compare the persisted store binding against the current config.
 * Returns a list of human-readable mismatch descriptions (empty = all good).
 */
export function diffStoreBinding(
  persisted: ManifestStoreInfo,
  current: ManifestStoreInfo,
): string[] {
  const diffs: string[] = [];

  if (persisted.type !== current.type) {
    diffs.push(`store type changed: ${persisted.type} → ${current.type}`);
    return diffs; // no point comparing fields across different types
  }

  if (persisted.type === "sqlite" && current.type === "sqlite") {
    if (persisted.sqlite?.path !== current.sqlite?.path) {
      diffs.push(`sqlite path changed: ${persisted.sqlite?.path} → ${current.sqlite?.path}`);
    }
  }

  if (persisted.type === "libsql" && current.type === "libsql") {
    if (persisted.libsql?.url !== current.libsql?.url) {
      diffs.push(`libsql url changed: ${persisted.libsql?.url} → ${current.libsql?.url}`);
    }
  }

  if (persisted.type === "tcvdb" && current.type === "tcvdb") {
    if (persisted.tcvdb?.url !== current.tcvdb?.url) {
      diffs.push(`tcvdb url changed: ${persisted.tcvdb?.url} → ${current.tcvdb?.url}`);
    }
    if (persisted.tcvdb?.database !== current.tcvdb?.database) {
      diffs.push(`tcvdb database changed: ${persisted.tcvdb?.database} → ${current.tcvdb?.database}`);
    }
  }

  return diffs;
}
