# 02 · 接口契约

本文件定义本地 BFF 与远端网关之间的公开契约，以及前端使用的本地接口映射。所有示例都在 [`contracts/examples/`](../contracts/examples/)。

## 1. 约定

| 项 | 约定 |
|---|---|
| Base URL | 远端：`http://127.0.0.1:18000/v1`（经 SSH 隧道）；本地：`http://127.0.0.1:8787/api` |
| 版本 | URL 版本 `/v1`；报告内 `schema_version`；只做向后兼容的增量字段 |
| 认证 | `Authorization: Bearer <token>`；Token 只存在于本地 BFF 配置 |
| 内容类型 | JSON：`application/json`；上传：`multipart/form-data`；下载：原始字节 |
| 时间 | ISO 8601 带时区；时长单位秒（字段名 `*_s`）；报告内用 `time_s` |
| 分数 | `0.0–1.0` 浮点；阈值显式返回；概率不是鉴定结论 |
| 坐标 | 归一化 `[x, y, w, h]`，基于 EXIF 旋转后的显示图，保留 4 位小数 |
| ID | 带前缀的 ULID：`ast_…`、`job_…`、`art_…`、`cert_…`、`wm_…`、`req_…` |
| 幂等 | `POST /v1/jobs` 支持 `Idempotency-Key`；资产按 sha256 去重 |
| 分页 | `limit`（默认 20，最大 100）+ `cursor`；返回 `next_cursor` |
| 缓存 | `GET /v1/capabilities` 返回 `ETag`，BFF 缓存 15s |

统一错误信封：

```json
{
  "error": {
    "code": "NO_CAPABILITY",
    "message": "没有模型支持这组输入",
    "hint": "audio.clone 还需要 reference_text；也可以改用 audio.tts",
    "retryable": false,
    "details": {"task": "audio.clone", "missing_roles": ["reference_text"]},
    "request_id": "req_01J..."
  }
}
```

## 2. 端点总览

| 方法 | 路径 | 作用 | 认证 |
|---|---|---|---|
| GET | `/v1/health` | GPU、队列、磁盘、模型状态 | ✓ |
| GET | `/v1/capabilities` | 能力清单（模型 × 任务） | ✓ |
| POST | `/v1/assets` | 上传单个文件，按 sha256 去重 | ✓ |
| GET | `/v1/assets/{id}` | 资产元数据 | ✓ |
| DELETE | `/v1/assets/{id}` | 删除远端资产（尽力） | ✓ |
| POST | `/v1/jobs` | 提交任务（生成/检测/防御） | ✓ |
| GET | `/v1/jobs/{id}` | 任务状态与产物 | ✓ |
| GET | `/v1/jobs` | 任务列表（筛选/分页） | ✓ |
| GET | `/v1/jobs/{id}/events` | SSE 进度与日志 | ✓ |
| POST | `/v1/jobs/{id}/cancel` | 取消任务 | ✓ |
| GET | `/v1/files/{artifact_id}` | 下载产物，支持 Range | ✓ |
| DELETE | `/v1/files/{artifact_id}` | 删除远端产物 | ✓ |
| POST | `/v1/defense/verify` | 校验保护文件的水印与证书 | ✓ |

## 3. 健康检查

`GET /v1/health`

```json
{
  "status": "ok",
  "gateway_version": "0.1.0",
  "uptime_s": 3821,
  "gpu": {"name": "NVIDIA GeForce RTX 4090", "vram_total_gb": 24, "vram_free_gb": 9.4, "utilization": 0.62},
  "queue": {"queued": 1, "running": 1, "max_concurrency": 1},
  "disk": {"free_gb": 128.5, "total_gb": 512, "used_ratio": 0.75},
  "models": [
    {"model_id": "qwen3-tts-1.7b-base", "service": "tts", "status": "ready", "loaded": true},
    {"model_id": "museTalk-v1.5", "service": "vision", "status": "offline", "loaded": false}
  ]
}
```

`status`：`ok` / `degraded`（GPU 可用但模型不足）/ `offline`（GPU 不可用）。BFF 每 10s 轮询；失败 3 次进入 `REMOTE_UNREACHABLE` 横幅。

## 4. 能力清单

`GET /v1/capabilities`

一个模型 × 一个任务 = 一条能力记录。路由器只认这个结构，新增模型不需要改前端。

```json
{
  "gateway_version": "0.1.0",
  "generated_at": "2026-10-31T15:00:00+08:00",
  "capabilities": [
    {
      "model_id": "qwen3-tts-1.7b-base",
      "display_name": "Qwen3-TTS 1.7B Base",
      "task": "audio.clone",
      "service": "tts",
      "required_inputs": ["reference_audio"],
      "optional_inputs": [],
      "required_text": ["reference_text", "target_text"],
      "output_kind": "audio",
      "limits": {
        "max_input_duration_s": 120,
        "min_reference_duration_s": 3,
        "max_reference_duration_s": 30,
        "max_target_chars": 2000,
        "max_file_mb": 50,
        "languages": ["Chinese", "English", "Japanese", "Korean", "German", "French", "Russian", "Portuguese", "Spanish", "Italian"]
      },
      "resources": {"vram_gb": 8, "typical_seconds": 6, "max_concurrency": 1, "gpu_group": "tts"},
      "priority": 100,
      "quality_tier": "high",
      "status": "ready",
      "version": "1.7B",
      "license": "Apache-2.0"
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `required_inputs` / `optional_inputs` | 文件角色；必须在 `inputs` 中出现/可选 |
| `required_text` | 必须在 `text` 中非空的字段 |
| `output_kind` | `audio` / `video` / `image` / `report` |
| `pipeline` | 可选；该任务由多个模型串联时的组件顺序（如 TTS → 唇形），`model_id` 是虚拟编排模型 |
| `limits` | 路由器硬过滤；未声明视为不限 |
| `resources.gpu_group` | 同组模型共享显存，需串行 |
| `status` | `ready` / `loading` / `offline` / `disabled` |
| `priority` | 越大越优先；同 task 的 fallback 顺序 |
| `quality_tier` | `high` / `standard` / `fast`，UI 展示 |

## 5. 资产

### 5.1 上传

`POST /v1/assets`（`multipart/form-data`）

| 字段 | 必填 | 说明 |
|---|---|---|
| `file` | ✓ | 文件本身 |
| `kind` | 否 | `image` / `audio` / `video`；缺省由服务端嗅探 |
| `client_name` | 否 | 原文件名，仅用于展示，不参与路径 |

响应 `201`（新资产）或 `200`（去重命中）：

```json
{
  "asset": {
    "id": "ast_01J9Z8Q2",
    "sha256": "9f2c…",
    "kind": "audio",
    "mime": "audio/wav",
    "size_bytes": 481230,
    "duration_s": 5.12,
    "width": null,
    "height": null,
    "source": "upload",
    "created_at": "2026-10-31T15:00:00+08:00",
    "expires_at": "2026-11-01T15:00:00+08:00"
  },
  "deduplicated": false
}
```

限制：图片 20MB、音频 50MB、视频 500MB；超限 `413 PAYLOAD_TOO_LARGE`。上传中断由 BFF 重试；演示阶段不做断点续传，P6 可加 `POST /v1/uploads` + `PUT /v1/uploads/{id}/parts/{n}`。

### 5.2 查询与删除

- `GET /v1/assets/{id}` → `{asset}`；过期返回 `410 ASSET_EXPIRED`。
- `DELETE /v1/assets/{id}` → `204`；被未完成任务引用时 `409 ASSET_IN_USE`。

## 6. 任务

### 6.1 提交

`POST /v1/jobs`，`Content-Type: application/json`，建议带 `Idempotency-Key: <uuid>`。

```json
{
  "task": "audio.clone",
  "model": "auto",
  "inputs": {"reference_audio": "ast_01J9Z8Q2"},
  "text": {
    "reference_text": "这是我录制的一段参考语音。",
    "target_text": "欢迎使用本地 deepfake 演示平台。",
    "instruct": null
  },
  "options": {"language": "Chinese", "quality": "high", "seed": 42, "strength": null},
  "consent": {"subject": "self", "purpose": "demo", "agreed": true}
}
```

字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `task` | ✓ | 见任务表 |
| `model` | 否 | `auto`（默认）或具体 `model_id`；指定模型仍会做限制校验 |
| `inputs` | ✓ | 角色 → `asset_id`；键必须是该任务声明的角色 |
| `text` | 否 | `target_text` / `reference_text` / `instruct`；长度按能力限制 |
| `options` | 否 | `language`、`quality`（`fast/standard/high`）、`seed`、`strength`（防御 `low/medium/high`） |
| `consent` | ✓ | `agreed=true`，`subject`：`self` / `authorized`；`purpose` 简短说明 |

任务与输入角色：

| task | 文件角色（必需） | 文本字段（必需） | 产物 |
|---|---|---|---|
| `audio.clone` | `reference_audio` | `reference_text`、`target_text` | `audio/wav` |
| `audio.tts` | — | `target_text`（+`instruct` 可选） | `audio/wav` |
| `video.talking_head` | `source_image` | `target_text` | `video/mp4` |
| `video.talking_head_audio` | `source_image`、`driving_audio` | — | `video/mp4` |
| `video.lipsync` | `source_video`、`driving_audio` | — | `video/mp4` |
| `video.face_swap` | `source_video`、`source_image` | — | `video/mp4` |
| `video.face_swap_lipsync` | `source_video`、`source_image`、`driving_audio` | — | `video/mp4` |
| `detect.image` | `file` | — | 报告 + 叠加图 |
| `detect.video` | `file` | — | 报告 + 示例帧 |
| `detect.audio` | `file` | — | 报告 |
| `defend.image` | `file` | — | 保护图 + 证书 |
| `defend.audio` | `file` | — | 保护音频 + 证书 |

> 检测/防御的 `file` 角色是通用单文件；生成任务不允许叫 `file`，必须用语义角色，避免路由歧义。

响应 `202`：

```json
{
  "job": {
    "id": "job_01J9Z9A1",
    "task": "audio.clone",
    "status": "queued",
    "model_id": "qwen3-tts-1.7b-base",
    "route_reason": "audio.clone 需要 reference_audio + reference_text + target_text；qwen3-tts-1.7b-base 优先级 100 且 ready",
    "progress": 0.0,
    "stage": "queued",
    "created_at": "2026-10-31T15:00:05+08:00",
    "started_at": null,
    "finished_at": null,
    "inputs": {"reference_audio": "ast_01J9Z8Q2"},
    "text": {"target_text": "欢迎使用本地 deepfake 演示平台。"},
    "options": {"language": "Chinese"},
    "outputs": [],
    "report": null,
    "error": null
  }
}
```

### 6.2 查询

`GET /v1/jobs/{id}` → `{job}`。`job` 结构：

| 字段 | 说明 |
|---|---|
| `id` | `job_…` |
| `task` / `status` | 见任务表与状态机 |
| `model_id` | 实际选中的模型（不是 `auto`） |
| `route_reason` | 给用户看的选型理由，中文 |
| `progress` | `0.0–1.0` |
| `stage` | `queued/prepared/running/postprocessing/succeeded/failed/canceled` 或模型自报阶段 |
| `inputs` / `text` / `options` | 回显（敏感文本可只回显长度，见配置） |
| `outputs` | 产物数组，见下 |
| `report` | 检测/防御报告内联（小报告）；大视频报告只给 `outputs` 里的 `report` 产物 |
| `error` | 失败时 `{code,message,hint,retryable,details}` |

产物结构：

```json
{
  "artifact_id": "art_01J9ZB2C",
  "role": "audio",
  "kind": "audio",
  "mime": "audio/wav",
  "size_bytes": 962340,
  "sha256": "3a7d…",
  "url": "/v1/files/art_01J9ZB2C",
  "expires_at": "2026-11-01T15:00:05+08:00"
}
```

`role` 取值：`primary`（主产物）、`overlay`（检测叠加图）、`heatmap`（热力图）、`report`（JSON 报告）、`certificate`（保护证书）、`preview`（视频缩略图）。

`GET /v1/jobs?status=running&task=audio.clone&limit=20&cursor=…` →

```json
{"items": [{"id": "job_…", "task": "audio.clone", "status": "running", "progress": 0.42, "created_at": "…"}], "next_cursor": null}
```

### 6.3 取消

`POST /v1/jobs/{id}/cancel` → `202 {job}`（状态 `canceled` 或 `cancel_requested`）。已成功/失败的任务返回 `409 JOB_NOT_CANCELABLE`。

### 6.4 SSE

`GET /v1/jobs/{id}/events`，`text/event-stream`，支持 `Last-Event-ID` 补发。

```
event: job.updated
id: 17
data: {"job_id":"job_01J9Z9A1","status":"running","progress":0.42,"stage":"synthesis"}

event: job.log
id: 18
data: {"job_id":"job_01J9Z9A1","level":"info","message":"reference audio loaded (5.1s)"}

event: job.succeeded
id: 19
data: {"job_id":"job_01J9Z9A1","status":"succeeded","outputs":[…]}

event: heartbeat
data: {"ts":"2026-10-31T15:00:10+08:00"}
```

- 心跳每 15s；断线后前端用 `Last-Event-ID` 续传，再补拉 `GET /v1/jobs/{id}`。
- 日志最多保留 200 行尾部，避免长任务撑爆内存。

### 6.5 幂等与重试

- 相同 `Idempotency-Key` + 相同 body → 返回原 job（`200`）。
- 相同 key + 不同 body → `409 IDEMPOTENCY_CONFLICT`。
- Key 保留 24h。
- `MODEL_LOADING` / `MODEL_UNAVAILABLE`：网关/BFF 自动退避重试，最多 3 次。
- `GPU_OOM`：自动降级一次（TTS 1.7B→0.6B、视频 1080→720/512），仍失败才返回。
- `REMOTE_DISK_FULL`、`PAYLOAD_TOO_LARGE`、`NO_CAPABILITY`、`CONSENT_REQUIRED`：不自动重试，提示用户处理。
- 其余网络类错误：BFF 指数退避重试，最多 3 次。

## 7. 检测报告

检测结果通过 `job.report` 返回（同时作为 `report` 产物保存一份）。图片示例：

```json
{
  "schema_version": "1.0",
  "job_id": "job_01J9ZD4E",
  "modality": "image",
  "verdict": "fake",
  "score": 0.93,
  "threshold": 0.5,
  "confidence": "high",
  "models": [
    {"model_id": "effnet-b4-ffpp", "score": 0.95, "weight": 0.6, "calibrated": true},
    {"model_id": "clip-univfd", "score": 0.90, "weight": 0.4, "calibrated": true}
  ],
  "regions": [
    {"id": "r1", "bbox": [0.312, 0.181, 0.221, 0.293], "score": 0.91, "label": "face_boundary", "source": "gradcam", "frame_index": null, "time_s": null},
    {"id": "r2", "bbox": [0.341, 0.402, 0.118, 0.097], "score": 0.78, "label": "mouth_region", "source": "gradcam", "frame_index": null, "time_s": null}
  ],
  "frames": [],
  "segments": [],
  "artifacts": {"overlay": "art_01J9ZE1F", "heatmap": "art_01J9ZE1G"},
  "explanations": ["模型主要关注面部轮廓与下颌线附近的融合痕迹"],
  "warnings": ["检测分数不是司法鉴定结论；压缩与二次编辑会影响结果"],
  "processing": {"width": 1024, "height": 1024, "faces": 1, "sampled_frames": null, "duration_s": null},
  "model_version": "detect-ensemble-0.1.0",
  "created_at": "2026-10-31T15:02:00+08:00"
}
```

字段：

| 字段 | 说明 |
|---|---|
| `verdict` | `real` / `fake` / `uncertain`；`uncertain` 用于分数在阈值附近或模型分歧大 |
| `score` | 融合后的 fake 概率 |
| `confidence` | `low` / `medium` / `high`，由校准区间与投票一致性决定 |
| `models[]` | 每个模型的原始分、权重、是否校准 |
| `regions[]` | 图片/视频帧的可疑区域；音频为空；判为 `real` 时可为空 |
| `frames[]` | 视频：`{index, time_s, score, regions[]}` |
| `segments[]` | 音频/视频：`{start_s, end_s, score, verdict}` |
| `warnings[]` | 必须包含“非鉴定结论”；无人脸/多人脸/低分辨率等追加 |

`regions[].label` 枚举：`face_boundary`、`eye_region`、`mouth_region`、`skin_texture`、`frequency_artifact`、`temporal_flicker`、`unknown`。`source`：`gradcam`、`face`、`patch`、`temporal`。

视频报告增加：

```json
{
  "frames": [
    {"index": 0, "time_s": 0.0, "score": 0.88, "regions": [{"id": "f0r1", "bbox": [0.30, 0.18, 0.24, 0.31], "score": 0.86, "label": "face_boundary", "source": "gradcam", "frame_index": 0, "time_s": 0.0}]}
  ],
  "segments": [{"start_s": 0.0, "end_s": 4.0, "score": 0.9, "verdict": "fake"}],
  "processing": {"width": 1920, "height": 1080, "faces": 1, "sampled_frames": 12, "duration_s": 12.3}
}
```

音频报告：`regions=[]`、`frames=[]`，用 `segments` 表示 1s 粒度的可疑区间；`processing` 含 `sample_rate`。

## 8. 防御报告与验证

### 8.1 防御产物

`defend.image` / `defend.audio` 成功后 `job.report`：

```json
{
  "schema_version": "1.0",
  "job_id": "job_01J9ZF7H",
  "modality": "image",
  "method": "pgd-ensemble-eot",
  "strength": "medium",
  "original_artifact_id": "art_01J9ZF7A",
  "protected_artifact_id": "art_01J9ZF7B",
  "metrics": {
    "psnr_db": 41.2,
    "ssim": 0.987,
    "lpips": 0.012,
    "identity_similarity_before": 0.78,
    "identity_similarity_after": 0.41
  },
  "watermark": {"scheme": "dwt-dct-svd", "watermark_id": "wm_01J9ZF7C", "payload_bits": 64, "decode_confidence": 0.99},
  "certificate": {"id": "cert_01J9ZF7D", "sha256": "b81e…", "hmac": "hmac-sha256:…", "issued_at": "2026-10-31T15:05:00+08:00"},
  "warnings": ["不保证抵御压缩、裁剪、重录与自适应攻击"],
  "model_version": "defense-0.1.0",
  "created_at": "2026-10-31T15:05:00+08:00"
}
```

> `job.report.certificate` 是摘要；完整证书产物结构见 [05 主动防御 §6](05-proactive-defense.md#6-保护证书) 与 [`defense-certificate.json`](../contracts/examples/defense-certificate.json)。

### 8.2 验证

`POST /v1/defense/verify`（multipart 或 JSON 资产引用）

```json
{"asset_id": "ast_01J9ZG0K", "certificate_id": "cert_01J9ZF7D"}
```

```json
{
  "valid": true,
  "watermark_id": "wm_01J9ZF7C",
  "certificate_id": "cert_01J9ZF7D",
  "sha256_match": true,
  "hmac_valid": true,
  "issued_at": "2026-10-31T15:05:00+08:00",
  "warnings": []
}
```

失败时 `valid=false` 并给 `reasons[]`：`WATERMARK_NOT_FOUND`、`HASH_MISMATCH`、`CERT_UNKNOWN`、`CERT_TAMPERED`。

## 9. 文件下载

`GET /v1/files/{artifact_id}`：

- `200` + 原始字节；`Content-Type`、`Content-Length`、`Content-Disposition: attachment; filename="…"`、`ETag`。
- 支持 `Range`（视频拖动）与 `HEAD`。
- 产物过期 → `410 ARTIFACT_EXPIRED`。
- `DELETE /v1/files/{artifact_id}` → `204`；任务仍引用时 `409`。

## 10. 错误码

| code | HTTP | 可重试 | 含义 / UI 提示 |
|---|---|---|---|
| `BAD_REQUEST` | 400 | 否 | 请求格式错误；检查字段 |
| `UNAUTHORIZED` | 401 | 否 | Token 缺失/错误；更新配置 |
| `FORBIDDEN` | 403 | 否 | IP/权限不允许 |
| `NOT_FOUND` | 404 | 否 | 资源不存在或已删除 |
| `CONFLICT` | 409 | 否 | 状态冲突（取消已完成任务等） |
| `IDEMPOTENCY_CONFLICT` | 409 | 否 | 同一幂等键不同请求体 |
| `ASSET_IN_USE` | 409 | 否 | 资产被未完成任务引用 |
| `JOB_NOT_CANCELABLE` | 409 | 否 | 任务已结束 |
| `PAYLOAD_TOO_LARGE` | 413 | 否 | 文件超过上限 |
| `UNSUPPORTED_MIME` | 415 | 否 | 不支持的文件类型 |
| `INVALID_MEDIA` | 422 | 否 | 无法解析的媒体文件 |
| `NO_FACE` | 422 | 否 | 未检测到可用人脸；换正面清晰素材 |
| `CONSENT_REQUIRED` | 422 | 否 | 未确认素材授权 |
| `NO_CAPABILITY` | 422 | 否 | 没有模型支持该输入组合；返回缺失角色与建议 |
| `INPUT_TOO_LONG` | 422 | 否 | 音频/视频/文本超长；建议截短 |
| `INPUT_TOO_SHORT` | 422 | 否 | 参考音频不足 3 秒等 |
| `UNSUPPORTED_LANGUAGE` | 422 | 否 | 模型不支持该语言 |
| `UNSUPPORTED_MODEL` | 422 | 否 | 指定模型不存在或不支持该任务 |
| `RATE_LIMITED` | 429 | 是 | 队列已满；稍后重试 |
| `INTERNAL` | 500 | 是 | 网关内部错误；看 request_id |
| `MODEL_LOADING` | 503 | 是 | 模型加载中；Retry-After 后重试 |
| `MODEL_UNAVAILABLE` | 503 | 是 | 模型离线；换模型或重启服务 |
| `GPU_OOM` | 503 | 是 | 显存不足；缩短时长/换小模型后重试 |
| `REMOTE_UNREACHABLE` | 503 | 是 | 远端/隧道不可达（BFF 生成） |
| `REMOTE_LOST` | 503 | 是 | 执行中失去远端连接；任务可重试（BFF 对账） |
| `REMOTE_UNAUTHORIZED` | 502 | 否 | 远端拒绝 Token（BFF 生成） |
| `JOB_TIMEOUT` | 504 | 是 | 任务超时；缩短素材或调高超时 |
| `UPLOAD_INTERRUPTED` | 408 | 是 | 上传中断；重传 |
| `LOCAL_DISK_FULL` | 507 | 否 | 本地磁盘不足；清理资产库 |
| `REMOTE_DISK_FULL` | 507 | 否 | 远端磁盘不足；清理缓存 |
| `ASSET_EXPIRED` | 410 | 否 | 资产已过期；重新上传 |
| `ARTIFACT_EXPIRED` | 410 | 否 | 产物已清理；重新生成 |

## 11. 超时与限制

| 项 | 默认值 | 位置 |
|---|---|---|
| 图片 | 20MB | BFF + 网关 |
| 音频 | 50MB / 10min | BFF + 网关 |
| 视频 | 500MB / 10min | BFF + 网关 |
| 文本 | 2000 字符 | 能力清单 |
| 参考音频 | 3–30s | 能力清单 |
| TTS 任务 | 120s | 能力清单可覆盖 |
| 检测任务 | 60s | 同上 |
| 视频任务 | 30min | 同上 |
| 防御任务 | 10min | 同上 |
| 本地产物保留 | 7 天 | 设置 |
| 远端产物保留 | 24h | 网关 |
| 上传缓存 | 24h | 网关 |

## 12. 本地 BFF 接口映射

前端只调用 `/api/*`，由 BFF 完成 Token、转发、落盘和状态刷新。当前 P2/P3 实现（`app/server/index.mjs`）使用轮询；SSE 中继留作后续。

| 本地接口 | 远端/本地行为 |
|---|---|
| `POST /api/jobs`（multipart） | 克隆：接收 `reference_audio` + `reference_text` + `target_text` + `language` + `consent`；落地后转远端 `/v1/assets`，再提交 `/v1/jobs` |
| `POST /api/detect`（multipart） | 检测：接收 `file` + `model`（`auto`/`spectra-aasist3`/`xlsr-asvspoof`）+ `consent`；提交 `detect.audio` |
| `GET /api/detect/models` | 远端可用的 `detect.audio` 能力清单（含说明、语言、速度） |
| `POST /api/faceswap`（multipart） | 图片换脸：`source_image` + `target_image` + `consent`；提交 `image.face_swap` |
| `POST /api/detect/image`（multipart） | 图片检测：`file` + `consent`；提交 `detect.image`，返回报告 + 叠加图 |
| `POST /api/detect/video`（multipart） | 视频检测：`file` + `consent`；提交 `detect.video`，返回报告 |
| `POST /api/defend`（multipart） | 图片防御：`file` + `strength` + `consent`；提交 `defend.image`，返回保护图 + 证书 |
| `POST /api/defend/video`（multipart） | 视频防御：`file` + `strength` + `consent`；提交 `defend.video`，返回保护 MP4 + 证书 + 前后检测 |
| `GET /api/jobs` / `GET /api/jobs/{id}` | 本地记录 + 远端对账；克隆成功后下载 WAV，检测成功后返回 `report` |
| `POST /api/jobs/{id}/cancel` | 转远端取消 |
| `GET /api/files/{id}` | 回传本地 WAV；`?download=1` 作为附件下载 |
| `POST /api/jobs/{id}/save` | 复制到 `%USERPROFILE%\Downloads\DeepfakeStudio\` |
| `GET /api/health` | 代理远端 `/v1/health`，附带隧道提示 |
| `GET /api/config` | 语言、大小限制、模型名 |
| `GET /api/jobs/{id}/events` | 规划中（当前前端 1.5s 轮询） |
| `POST /api/uploads`、`/api/assets`、`/api/settings`、`/api/defense/verify` | 规划中（资产库/设置/防御阶段） |

> 本地 BFF 会用 ffmpeg 把 m4a/mp3 等统一转成 24kHz 单声道 WAV，再转给远端；远端服务只保证解码 WAV。ffmpeg 缺失时返回 `INVALID_MEDIA`。

## 13. 示例文件

| 文件 | 说明 |
|---|---|
| [`capabilities.json`](../contracts/examples/capabilities.json) | 三条能力：音频克隆、说话视频、图片检测 |
| [`job-request-audio-clone.json`](../contracts/examples/job-request-audio-clone.json) | 你的主场景 |
| [`job-request-video-talking-head.json`](../contracts/examples/job-request-video-talking-head.json) | 图 + 文 → 说话视频 |
| [`job-request-detect-image.json`](../contracts/examples/job-request-detect-image.json) | 图片检测 |
| [`detect-result-image.json`](../contracts/examples/detect-result-image.json) | 概率 + 红框报告 |
| [`defense-certificate.json`](../contracts/examples/defense-certificate.json) | 防御证书 |
| [`error-no-capability.json`](../contracts/examples/error-no-capability.json) | 缺输入角色 |
