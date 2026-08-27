# memory-core — 번들 이미지.
#
# 이전에는 upstream 이미지를 베이스로 소스만 얹었다. 그러면 upstream 의
# node_modules 571MB 를 통째로 들고 다닌다. 그중 274MB 가 tcvdb-text 의
# BM25 사전(bm25_en 192MB + bm25_zh 82MB)인데, 우리 libSQL 스토어는 이걸
# 쓰지 않는다 — FTS5 내장 bm25() 랭크 함수를 쓴다(희소 벡터는 TCVDB 전용).
#
# 그래서 esbuild 로 단일 파일로 말고 slim 런타임에 올린다.

# ── 1단계: 번들 ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /build

COPY MemoryCore/package.json MemoryCore/package-lock.json* ./
# 번들에 필요한 것만. 네이티브 모듈은 어차피 external 이라 컴파일을 건너뛴다.
RUN npm install --no-audit --no-fund --ignore-scripts --legacy-peer-deps \
 && npm install --no-audit --no-fund --ignore-scripts --legacy-peer-deps \
      @libsql/client@^0.17.4 @aws-sdk/client-s3@^3.1113.0

COPY MemoryCore/src/ ./src/
COPY MemoryStack/core/stubs/ ./stubs/

# external 로 빼는 것들은 전부 우리가 쓰지 않는 경로다:
#   tcvdb-text  → 스텁으로 대체(stubs/tcvdb-text.mjs). 274MB BM25 사전이 통째로
#                 빠진다. @node-rs/jieba 도 이것이 끌고 오던 것이라 같이 사라진다.
#   @libsql/client              → 네이티브 바인딩(@libsql/linux-arm64-gnu)을 런타임
#                                 require 로 찾는다. 번들에 못 넣으므로 런타임 설치.
#   @node-rs/jieba              → 런타임에 별도 설치한다(아래). libsql-store 가
#                                 require 로 부르고 없으면 정규식 분할로 떨어지는데,
#                                 그건 토큰화 품질을 조용히 낮추는 것이라 넣는다. 14MB.
#   sqlite-vec                  → sqlite 백엔드
#   node-llama-cpp              → 로컬 임베딩(우리는 원격)
#   */cos-backend.js            → OSS 릴리스에 파일 자체가 없다(upstream 이
#                                 런타임 try/catch 로 감싼다). 번들러는 죽으므로 제외.
RUN ./node_modules/@esbuild/linux-arm64/bin/esbuild src/gateway/server.ts \
      --bundle --platform=node --target=node22 --format=esm \
      --outfile=/build/server.js \
      --alias:@tencentdb-agent-memory/tcvdb-text=/build/stubs/tcvdb-text.mjs \
      --external:@node-rs/jieba \
      --external:@libsql/client \
      --external:sqlite-vec \
      --external:node-llama-cpp \
      --external:'*/cos-backend.js' \
      --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"

# ── 2단계: 런타임 ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl tini \
 && rm -rf /var/lib/apt/lists/*

# 번들에서 external 로 뺀 것 중 런타임에 실제로 필요한 유일한 패키지.
# 번들에서 external 로 뺀 것 중 런타임에 실제로 필요한 패키지들.
RUN npm install --no-audit --no-fund --omit=dev \
      @node-rs/jieba@^2.0.1 \
      @libsql/client@^0.17.4 \
 && npm cache clean --force

# 확장자가 .js 여야 한다. server.ts:24 의 main 가드가
#   process.argv[1]?.endsWith("server.ts") || endsWith("server.js")
# 라서, .mjs 로 두면 main() 이 안 불리고 **로그 없이 exit 0** 한다.
# ESM 으로 실행하려면 옆에 type=module 이 필요하다.
COPY --from=build /build/server.js /app/server.js
RUN printf '{"type":"module"}' > /app/package.json

ENV NODE_ENV=production
EXPOSE 8420
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${TDAI_GATEWAY_PORT:-8420}/health" || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/server.js"]
