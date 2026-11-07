# Deepfake 演示平台（生成 / 主动防御 / 检测）

一个运行在本机浏览器里的 deepfake 实验平台：本地上传图片、音频、视频和文字，任务发往 GPU 服务器推理，结果自动下载回本地。平台只使用本人或已获授权的素材。

> **当前状态：P0 蓝图完成，P1 本地网页 + 音频克隆/检测 + 图片换脸/检测 + 视频检测 + 图片防御已跑通**
> 本地网页在 `http://127.0.0.1:8787`：音频克隆、图片换脸、音频检测、图片检测、视频检测、主动防御、视频防御七个页签。远端 `server/` 跑在共享 A800（GPU 1）。视频生成/视频换脸仍是后续阶段。

---

## 三个能力

| 能力 | 做什么 | 关键输出 |
|---|---|---|
| **生成** | 图片/音频/视频/文字 → 音频克隆、说话视频、换脸、改口型 | 媒体文件 + 生成清单 |
| **主动防御** | 给本人照片/音频加不可感知对抗扰动与水印 | 保护文件 + 保护证书 |
| **检测** | 上传图片/视频/音频，判断是否 deepfake | 概率 + 判定 + 图片红框/视频时间轴/音频片段 |

> 已上线：音频检测、图片换脸、图片换脸检测（整脸框 + top-2 区域 + 热图）、视频检测（RealForensics/AVFF + 片段时间轴 + 关键帧）、图片主动防御、视频防御（逐帧扰动 + 前后对比，实验性）。

首个落地的真实模型是 **Qwen3-TTS voice clone**（`ref_audio` + `ref_text` → 目标文本配音）。音频检测提供 **Spectra-AASIST3**（推荐，多语言）和 **XLS-R ASVspoof 2019**（更快，英文为主）。图片换脸用 **InsightFace inswapper_128**；图片检测用 **EffNet-B4（Celeb-DF + FF++）集成 + Grad-CAM**；主动防御用 **CLIP PGD + DwtDctSvd**。

## 架构一览

```
浏览器 (React + Vite)
   │  同源 /api
本地 BFF (Node + Fastify :8787)            ← 上传转传、任务轮询、结果落盘
   │  HTTP + Bearer Token（SSH 隧道）
远端 FastAPI (:18000, A800 GPU 1)          ← Qwen3-TTS + 换脸 + 音频/图片检测 + 图片防御
```

- 浏览器从不直接访问远端，Token 不进前端。
- 远端只监听 `127.0.0.1`，本机通过 SSH 隧道访问。
- 本地网页：`http://127.0.0.1:8787`；克隆/换脸/保护图保存到 `app/data/results`，检测报告保存在本地历史。
- m4a/mp3 等参考音频由本地 BFF 用 ffmpeg 转成 24kHz 单声道 WAV 后再上传，远端只处理 WAV。
- 所有任务统一为异步 Job：`queued → prepared → running → postprocessing → succeeded / failed / canceled`。

## 现在就能用

```bash
# 1. 本地隧道（保持窗口）
ssh -i "C:\Users\Matrix\Downloads\a800_ai_security" -p 55105 `
  -N -L 18000:127.0.0.1:18000 ai_security@103.79.25.90

# 2. 本地网页
cd app
pnpm install
pnpm build
pnpm start
# 打开 http://127.0.0.1:8787
```

`app/.env` 需要填入远端 token（见 [`app/README.md`](app/README.md)）。页面顶部可切换“音频克隆 / 图片换脸 / 音频检测 / 图片检测 / 主动防御”。

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/00-overview.md`](docs/00-overview.md) | 目标、范围、角色、术语表、已确认决策、非目标 |
| [`docs/01-architecture.md`](docs/01-architecture.md) | 组件、数据流、时序、存储布局、失败模式、安全边界 |
| [`docs/02-api-contracts.md`](docs/02-api-contracts.md) | 资产/任务/能力/检测/防御 schema、状态机、错误码、SSE |
| [`docs/03-generation-and-routing.md`](docs/03-generation-and-routing.md) | 场景矩阵、能力清单、路由算法、Qwen3-TTS、视频模型候选 |
| [`docs/04-detection.md`](docs/04-detection.md) | 检测流水线、图片红框算法与参数、视频/音频、校准与局限 |
| [`docs/05-proactive-defense.md`](docs/05-proactive-defense.md) | 对抗扰动、水印、保护证书、验证、鲁棒性边界 |
| [`docs/06-ui-ux.md`](docs/06-ui-ux.md) | 信息架构、线框、组件、状态、中文文案 |
| [`docs/07-autodl-deployment.md`](docs/07-autodl-deployment.md) | 当前共享 A800 实测、GPU 决策表、SSH 隧道、AutoDL 备选、运维 |
| [`docs/08-roadmap-and-acceptance.md`](docs/08-roadmap-and-acceptance.md) | 阶段计划、验收测试、风险、待定项决策标准 |
| [`docs/09-model-audit.md`](docs/09-model-audit.md) | 当前模型年代/性能/许可、旧防御失败原因、升级目标 |
| [`contracts/examples/`](contracts/examples/) | 7 个可解析的 JSON 契约示例 |
| [`app/README.md`](app/README.md) | 本地网页 + BFF：访问方式、配置、页面功能、测试 |
| [`server/README.md`](server/README.md) | 远端服务：TTS、换脸、音频/图片检测、防御、模型与实测 |

## 已确认的决策

| 项 | 结论 |
|---|---|
| 运行形态 | 本地 Web（8787）+ 本地 BFF，推理在共享 A800 |
| 主动防御 | 对抗扰动 + 水印，只保护本人/授权素材 |
| 远端接入 | 默认 SSH 隧道；AutoDL 6006/6008 仅作备选 |
| 首个模型 | Qwen3-TTS 12Hz 1.7B Base（Apache-2.0），已部署到共享 A800 GPU 1 |
| 音频检测模型 | Spectra-AASIST3（推荐，Apache-2.0）+ XLS-R ASVspoof 2019（备选），UI 可选 |
| 图片换脸 | HyperSwap 256（2025，默认）+ inswapper_128（2023，legacy）；视频后置 |
| 视频检测 | RealForensics CSN-r101（CVPR 2022，MIT）；AVFF 音画分支验证中 |
| 图片检测 | EffNet-B4（Celeb-DF + FF++）集成 + Grad-CAM；整脸框 + top-2 区域 + 热图 |
| 图片防御 | CLIP PGD + DwtDctSvd 水印 + HMAC 证书；仅图片，视频/音频后置 |
| 本地技术栈 | Vite + React + TypeScript + 原生 CSS；Node + Fastify + JSON 存储（后续换 SQLite） |
| 远端技术栈 | Python 3.10 venv + FastAPI（P2 单进程；P3 起拆分服务） |

## 待定项（文档内已给决策标准）

- 当前 A800 80GB 已可用（GPU 1）；后续视频阶段再评估 48GB / 80GB 档
- 视频换脸、唇形、说话头具体模型与许可证
- 视频检测、音频防御、视频防御
- Forensics v2 音频检测模型（gated / CC-BY-NC-4.0，待 HF 授权）
- AutoDL 企业认证（决定是否可走 6006 公网）
- 内容策略细节（同意记录、TTL、可见水印开关）

## 安全与伦理

- 默认仅绑定 `127.0.0.1`，不向局域网/公网暴露本地平台。
- 上传前必须勾选“我拥有该人物肖像/声音的使用权”，并记录同意时间与用途。
- 生成物默认带 SHA-256 清单与模型来源；音频在 P5 接入 AudioSeal 水印，视频先写容器元数据，逐帧水印在 P6 完善。检测结论明确标注“非司法鉴定”。
- 主动防御仅处理本人素材；不提供针对他人的投毒流程。
- 远端 GPU 服务器属第三方算力，只上传演示所需的最小数据；本地产物默认 7 天、远端 24h 清理。

## 快速阅读路径

1. 先看 [总览](docs/00-overview.md) 和 [架构](docs/01-architecture.md)。
2. 关心“上传后发生什么、接口长什么样”，看 [契约](docs/02-api-contracts.md) 与 [`contracts/examples/`](contracts/examples/)。
3. 关心“模型怎么选、怎么路由”，看 [生成与路由](docs/03-generation-and-routing.md)。
4. 关心“红框怎么画、防御怎么做”，看 [检测](docs/04-detection.md) 与 [主动防御](docs/05-proactive-defense.md)。
5. 准备部署/换卡，直接看 [GPU 服务器部署](docs/07-autodl-deployment.md)。
