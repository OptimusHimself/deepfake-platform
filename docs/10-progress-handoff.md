# 10 · 项目进度概况（交接给 Codex）

> **快照时间**：2026-11-07 17:00（Asia/Shanghai）。
>
> **生成方式**：直接读当前工作区代码、本地任务记录 `app/data/store.json`（25 条 job）、`demo_data/` 与 `实验用视频/`，以及 README / docs 里的实测表。**没有**重跑构建、没有连远端 GPU 做端到端验证（快照时另一个会话仍在写文件，`app/dist` 16:54 刚重建）。
>
> **读法**：先看 §0 和 §4；要动手看 §6；查路径看 §7；查“文档说的和代码做的不一致”看附录 A。
>
> **重要前提**：本仓库**没有 git**，无法 diff、无法回滚、查不到改动历史。本文档描述的是某一时刻的状态，动手前请用 `ls`、`Get-Item` 和直接读文件确认现状。

---

## 0. 三句话现状

1. 这是一个**本机网页 + 远端共享 GPU** 的 deepfake 生成 / 检测 / 主动防御演示平台。P0 文档、P1 网页骨架、P2 音频克隆、P3 图片/音频/视频检测、图片与视频防御都已跑通；**视频换脸在 2026-11-07 当天刚补齐，代码已接线、`dist` 已重建，但还没有端到端验收记录**。
2. 功能覆盖面已经不窄，**真正的短板是“结论不可复现”**：检测阈值是两张图手调的 58%，防御效果两次实验结论相反，评估样本个位数，数据集下载还会静默写出 15 字节的假 `.jpg`。
3. 目前最该做的不是加功能，而是：**把视频换脸验证完 → 修数据获取 → 建可复现的检测/防御评估 → 补工程基线（git、依赖、契约测试）**。

---

## 1. 项目是什么

### 1.1 目标

本地浏览器里操作，素材只在本机；推理全部在远端 GPU 服务器；结果自动回传本地。三类能力：

| 能力 | 做什么 | 代表任务 |
|---|---|---|
| **生成** | 音频克隆、图片换脸、视频换脸、（规划中）说话视频/改口型 | `audio.clone`、`image.face_swap`、`video.face_swap` |
| **检测** | 判断图片/音频/视频是否 deepfake，给概率、判定、时间轴、红框/热图 | `detect.image`、`detect.audio`、`detect.video` |
| **主动防御** | 给本人素材加不可感知扰动 + 水印 + 证书 | `defend.image`、`defend.video`（实验性） |

### 1.2 架构

```text
浏览器 (React + Vite, :8787)
   │  同源 /api
本地 BFF (Node + Fastify, :8787)          ← 校验、上传转传、任务轮询、结果落盘（app/data）
   │  HTTP + Bearer Token（SSH 隧道 18000）
远端 FastAPI (:18000, 共享 A800 的 GPU 1)  ← 队列 + 8 种 task + SQLite + 文件
```

- 浏览器从不直连远端，Token 不进前端。
- 远端只监听 `127.0.0.1:18000`，本地通过 SSH 隧道访问。
- 所有任务统一为异步 Job：`queued → prepared → running → postprocessing → succeeded / failed / canceled`；各面板以 1.2–2s 轮询远端，不用 SSE。

### 1.3 当前部署事实（2026-10-31 实测，之后未变）

| 项 | 值 |
|---|---|
| 远端主机 | `ai_security@103.79.25.90 -p 55105`，主机名 `g0105`，8 × A800-SXM4-80GB |
| 用卡 | **固定 GPU 1**；GPU 0 被其他任务占用，禁止使用 |
| 项目目录 | `/ssd/ai_security/deepfake-platform`（代码 `code/`，环境 `envs/tts`，模型 `models/`，数据 `data/`） |
| 远端服务 | `tmux` 会话 `deepfake-tts`，`run.sh` 启动，日志 `logs/gateway.log` |
| 磁盘 | 根分区仅 ~25GB 可用，所有模型/缓存必须放 `/ssd` |
| 本地 | `app/`（Vite + React 19 + TS），`pnpm build && pnpm start`，`app/.env` 填 `GATEWAY_TOKEN` |
| 数据库 | 远端 SQLite `data/gateway.db`；本地 `app/data/store.json`（全量 JSON，非 SQLite） |

### 1.4 代码地图

| 文件 | 职责 |
|---|---|
| `app/server/index.mjs` | BFF：8 个上传入口、远端转发、结果落盘、`/api/*`（约 1200 行） |
| `app/src/App.tsx` | 单文件壳：8 个页签切换 + 健康状态 + 历史（约 39KB） |
| `app/src/*Panel.tsx` | 8 个功能面板，各自实现“上传 → 提交 → 轮询 → 展示 → 历史” |
| `server/app.py` | 远端 FastAPI 网关 + 队列 + SQLite + 所有 task 的编排（约 1665 行） |
| `server/faceswap.py` | 图片换脸（HyperSwap / inswapper），视频换脸复用它的底层 |
| `server/videofaceswap.py` | **2026-11-07 新增**：逐帧视频换脸 + 保留音轨重建 MP4 |
| `server/videodetect.py` | RealForensics CSN-r101 视频检测 |
| `server/videodetect_avff.py` | AVFF 音画联合检测（非官方实现） |
| `server/imagedetect.py` | EffNet-B4 集成 + Grad-CAM + 红框/热图 |
| `server/detector.py` | 音频检测（Spectra-AASIST3 / XLS-R） |
| `server/defense.py` / `defend_video.py` | 图片 / 视频防御（CLIP PGD + DwtDctSvd） |
| `server/eval_detectors.py` | 音频检测器对比脚本（4 个样本，远端手工跑） |
| `demo_data/` | RTFS-10k 的 CSV/元数据 + 少量样本 + SDFVD 压缩包（正在下载） |
| `实验用视频/` | 本地实验产物副本（换脸 MP4 + contact sheet） |

---

## 2. 已完成的工作

### 2.1 阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | README + 9 份中文文档 + 7 个 JSON 契约示例 | ✅ 完成（但已漂移，见附录 A） |
| P1 | 本地网页 + BFF + 真实远端闭环 | ⚠️ 主体完成；mock 模式、SQLite 资产库、资产库页、设置页**未做** |
| P2 | Qwen3-TTS 音频克隆 | ✅ 跑通；相似度、长文本切分、ASR 兜底、真取消**未做** |
| P3 | 音频/图片检测 + 红框 | ✅ 跑通；**无正式评估集与 AUC/EER** |
| P4 | 视频生成（换脸/唇形） | ⚠️ 图片换脸完成；**视频换脸今天刚接完线**；唇形/说话头未做 |
| P5 | 主动防御 | ⚠️ 图片/视频基线完成；**对换脸模型实际保护有限**；音频防御未做 |
| P6 | 加固、评估、演示准备 | ❌ 基本未开始 |

### 2.2 八条任务链路

| task | 模型 | 入口 | 状态 |
|---|---|---|---|
| `audio.clone` | Qwen3-TTS 12Hz 1.7B Base（Apache-2.0） | BFF `/api/jobs` → `app.py` 队列 | ✅ |
| `detect.audio` | Spectra-AASIST3（默认）/ XLS-R ASVspoof | `/api/detect` | ✅ |
| `image.face_swap` | HyperSwap 1a 256（默认）/ inswapper_128（legacy） | `/api/faceswap` | ✅ |
| `detect.image` | EffNet-B4（Celeb-DF + FF++）集成 + Grad-CAM | `/api/detect/image` | ✅ |
| `detect.video` | RealForensics CSN-r101（默认）/ AVFF stage3 | `/api/detect/video` | ✅ |
| `defend.image` | CLIP ViT-B/32 PGD + DwtDctSvd + HMAC 证书 | `/api/defend` | ✅（效果有限） |
| `defend.video` | 逐帧 CLIP PGD + 水印 + H.264 重建，≤250 帧 | `/api/defend/video` | ⚠️ 实验性 |
| `video.face_swap` | 复用 HyperSwap/inswapper 逐帧，≤300 帧 | `/api/video-faceswap` → `process_video_faceswap_job` | ⚠️ **今天新增，待验收** |

网页现有 **8 个页签**：音频克隆、图片换脸、视频换脸、音频检测、图片检测、视频检测、图片防御、视频防御。

### 2.3 已记录的实测数字（保留原始样本背景）

| 日期 | 项目 | 样本 | 结果 |
|---|---|---|---|
| 10-31 | 音频克隆 | 8.08s 参考音频 | 模型加载 2.4s，端到端 ~12s，产物 4.24s WAV，峰值显存 4.29GB |
| 10-31 | 音频检测 Spectra | 1 条真人 + 2 条克隆 | 真人 0% fake；中文克隆 99.98%；英文克隆 97% |
| 10-31 | 音频检测 XLS-R | 同上 | 真人 28.8%；中文克隆 82.3%；英文克隆 10.2% |
| 10-31 | 图片换脸 | 单图，预热后 | HyperSwap 0.122s/张；inswapper 0.145s/张；首张约 10s |
| 10-31 | 图片检测 | 1 张两脸合照 | 真人最高 56%，换脸图最高 61%，**阈值 58%** |
| 10-31 | 图片防御 | 550×550 medium | PSNR 40.87dB、SSIM 0.9802、水印解码成功 |
| 11-01 | 视频检测 | 1 条真实说话视频 | RealForensics 11.26% fake（修复预处理后）；AVFF 0.0% |
| 11-01 | 视频防御 | 2s 片段 | PSNR 41.7dB、SSIM 0.9857；RealForensics 6% → 95% fake |
| 11-03 | 视频防御 | 250/469 帧，24.22fps | PSNR 42.38dB、SSIM 0.9836、水印 100%；耗时 **355s**；RealForensics 11.26% → 0.4% |
| 11-07 | 视频换脸 | 下载 6 条数据集自带 inswapper 视频 | 仅人工比对 + contact sheet；**本平台 pipeline 尚未实跑，耗时/显存无记录** |

> 两次不同视频上的“前后检测分数”方向相反（6%→95% vs 11.26%→0.4%）。这正说明**当前不能用检测器分数当防御效果指标**。

### 2.4 今天（11-07）新增的视频换脸

- 远端：`server/videofaceswap.py`（逐帧检测最大脸 → HyperSwap/inswapper → 写 JPEG → ffmpeg 重建 H.264 + 原音轨），`app.py` 新增 `process_video_faceswap_job`、路由与 capabilities（`max_frames=300`）。
- BFF：`POST /api/video-faceswap`（字段 `source_image` + `video` + `model` + `consent`），结果按 `video.face_swap` 落盘为 MP4。
- 前端：新增 `VideoFaceSwapPanel.tsx`，`App.tsx` 已加第 3 个页签，`dist` 已在 16:54 重建。
- 实验素材：从 `kontur-ai/rtfs-10k`（CC-BY-SA-4.0）下载了 CSV/元数据、2 条目标视频和 6 条**数据集自带**的 inswapper 生成视频，并生成 contact sheet 做人工比对。注意：这 6 条不是本平台产物；`videofaceswap.py` 16:51 才写好，尚未对真实视频实跑。

---

## 3. 做得不好的地方

### 3.1 按严重度

| 级别 | 问题 | 证据 | 影响 |
|---|---|---|---|
| **S1** | **没有版本控制** | 根目录无 `.git`；`git status` 报 not a repository | 无法 diff/回滚/审阅；多人（多 agent）同时改必然互相覆盖 |
| **S1** | **评估结论不可复现** | 阈值 58% 来自两张图；音频 3 条样本（对比脚本里 4 条）；视频 1 条；两次防御实验结论相反 | 无法回答“到底准不准、有没有用” |
| **S2** | 文档与实现漂移 | README 仍写“7 个页签、视频换脸后续”；`app/README` 说“视频换脸还没做”；`docs/08` 说视频换脸待推进 | 接手者按文档做会做错 |
| **S2** | 数据下载脚本静默产出坏文件 | `demo_data/rtfs/2-192.jpg` 等 3 个文件内容就是 `Entry not found`（15 字节）；`generations_info.csv` 同样是这行字 | 实验看起来“跑了”，其实源脸是坏图 |
| **S2** | 依赖清单缺项 | `videofaceswap.py` / `videodetect.py` import `decord`、`imageio_ffmpeg`，`server/requirements.txt` 都没有 | 换机/重装后视频链路直接 ImportError |
| **S3** | 任务生命周期不闭环 | `store.json` 里 `job_8a8d280a0d4e8af6`（defend.video）自 11-01 一直 `running`，带 `REMOTE_TIMEOUT` 警告；BFF 无对账 | 界面永远转圈，用户不知道失败还是排队 |
| **S3** | 取消不是真取消 | `cancel` 只改状态；`videofaceswap.swap_video` 的 300 帧循环内没有取消检查 | 取消后 GPU 仍跑几分钟，违背 P2 验收“5s 内停止” |
| **S3** | 视频时间轴按 25fps 硬编码 | `videodetect.py` 用 `start_frame / 25.0` 和固定 `end_s = start+1.0`，未读真实 fps | 24.22fps 的素材时间戳会漂移；1s 片段名不副实 |
| **S3** | 本地存储在内存里全量读写 | `index.mjs` 的 `store.json` 每次 `saveStore()` 全量写；无上限、无 TTL、无删除接口 | job 越攒越多；文件损坏时 `readStore` 静默返回空，历史全丢 |
| **S4** | 前端重复代码 | 8 个 Panel 各自复制上传/校验/轮询/历史/错误卡；`App.tsx` 39KB 单文件 | 改一处交互要改 8 遍；新页签成本高 |
| **S4** | 测试是“手工脚本” | 8 个 `app/scripts/ui-*.mjs`：硬编码 Chrome 路径、绝对路径、依赖真实远端与隧道、截图写进 `app/data` | 无法在 CI 或别人机器上跑；没有视频换脸脚本 |
| **S4** | 同意记录只有布尔值 | BFF 校验 `consent=true` 后固定转发 `{subject:'self', agreed:true}`；不落盘“时间/用途” | 与文档承诺的“记录同意时间与用途”不符 |
| **S4** | 安全/许可未落地 | Token 明文在 `app/.env`；HyperSwap ResearchRAIL、inswapper 非商业、AVFF 无 LICENSE、Forensics v2 CC-BY-NC + 403 | 只能本地演示；公开/商用前必须逐个确认 |

### 3.2 最值得单独说的两件

**（1）评估方法。** 现在的“准/不准”都建立在个位数样本上：音频 1 真 2 假、图片 1 张合照、视频 1 条。图片阈值 58% 卡在真人 56% 与换脸 61% 之间，只有 3 个百分点的余量——换一张图就会翻。文档里也承认 `Deepfake-Eval-2024` 上很多高 AUC 模型到 in-the-wild 接近抛硬币。**没有固定 hold-out 集、没有按生成器划分、没有 AUC/EER/FPR 之前，任何“检测率”都不该写进结论。**

**（2）防御。** 旧方案优化的是 CLIP 全局语义，而 inswapper/HyperSwap 取的是 ArcFace 身份 embedding，两者不在一个空间。此前“相似度 0.898→0”的结论已被撤回。现在唯一能拿出的数字是对 RealForensics 分数的影响，而它两次方向相反。**在“保护 → HyperSwap/inswapper 攻击 → ArcFace 相似度”闭环跑通前，不应声称防御有效。**

---

## 4. 当前正在解决的问题（截至快照）

### 4.1 视频换脸闭环收尾 —— 进行中

已完成：远端模块、任务编排、capabilities、BFF 路由、UI 面板、页签、`pnpm build`（`dist` 16:54）。

**还没做（按顺序）**：

1. `pnpm typecheck` + 浏览器实际打开“视频换脸”页签，确认没有运行时报错、没有布局错位。
2. 远端同步 `videofaceswap.py` / `app.py` 并重启 `deepfake-tts` 会话；确认 `decord`、`imageio-ffmpeg` 在 `envs/tts` 里可 import。
3. 端到端跑一条 2–5s、正脸、带音轨的 MP4：确认输出可播放、音轨在、时长对、report 里 `frames/swapped_frames/seconds` 合理。
4. 失败路径：无人脸、>300 帧、竖屏、无音轨、MOV/HEVC、100MB 上限。
5. 记录真实指标（每帧耗时、总耗时、峰值显存、成功率），补进 `server/README.md`。

### 4.2 用真实数据集做评估 —— 进行中，且卡在数据获取

- `demo_data/rtfs_meta.json`、`videos.csv`、`photos.csv`、`inswapper.csv` 已拿到（RTFS-10k：1636 目标视频、2000 源照片、9772 条 inswapper 生成视频）。
- 已下载 2 条目标视频和 6 条数据集自带 inswapper 视频，但 **3 张源照片是 `Entry not found`**，说明下载/解压工具在缺条目时写了占位文本而不是报错。
- `SDFVD.zip` 快照时仍在增长（16:56 仍在写，13.9MB），**当前不是合法 zip**；`SDFVD2.0.zip`、`kaggle_sdfvd.zip` 也已损坏（无中央目录）。
- 结论：**在修好下载器之前，不要基于这些数据出任何指标。**

### 4.3 文档回填 —— 未开始

README、`app/README.md`、`docs/02`、`docs/08` 都还停留在“视频换脸未做 / 7 个页签”的状态；`docs/09` 也还没有视频换脸的模型与许可条目。附录 A 列了逐条差异。

### 4.4 今天就能做的验证清单

```powershell
# 1) 前端静态检查 + 构建
cd app; pnpm typecheck; pnpm build

# 2) 起服务（另开窗口保持隧道）
pnpm start        # http://127.0.0.1:8787

# 3) 浏览器验收：视频换脸页签 → 源脸 + 视频 → 勾选 → 提交
#    期望：进度条走 swapping；结果 <video> 可播放；历史里出现 video.face_swap

# 4) 远端确认（隧道窗口另开）
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18000/v1/capabilities
#    期望：capabilities 里出现 task=video.face_swap，limits.max_frames=300
```

---

## 5. 难题（按“难”排序）

### 5.1 检测的跨生成器泛化与阈值标定

- 现状：RealForensics 在 FF++ 上训练，图片检测器在 Celeb-DF/FF++ 上训练；平台自己的换脸（HyperSwap 2025）与 RTFS（视频会议场景）都不在训练分布里。
- 难点：阈值不可跨生成器迁移；用自己生成的假样本调阈值 = 对自己模型过拟合；公开 benchmark 的高分到真实传播数据会崩。
- 需要：按“生成器/来源”划分的 hold-out；AUC、EER、FPR@TPR=95%；报告真实值而不是硬调阈值。

### 5.2 防御到底有没有用

- 现状：CLIP PGD 与 ArcFace 身份空间不对齐；对检测器分数的影响不稳定；视频重编码会削弱扰动。
- 难点：评估必须闭环（保护 → 换脸攻击 → 身份相似度），而换脸有随机性、多 target、多 seed；画质（PSNR/SSIM）与保护强度天然矛盾。
- 需要：固定攻击协议（N 源 × 5 target × 固定 seed）、ArcFace 余弦分布、JPEG/重编码鲁棒性；方法上升级 SGD-Guard / NullSwap / TrustMark。

### 5.3 视频换脸的时序质量与吞吐

- 现状：逐帧独立检测 + 独立换脸，没有 track、没有时序平滑；300 帧上限（30fps 只够 10s）；每帧 ONNX 推理 + JPEG 落盘，吞吐未测。
- 难点：闪烁来自逐帧对齐与身份 embedding 抖动，不是换脸模型本身；要 tracking + 时序约束，又不能拖慢实时性；还要保证音画同步与编码质量。
- 需要：先量化（帧间身份相似度方差、闪烁主观评分、每帧耗时、峰值显存），再决定是否上 tracking/参考帧锚定。

### 5.4 评估与数据工程

- 现状：下载器会把 “Entry not found” 写成 `.jpg`；zip 无校验；没有 manifest；实验没有记录“哪条视频 + 哪张源脸 + 什么参数”。
- 难点：HF 大文件、gated 仓库、网络中断、分卷/分目录；数据集许可（RTFS 是 CC-BY-SA-4.0，生成物可能继承）。
- 需要：下载器（重试/断点/sha256/缺条目即失败）、`manifest.jsonl`（样本 ID、来源、许可、生成器）、实验 ID 贯穿报告。

### 5.5 许可证与合规

- HyperSwap：ResearchRAIL（非商业研究）；inswapper_128：非商业；AVFF：仓库无明确 LICENSE；Forensics v2：CC-BY-NC-4.0 + gated（当前 token 403）。
- 影响：本地演示可以，公开演示/商用要换模型或拿授权；视频换脸本身伦理敏感，必须限定“本人/授权素材 + 防御实验”的叙事。
- 需要：每个模型卡片写清 license 与“能否公开演示”；生成物带清单/水印；演示素材只用自采或明确授权。

### 5.6 共享 GPU 与运维

- 现状：GPU 0 被占，固定 GPU 1；根分区 25GB；单进程单队列单 worker；tmux 常驻；隧道断了任务会卡 `running`（已发生）。
- 难点：邻居负载不可控、不能容器化、重启后要对账、磁盘和显存都没有监控。
- 需要：任务超时与自动失败、队列上限、健康检查、断线重连、显存/磁盘采样。

---

## 6. 给 Codex 的工作约定

### 6.1 硬约束

- **不要用 GPU 0**；服务默认 `CUDA_VISIBLE_DEVICES=1`。
- 所有模型/缓存/环境写 `/ssd`，不要写根分区。
- 不要提交/移动 `models/`、`demo_data/*.zip`、`实验用视频/`、`app/node_modules`、`app/dist`。
- 不要覆盖 `app/.env`（含 Token）；不要在日志/报告里打印 Token。
- 生成类功能只处理“本人/已授权”素材；不要加“针对他人”的流程。
- 远端改完必须重启 tmux 会话并验证 `/v1/health` 与 `/v1/capabilities`，不要只看代码。
- 本地 `server/` **不是**远端正在跑的代码：远端跑的是 `/ssd/ai_security/deepfake-platform/code/` 下的一份拷贝，仓库里没有同步脚本。改完本地必须显式上传/覆盖远端再重启，否则等于没改。

### 6.2 建议顺序与验收

| 优先级 | 任务 | 验收 |
|---|---|---|
| **P0** | 修数据获取：缺条目/坏 zip 必须报错；支持断点与 sha256；重建 RTFS 小样本（2 视频 × 3 源脸） | 目录里不再出现 <1KB 的 `.jpg`；`manifest.jsonl` 可追溯到 HF 路径；`python -c "zipfile.ZipFile(...)"` 全部通过 |
| **P0** | 视频换脸端到端验收 + 指标记录 | 2–5s 视频成功、音轨保留、report 数字合理；无脸/超长/无音轨有明确错误码；`server/README.md` 有实测表 |
| **P1** | 补依赖与部署：`decord`、`imageio-ffmpeg` 进 `requirements.txt`；`run.sh` 增加启动自检 | 新环境按 README 一次装好；`/v1/capabilities` 里 video.face_swap 为 ready |
| **P1** | 检测评估脚本：固定 20 真 / 20 假（后续 100/100），输出 AUC/EER/FPR 与混淆矩阵 | 一条命令产出 JSON + 表；阈值由评估决定，不写死 0.58 |
| **P2** | 防御闭环评估：保护图 → HyperSwap/inswapper 各 5 次 → ArcFace 相似度 | 报告“相似度下降分布”，而不是检测器分数；结论与样本量一起写 |
| **P2** | 工程基线：`git init` + 首次提交；契约示例校验脚本；任务超时与对账 | 能 diff、能回滚；A-01 自动跑；卡死 job 会被标记 failed |
| **P3** | 前端去重：抽公共上传/轮询/历史 hook；补视频换脸 UI 测试脚本 | 新增页签 < 100 行；`pnpm typecheck` 通过 |

### 6.3 不要做

- 不要用“检测器分数变化”证明防御有效。
- 不要在个位数样本上给出“检测率/AUC”结论。
- 不要把 `Entry not found`、空文件、截断视频当正常输入继续跑。
- 不要为了让数字好看而改阈值；先报告真实值。
- 不要在没有 `git` 的情况下大范围重构（先提交基线）。

### 6.4 完成定义（沿用 docs/08 §13）

功能过验收 + 错误路径有错误码和 UI 文案 + 文档（接口/模型/部署/指标）同步 + 没有新增未登记端口/任务/错误码 + 本地与远端都能清理演示数据 + 说清“下一步做什么、为什么”。

---

## 7. 速查

| 项 | 值 |
|---|---|
| 本地网页 | `http://127.0.0.1:8787` |
| BFF 入口 | `app/server/index.mjs`；`pnpm start` |
| 远端 API | `http://127.0.0.1:18000`（隧道后） |
| 隧道 | `ssh -i "C:\Users\Matrix\Downloads\a800_ai_security" -p 55105 -N -L 18000:127.0.0.1:18000 ai_security@103.79.25.90` |
| 远端启动 | `tmux new -d -s deepfake-tts "bash /ssd/ai_security/deepfake-platform/code/run.sh >> /ssd/ai_security/deepfake-platform/logs/gateway.log 2>&1"` |
| 远端日志 | `/ssd/ai_security/deepfake-platform/logs/gateway.log` |
| 本地任务记录 | `app/data/store.json`（25 条，10-31 至 11-03） |
| 本地产物 | `app/data/results/`（26 个文件，约 19.7MB） |
| 远端任务库 | `/ssd/ai_security/deepfake-platform/data/gateway.db` |
| 视频换脸（远端） | `server/videofaceswap.py`；`app.py:560` 处理、`app.py:1518` 提交、`app.py:1238` 能力声明 |
| 视频换脸（BFF/UI） | `app/server/index.mjs:819`；`app/src/VideoFaceSwapPanel.tsx`；`App.tsx:492/596` |
| 视频检测时间轴 | `server/videodetect.py:224`（25fps 硬编码处） |
| 图片阈值 | `server/imagedetect.py:32`（`THRESHOLD = 0.58`） |
| 契约示例 | `contracts/examples/`（7 个，无视频换脸示例） |

---

## 附录 A · 文档与实现不一致清单

| # | 位置 | 文档说法 | 实际 | 建议 |
|---|---|---|---|---|
| A1 | `README.md:6` | 7 个页签，视频换脸后续 | 8 个页签，视频换脸已接 | 更新页签列表与状态 |
| A2 | `app/README.md:151` | 视频换脸还没做 | 已实现并构建 | 更新功能表与测试命令 |
| A3 | `docs/08-roadmap-and-acceptance.md:3` | 视频换脸待推进 | 已实现 | 更新进度行与 P4 勾选 |
| A4 | `docs/02-api-contracts.md:209` | `video.face_swap` 输入 `source_video` + `source_image` | 代码用 `video` + `source_image` | 统一字段名，改文档或改代码 |
| A5 | `docs/02-api-contracts.md:215` | 有 `defend.audio` | 未实现 | 标注“规划中”或删除 |
| A6 | `docs/09-model-audit.md` | 没有 `video.face_swap` 的模型、许可、实测条目 | 已上线 | 补模型审计（HyperSwap/inswapper 用于视频、逐帧耗时、许可） |
| A7 | `server/README.md:4` | 可用服务不含 `video.face_swap` | 已加入 | 更新服务清单 |
| A8 | `docs/04-detection.md` | 默认阈值 0.5（音频窗口） | 图片 0.58、音频 0.5、视频 0.5 不统一 | 写清每个模态的阈值与来源 |
| A9 | `docs/00-overview.md` | 非目标：本轮不写代码 | 已写到 P4 | 历史文档，标注“已完成”即可，不必改 |

> 当前没有任何自动校验这 7 个契约示例的脚本；`docs/08` 的 A-01 仍是手工验收项。

---

## 附录 B · 证据与数据点

- 本地 job：`app/data/store.json` 共 25 条；分布：image.face_swap 8 成功 / 1 失败（`InvalidProtobuf`，HyperSwap 权重曾损坏一次，后修复）、detect.video 5、defend.video 4 成功 + 1 卡死、defend.image 2、detect.image 1、detect.audio 1、2 条旧记录无 `task` 字段（1 成功 1 取消）。
- 卡死任务：`job_8a8d280a0d4e8af6`，`defend.video`，`running`，11-01 起，`warning=REMOTE_TIMEOUT`。
- 视频防御耗时：`job_7187c71076826643`，250 帧 / 24.22fps，355s。
- 数据集：RTFS-10k（`kontur-ai/rtfs-10k`，CC-BY-SA-4.0，1636 clips / 2000 photos / 9772 inswapper 视频）；本地 2 条目标视频 + 6 条数据集自带 inswapper 视频（**非本平台产出**）。
- 坏文件：`demo_data/rtfs/2-192.jpg`、`3-249.jpg`、`3-597.jpg` 内容均为 `Entry not found`；`demo_data/generations_info.csv` 同样。
- 快照时 zip 状态：`SDFVD.zip` 仍在写入（13.9MB）、`SDFVD2.0.zip` 与 `kaggle_sdfvd.zip` 均非法 zip。

---

## 附录 C · 粘贴给 Codex 的开场提示

```text
你在 C:\Projects\deepfake-platform 工作。先完整读 docs/10-progress-handoff.md，
再按需读 README.md、docs/02、docs/08、server/README.md、app/README.md。

硬约束：不要用 GPU 0；不要覆盖 app/.env；仓库没有 git，大改前先 git init 并提交基线；
远端改完必须重启 tmux 并验证 /v1/health 与 /v1/capabilities。

第一步只做 §6.2 的两个 P0（修数据获取、视频换脸端到端验收）。
先复述你理解的现状与风险，列出准备修改的文件和验证方式，等我确认后再动手。
```

---

*本文档是快照，不是承诺。改动后请同步更新 §2 的状态表、§4 的进行中清单，以及附录 A。*
