# ⑨ S3StorageBackend — L2/L3 마크다운 + JSONL 을 관리형 스토리지로

브랜치 `feat/s3-storage-backend` / 2026-08-20
검증 대상: Oracle Object Storage (S3 호환, `ap-seoul-1`, 무료 10GB)

**상태: 통합테스트 16/16 통과.**

---

## 무엇을 옮기는가

`IStorageBackend` 하나로 아래가 전부 이동한다 — md 만이 아니다:

```
profiles/<scope>/persona.md          L3 페르소나
profiles/<scope>/scene_blocks/*.md   L2 시나리오
.metadata/checkpoint.json            파이프라인 커서
.metadata/manifest.json
conversations/*.jsonl                L0 원본
records/*.jsonl                      L1 원본
instances/*/memory-generation-logs/  생성 이력
```

## 설계 결정

### type 을 `"cos"` 로 신고한다

`IStorageBackend.type` 은 `"local" | "cos"` 유니온이고 분기점이 **두 곳뿐**이다:

| 위치 | 하는 일 |
|---|---|
| `core/hooks/auto-recall.ts:232` | scene navigation 을 로컬 절대경로가 아니라 오브젝트 키로 렌더 |
| `core/memory-generation-log/store.ts:97` | `"local"` 일 때만 `instances/{id}` 스코프를 덧댐 |

원격 오브젝트 스토리지로서 두 분기 모두 COS 와 같아야 하므로 **유니온을 넓히지 않았다.**
COS 자격증명이 갖는 prefix 역할은 `keyPrefix` 옵션이 대신한다.

### append 를 세그먼트로 쪼갠다 ★

`appendObject` 는 데드코드가 아니다 — `StorageAdapter.appendFile` 을 통해 **7곳**에서 쓰이고
그중 `core/record/l1-writer.ts:259`, `core/conversation/l0-recorder.ts:298` 은 L0/L1 기록 핵심 경로다.

S3 에는 원자적 append 가 없다. 검토한 대안:

| 방식 | 판정 |
|---|---|
| read-modify-write | ❌ upstream 이 CR-1 감사에서 "100 병렬 시 99% 손실" 로 폐기 |
| ETag 낙관적 동시성 (`If-Match`) | ❌ **Oracle 이 `If-Match` 를 서명에 넣지 않아 SignatureDoesNotMatch** (실측) |
| **세그먼트 오브젝트** | ✅ 채택 |

```
appendObject(k, data)  →  PUT {k}/.seg/{epoch14}-{uuid}
getObject(k)           →  {k}/.seg/ 나열 후 키 순서대로 concat
```

각 append 가 고유 키에 쓰므로 경합이 없다. epoch 를 0 패딩해 사전순 = 시간순.
**병렬 50 append 무손실 확인.** 대가는 읽기 비용(LIST + N GET)인데, 이 JSONL 들은
거의 읽히지 않는 감사/백업용이라 수용 가능하다.

`listObjects` 는 세그먼트 디렉터리를 감추고 부모 키 하나로 접어 보여준다 —
호출자에게는 평범한 파일 하나로 보인다.

---

## 실측에서 걸린 함정 4개

문서에 없어서 삽질하기 쉬운 지점들이다.

### 1. 연합(IDCS/SAML) 사용자 자격증명은 S3 호환 API 에서 안 된다 ★

`oci iam user list` 의 첫 사용자가 `oracleidentitycloudservice/...` (SAML) 였고,
여기에 만든 customer secret key 는 계속 `SignatureDoesNotMatch` 를 냈다.
**로컬 사용자**(`identity-provider-id: None`)에 만들어야 한다.

### 2. 자격증명 전파에 시간이 걸린다 (~2분+)

생성 직후 403 이 나고, 더 나쁘게는 **병렬 요청에서 간헐적으로만** 실패한다
(인증 노드별 반영 시차). 순차 20/20 성공인데 병렬 8 중 3 실패 같은 패턴이 나온다.
SDK 버그로 오인하기 쉽다 — 전파가 끝나면 사라진다.

### 3. AWS SDK v3 의 flexible checksum

기본값이 checksum 헤더를 붙이는데 일부 S3 호환 구현이 서명에 포함하지 않는다.
```ts
requestChecksumCalculation: "WHEN_REQUIRED",
responseChecksumValidation: "WHEN_REQUIRED",
```

### 4. 벌크 `DeleteObjects` 는 쓰지 않는다

Oracle 이 `Content-MD5` 또는 `x-amz-checksum-*` 을 요구하는데 구현마다 요구가 다르다
(`InvalidRequest` 400). 개별 삭제 + 동시성 8 로 대체했다. 삭제는 드문 경로라 무해하고
R2/MinIO 어디서나 동작한다.

---

## upstream 수정 범위

`FORK.md` 규약(6곳·100줄 이내)을 지켰다.

| 파일 | 내용 | 줄 |
|---|---|---|
| `core/storage/types.ts` | `StorageBackendConfig.s3` 옵션 추가 | +16 |
| `core/storage/factory.ts` | `case "cos"` 안에서 s3 우선 처리 (동적 import) | +9 |

신규: `core/storage/s3-backend.ts` (약 350 LOC)

## 설정 예

```yaml
storage:
  type: cos
  s3:
    endpoint: "https://<namespace>.compat.objectstorage.ap-seoul-1.oraclecloud.com"
    region: ap-seoul-1
    bucket: memory-store
    accessKeyId: "..."
    secretAccessKey: "..."
    keyPrefix: "prod/"     # 선택. COS 자격증명 prefix 와 같은 역할
```

## 남은 것

- [ ] `@aws-sdk/client-s3` 를 MemoryCore 의 optional dependency 로 추가
- [ ] 게이트웨이 config 파서가 `storage.s3` 를 읽도록 배선 (현재는 팩토리까지만)
- [ ] R2 에서도 통합테스트 통과 확인 (이식성)
