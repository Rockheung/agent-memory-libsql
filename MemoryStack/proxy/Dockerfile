# memory-proxy — 번들 이미지.
#
# upstream 이미지는 소스(.ts)를 그대로 넣고 런타임에 tsx 로 트랜스파일한다.
# 여러 백엔드를 다 지원해야 하는 범용 배포물이라 그게 맞지만, 우리는 구성을
# 고정했으므로 도달 가능한 코드만 번들해서 배포용으로 만든다.
#
# 포크 수정: verifyUserKey 가 커널 호출 시 Authorization: Bearer 를 보내지 않아
# 커널에 API key 를 켜면 인증이 전부 401 이 되는 문제 (FORK.md 참조).

# ── 1단계: 번들 ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /build

COPY MemoryProxy/package.json MemoryProxy/package-lock.json* ./
RUN npm install --no-audit --no-fund --ignore-scripts --legacy-peer-deps

COPY MemoryProxy/src/ ./src/

# better-sqlite3 는 네이티브 바인딩을 런타임 require 로 찾으므로 번들 불가.
# storage/factory.ts 가 lazy require 로 감싸지만 우리는 sqlite 스토리지를
# 실제로 쓴다(proxy_kv 캐시) — 런타임 스테이지에 설치한다.
RUN ./node_modules/@esbuild/linux-arm64/bin/esbuild src/index.ts \
      --bundle --platform=node --target=node22 --format=esm \
      --outfile=/build/proxy.js \
      --external:better-sqlite3 \
      --external:node-pty \
      --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"

# ── 2단계: 런타임 ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl tini \
 && rm -rf /var/lib/apt/lists/*

# better-sqlite3 는 prebuild 를 받으므로 컴파일 도구가 필요 없다.
RUN npm install --no-audit --no-fund --omit=dev better-sqlite3@^12.5.0 \
 && npm cache clean --force

COPY --from=build /build/proxy.js /app/proxy.js
RUN printf '{"type":"module"}' > /app/package.json

# 비루트. upstream 베이스도 app 유저로 돈다 — 배포용이면 지켜야 한다.
# PROXY_DB_PATH 가 /data 아래라 쓰기 권한이 필요하다.
RUN useradd -r -u 10001 -m -d /home/app app \
 && mkdir -p /data/tdai-memory-proxy /app/conf \
 && chown -R app:app /data /app
USER app

# 베이스 이미지가 ENV 로 갖고 있던 값들. 번들 이미지는 상속받지 못한다.
ENV NODE_ENV=production \
    PROXY_DB_PATH=/data/tdai-memory-proxy/proxy.db \
    NODE_OPTIONS=--max-old-space-size=1536

EXPOSE 8096
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sS -o /dev/null --max-time 3 http://127.0.0.1:8096/ || exit 1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/proxy.js", "--config", "/app/conf/config.yaml"]
