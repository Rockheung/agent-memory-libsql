# 포크 코드를 담은 memory-core 이미지.
#
# upstream 이미지를 베이스로 쓰고 **바뀐 소스와 추가 의존성만 얹는다.**
# 전체 재빌드(네이티브 모듈 컴파일 포함)를 피할 수 있어 2 OCPU 박스에서도 빠르다.
#
# 왜 의존성을 따로 설치하는가: upstream Dockerfile 이 `npm install --omit=optional`
# 을 쓰는데, 우리는 @libsql/client / @aws-sdk/client-s3 를 optionalDependencies 에
# 뒀다(동적 import 되는 백엔드는 선택 의존성이라는 upstream 관례). 그래서 기본
# 이미지에는 들어있지 않다.
ARG BASE=agentmemory/memory-core:latest
FROM ${BASE}

WORKDIR /app

# 관리형 백엔드 의존성
RUN npm install --no-audit --no-fund --ignore-scripts --legacy-peer-deps \
      @libsql/client@^0.17.4 \
      @aws-sdk/client-s3@^3.1113.0

# 포크에서 바뀐/추가된 소스만 덮어쓴다
COPY MemoryCore/src/ /app/src/

# CMD/ENTRYPOINT/HEALTHCHECK 는 베이스 것을 그대로 상속한다
