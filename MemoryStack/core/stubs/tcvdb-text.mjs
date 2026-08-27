/**
 * `@tencentdb-agent-memory/tcvdb-text` 스텁.
 *
 * 원본 패키지는 274MB 다 — BM25 IDF 사전 두 개(bm25_en 192MB + bm25_zh 82MB).
 * 이건 TCVDB 의 **희소 벡터** 인코딩용이고, 우리 libSQL 스토어는 쓰지 않는다.
 * libsql-store / libsql-skill-store 의 "BM25" 는 SQLite FTS5 내장 bm25() 랭크
 * 함수이지 이 인코더가 아니다(둘 다 BM25LocalEncoder 를 참조조차 하지 않는다).
 *
 * 그런데 `core/store/bm25-local.ts` 가 이 패키지를 **최상위 정적 import** 해서,
 * 실제로 쓰지 않아도 모듈 로드 단계에서 필요해진다. upstream 파일을 고치면
 * 리베이스 부담이 늘어나므로 esbuild --alias 로 이 스텁을 끼운다.
 *
 * 따라서 `bm25.enabled: false` 여야 한다 — 그러면 createBM25Encoder 가
 * undefined 를 돌려주고 아래 생성자는 영원히 호출되지 않는다.
 */
export class BM25Encoder {
  static default() {
    throw new Error(
      "[stub] @tencentdb-agent-memory/tcvdb-text 는 이 빌드에 포함되지 않았다. " +
        "BM25 희소 벡터는 TCVDB 백엔드 전용이며 libSQL 스토어는 FTS5 내장 bm25() 를 쓴다. " +
        "정말 필요하면 설정에서 bm25.enabled=true 로 두지 말고, 원본 패키지를 " +
        "포함하도록 MemoryStack/core/Dockerfile 의 --alias 를 제거할 것.",
    );
  }
  encodeTexts() { return BM25Encoder.default(); }
  encodeQueries() { return BM25Encoder.default(); }
}
export default { BM25Encoder };
