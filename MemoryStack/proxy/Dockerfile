# 포크 코드를 담은 memory-proxy 이미지.
#
# upstream 이미지 위에 바뀐 소스만 얹는다. 고친 것은 하나뿐이다:
# verifyUserKey 가 커널 호출 시 Authorization: Bearer 를 보내지 않아
# 커널에 API key 를 켜면 인증이 전부 401 이 되는 문제 (FORK.md 참조).
ARG BASE=agentmemory/memory-proxy:latest
FROM ${BASE}
WORKDIR /app
COPY MemoryProxy/src/ /app/src/
