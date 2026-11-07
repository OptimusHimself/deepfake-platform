# 03 · 生成、模型与自动路由

## 1. 任务分类

| 类别 | task | 形态 | 首个落地方案 |
|---|---|---|---|
| 音频 | `audio.clone` | 参考音频 + 参考文本 + 目标文本 → 克隆配音 | **Qwen3-TTS 1.7B Base** |
| 音频 | `audio.tts` | 文本 → 指定音色/风格配音 | Qwen3-TTS CustomVoice |
| 视频 | `video.talking_head` | 图片 + 文本 → 说话视频 | TTS + 唇形/说话头串联 |
| 视频 | `video.talking_head_audio` | 图片 + 音频 → 说话视频 | 说话头模型 |
| 视频 | `video.lipsync` | 视频 + 音频 → 改口型 | MuseTalk / LatentSync |
| 视频 | `video.face_swap` | 视频 + 人脸图 → 换脸 | InsightFace inswapper / SimSwap |
| 视频 | `video.face_swap_lipsync` | 视频 + 人脸图 + 音频 → 换脸并改口型 | 换脸 + 唇形串联 |
| 检测 | `detect.image/video/audio` | 文件 → 报告 | 见 [04](04-detection.md) |
| 防御 | `defend.image/audio` | 文件 + 强度 → 保护文件 + 证书 | 见 [05](05-proactive-defense.md) |

场景与输入角色（与 [02 §6.1](02-api-contracts.md#61-提交) 一致）：

| 场景 | 文件角色 | 文本 | 输出 |
|---|---|---|---|
| 克隆我的声音 | `reference_audio` | `reference_text` + `target_text` | WAV |
| 文字转我的声音 | — | `target_text` + `speaker`/`instruct` | WAV |
| 我的照片说话（文字驱动） | `source_image` | `target_text` | MP4 |
| 我的照片说话（音频驱动） | `source_image` + `driving_audio` | — | MP4 |
| 给视频改口型 | `source_video` + `driving_audio` | — | MP4 |
| 给视频换脸 | `source_video` + `source_image` | — | MP4 |
| 换脸并配音 | `source_video` + `source_image` + `driving_audio` | — | MP4 |

> `audio.clone` 的 `reference_text` 是参考音频的逐字稿，不是要生成的内容；`target_text` 才是要说的新内容。两者混淆是演示中最常见的失败原因，UI 需要明确示例。

## 2. Qwen3-TTS 适配（首个真实模型）

> 官方仓库：[QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)。模型名、参数与许可证以该仓库为准。

### 2.1 模型选择

| 模型 | 用途 | 显存估计 | 说明 |
|---|---|---|---|
| `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | 主用：voice clone | 6–10GB | 3 秒参考音频即可克隆；Apache-2.0 |
| `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | 快速/低显存档 | 3–6GB | 质量略低，OOM 时降级 |
| `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | 文本转语音 | 6–10GB | 9 个预设音色，支持 instruct |
| `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` | 描述生成音色 | 6–10GB | 用于“先设计参考音色再克隆” |
| `Qwen3-TTS-Tokenizer-12Hz` | 编解码 | 随模型 | vLLM/包内自动加载 |

显存为工程估算，P2 上卡后用 `nvidia-smi` 实测并回填本表。平台内部 `model_id` 用 `qwen3-tts-1.7b-base` / `qwen3-tts-0.6b-base`，权重 ID 用 `Qwen/Qwen3-TTS-12Hz-1.7B-Base` / `…-0.6B-Base`。

### 2.2 调用方式

官方 Python 包：

```python
from qwen_tts import Qwen3TTSModel

model = Qwen3TTSModel.from_pretrained(
    "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
    device_map="cuda:0",
    dtype=torch.bfloat16,
    attn_implementation="flash_attention_2",
)
wavs, sr = model.generate_voice_clone(
    text=target_text,
    language="Chinese",
    ref_audio=ref_audio_path,
    ref_text=reference_text,
)
```

- `ref_audio` 支持本地路径、URL、base64、`(numpy, sr)`；演示统一传本地路径。
- 参考音频建议 3–30 秒、单人、低底噪、采样率 ≥16kHz；超过 30 秒裁剪到最清晰片段。
- `create_voice_clone_prompt(...)` 可缓存参考音频的 clone prompt，同一人物多次生成时复用，降低首包延迟。
- 支持批量和流式；演示先做非流式整段返回，P6 可加流式播放。
- 语言：官方支持中文、英文、日文、韩文、德文、法文、俄文、葡萄牙文、西班牙文、意大利文；不支持的语种直接 `UNSUPPORTED_LANGUAGE`。
- 许可证：Apache-2.0（已核实仓库 LICENSE）。

### 2.3 参考文本缺失时的兜底

`audio.clone` 的正常路径要求 `reference_text`。缺失时按顺序：

1. **ASR 自动转写**（远端已有 Whisper/faster-whisper 时）：转写 → 回填 → 正常克隆；结果里标记 `reference_text_source: "asr"`。
2. **x-vector-only 模式**（`x_vector_only_mode=True`）：不需要逐字稿，音色相似度略降；结果里标记 `reference_text_source: "x_vector"`。
3. 两者都不可用 → `422 NO_CAPABILITY`，`missing_roles: ["reference_text"]`，提示“补充参考文本或改用 x-vector 模式”。

### 2.4 文本切分与长文本

- 单次 ≤2000 字符；超过则按句号/问号/换行切分，逐段合成，段间插 120–200ms 静音，最后拼接为单 WAV。
- 数字、英文缩写、公式等按官方建议保留原文，不做过度规范化。
- 目标文本为空 → `INPUT_TOO_SHORT`；参考音频 <3 秒 → `INPUT_TOO_SHORT`。

### 2.5 服务内部接口（Qwen3-TTS）

`POST /internal/execute`

```json
{
  "job_id": "job_…",
  "task": "audio.clone",
  "model_id": "qwen3-tts-1.7b-base",
  "inputs": {"reference_audio_path": "/root/autodl-tmp/deepfake/cache/uploads/9f2c….wav"},
  "text": {"reference_text": "…", "target_text": "…"},
  "options": {"language": "Chinese", "seed": 42},
  "output_dir": "/root/autodl-tmp/deepfake/artifacts/job_…"
}
```

返回产物路径 + 采样率 + 时长 + 模型版本；进度用回调/轮询写回网关。内部接口不对外暴露，不需要与公开契约完全一致。

## 3. 视频模型候选

> 视频模型迭代快，下列为演示候选；**许可证与权重可用性必须在 P4 前逐个核实**，非商用/研究限制的模型只在本地演示用，不对外提供服务。

### 3.1 换脸

| 候选 | 特点 | 风险/限制 |
|---|---|---|
| InsightFace `inswapper_128`（ReActor/FaceFusion 封装） | 成熟、快、单图换脸 | 权重通常仅限非商业研究；侧脸/遮挡差 |
| SimSwap | 身份保持较好 | 研究用途；速度较慢 |
| 自训练/商用授权模型 | 可商用 | 成本高，P4 再评估 |

流程：源视频抽帧 → 检测/对齐目标脸 → 换脸 → 融合回帧 → 时序平滑（可选）→ ffmpeg 合音轨。单人正脸演示效果最好；多人脸默认选最大脸，UI 可后续加“选择目标脸”。

> **2026-10-31 已落地图片版**：`image.face_swap` 使用 InsightFace `buffalo_l` + `inswapper_128.onnx`，源脸图 + 目标图，预热后约 **0.145s/张**；视频版仍后置。

### 3.2 唇形/说话头

| 候选 | 特点 | 风险/限制 |
|---|---|---|
| MuseTalk | 实时性较好，适合 512/720p | 依赖底模许可证；口型精度中等 |
| LatentSync | 画质/口型较好 | 显存较高；推理较慢 |
| Wav2Lip | 稳定基线 | 画质低、仅研究用途 |
| EchoMimic / Hallo3 / Sonic | 说话头质量高、支持头部动作 | 显存高、速度慢，适合“高质量档” |

建议：P4 先接 **MuseTalk（standard）** 跑通，再评估 LatentSync（high）；Wav2Lip 只作为兜底。`video.talking_head` 采用“TTS → 唇形”串联，作为虚拟编排模型（`pipeline` 字段）。

### 3.3 视频后处理

- 统一输出：H.264 / `yuv420p` / 25fps / AAC 192kbps / `+faststart`，兼容浏览器。
- 分辨率档：`fast=512`、`standard=720`、`high=1080`；源视频低于目标时不上采样。
- 时长上限默认 60s（P4 演示），超过 → `INPUT_TOO_LONG`。
- 产物写 `manifest.json`：输入哈希、模型/版本、参数、seed、输出哈希、耗时、水印 ID（若有）。
- 生成物来源标记：音频加 AudioSeal；视频先写容器 `comment` 元数据 + 清单，逐帧不可见水印放 P6。

## 4. 能力清单与适配器

### 4.1 能力声明

每条能力 = 一个 `(model_id, task)`，字段见 [02 §4](02-api-contracts.md#4-能力清单)。新增模型只需：

1. 实现适配器；
2. 向网关注册能力；
3. 在 UI 的“模型”下拉里自动出现（默认仍 `auto`）。

`pipeline` 用于串联任务：`model_id` 是虚拟编排模型，`pipeline` 列出内部步骤；网关把它当普通模型路由，具体编排在该服务的适配器内完成。

### 4.2 适配器接口（Python）

```python
class Adapter:
    def manifest(self) -> list[Capability]: ...
    def load(self) -> None: ...
    def unload(self) -> None: ...
    def execute(self, req: ExecuteRequest) -> ExecuteResult: ...
    def cancel(self, job_id: str) -> None: ...
    def health(self) -> Health: ...
```

- `execute` 必须是幂等的：同一 `job_id` 重试不产生重复产物（按 job 目录覆盖）。
- 长任务每 2s 上报一次进度；在安全点检查取消标志。
- 所有异常映射到 [02 §10](02-api-contracts.md#10-错误码) 的错误码，禁止把裸栈返回给前端。

### 4.3 模型管理器

- 显存预算 = 总显存 − 2GB 保留；按 `gpu_group` 串行。
- 状态：`unloaded → loading → ready → unloading`；加载失败重试 1 次，仍失败标记 `offline`。
- LRU 卸载：优先卸载最久未用且非当前任务的模型；卸载前等待任务完成。
- OOM 处理：捕获 → 卸载非必要模型 → 降级（TTS 1.7B→0.6B；视频 1080→720/512）→ 重试一次 → 仍失败返回 `GPU_OOM`。
- 预热：服务启动后加载 TTS 与检测器；视频模型按需加载。

## 5. 路由算法

### 5.1 输入

- `task`
- `inputs`（角色 → 资产元数据）
- `text`
- `options`（language/quality/strength）
- 能力清单快照
- 实时状态：模型 `status`、队列长度、运行中任务数、GPU 空闲显存

### 5.2 决策流程

```text
candidates = capabilities where task == request.task
if request.model != auto:
    candidates = candidates where model_id == request.model
if candidates empty: 422 UNSUPPORTED_MODEL

valid = []
for c in candidates:
    if c.status == disabled: skip
    if not required_inputs ⊆ inputs: skip(reason=missing_role)
    if not required_text ⊆ non_empty(text): skip(reason=missing_text)
    if any input kind mismatch role: skip(reason=kind_mismatch)
    if duration/size/chars/language out of limits: skip(reason=limit)
    if c.status == offline: skip(reason=offline)
    valid.append(c)

if valid empty:
    return 422 NO_CAPABILITY with per-candidate rejection reasons,
           missing roles, and alternative tasks

for c in valid sorted by score desc:
    if c.status == loading: wait/retry (MODEL_LOADING)
    if running_count(c) >= max_concurrency: continue
    if free_vram < c.resources.vram_gb and cannot unload: continue
    reserve(c); return c

if all busy: queue with best candidate; return queued (not an error)
```

打分：

```text
score = priority
      + quality_bonus(quality_tier, options.quality)
      + warm_bonus(model loaded)
      - queue_penalty(queue_len * 5)
      - load_penalty(vram_gb / 8)
```

- `quality=fast` 时 `quality_tier=fast` 加分；`high` 时 `high` 加分。
- 同一输入、同一状态，路由结果确定（按 `priority desc, model_id asc` 打破平局）。
- `route_reason` 用中文写“选中原因 + 被淘汰主要原因”，例如：
  `选择 qwen3-tts-1.7b-base：输入齐全、ready、优先级 100；0.6B 因 quality=high 排序靠后。`

### 5.3 音频路由规则

| 输入 | 路由 |
|---|---|
| `reference_audio` + `reference_text` + `target_text` | `audio.clone` → 1.7B Base |
| `reference_audio` + `target_text`，无 `reference_text` | ASR 补全 → 1.7B；ASR 不可用则 x-vector 模式；再不行 422 |
| 只有 `target_text` + `speaker` | `audio.tts` → CustomVoice |
| 只有 `target_text` + `instruct` | `audio.tts` → VoiceDesign |
| 只有 `target_text` | `audio.tts` → CustomVoice 默认音色（配置项），并提示 |
| 参考音频 <3s 或 >30s | 裁剪/拒绝（`INPUT_TOO_SHORT`/`INPUT_TOO_LONG`） |
| 语言不在列表 | `UNSUPPORTED_LANGUAGE` |

### 5.4 视频路由规则

| 输入 | 路由 |
|---|---|
| `source_image` + `target_text` | `video.talking_head` → TTS + 唇形串联 |
| `source_image` + `driving_audio` | `video.talking_head_audio` → 说话头/唇形 |
| `source_video` + `driving_audio` | `video.lipsync` |
| `source_video` + `source_image` | `video.face_swap` |
| `source_video` + `source_image` + `driving_audio` | `video.face_swap_lipsync`（换脸 → 唇形） |
| 图片无脸/多脸 | 无脸 `NO_FACE`；多脸默认最大脸并警告 |
| 视频无脸 | `NO_FACE`，提示换正面素材 |
| 时长 >60s | `INPUT_TOO_LONG`（P4 限制） |
| 显存不足 | 降档 512/720 或排队；仍不行 `GPU_OOM` |

### 5.5 路由示例

**示例 A：标准音频克隆**

```json
{
  "task": "audio.clone",
  "inputs": {"reference_audio": "ast_…"},
  "text": {"reference_text": "…", "target_text": "…"},
  "options": {"language": "Chinese", "quality": "high"}
}
```

→ 选中 `qwen3-tts-1.7b-base`，`route_reason`：“输入齐全、模型 ready、优先级 100；quality=high 优先 1.7B”。

**示例 B：缺参考文本**

→ 若 ASR 开启：自动转写 + 克隆，报告标记 `reference_text_source=asr`；否则尝试 x-vector；否则 `NO_CAPABILITY`，返回 `missing_roles:["reference_text"]` 和 `alternative_tasks:["audio.tts"]`。

**示例 C：图片 + 文本**

→ 选中虚拟模型 `talking-head-text-v1`，内部 TTS 生成临时 WAV → 唇形 → 合音轨 → MP4；进度分三段上报（TTS 0–35%、唇形 35–90%、封装 90–100%）。

**示例 D：检测图片**

→ 选中 `detect-ensemble-v1`；GPU 忙时允许排到检测队列；若显存不足，EffNet 可降级到 CPU（慢但可用），并在报告 `warnings` 标注“CPU 降级”。

## 6. 新增模型检查表

- [ ] 许可证允许当前用途（演示/商用）；权重可下载、可离线放置
- [ ] 独立环境或兼容现有环境；CUDA/torch 版本匹配
- [ ] 显存、典型耗时、最大并发实测
- [ ] 输入限制（时长、分辨率、语言、文本长度）写入能力清单
- [ ] 适配器实现 `manifest/load/unload/execute/cancel/health`
- [ ] 错误映射到统一错误码；OOM/取消/超时都有处理
- [ ] 产物格式统一（WAV 16-bit / MP4 H.264+AAC）
- [ ] 冒烟测试：3 个正例 + 3 个边界例
- [ ] 更新 [02 任务表](02-api-contracts.md#61-提交)、[03 场景表](#1-任务分类)、UI 模式卡、路线图

## 7. 生成物来源与清单

每次成功生成写 `manifests/<job_id>.json`：

```json
{
  "job_id": "job_…",
  "task": "audio.clone",
  "model_id": "qwen3-tts-1.7b-base",
  "model_version": "1.7B",
  "inputs": [{"asset_id": "ast_…", "sha256": "…", "role": "reference_audio"}],
  "text": {"target_text_sha256": "…", "language": "Chinese"},
  "options": {"seed": 42},
  "outputs": [{"artifact_id": "art_…", "sha256": "…", "mime": "audio/wav"}],
  "consent_id": "consent_…",
  "watermark_id": "wm_…",
  "generated_at": "…",
  "route_reason": "…"
}
```

- 音频生成物默认嵌 AudioSeal 水印（若已接入）；视频先写容器元数据与清单。
- 清单是本地资产库的一部分，删除产物时一并删除；导出文件时可选附带 `.manifest.json`。
- 清单不是法律证据，只用于复现与审计。
