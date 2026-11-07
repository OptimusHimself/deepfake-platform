# 本地网页 · Deepfake Studio（音频克隆/检测 + 图片换脸/检测 + 视频检测 + 图片防御）

这是当前可用的本地网页：六个标签页。

- **音频克隆**：上传参考音频、参考文本、目标文本，调用 Qwen3-TTS。
- **图片换脸**：源脸图 + 目标图，HyperSwap 256 / inswapper 128。
- **音频检测**：选择 Spectra-AASIST3 / XLS-R / 自动。
- **图片检测**：EffNet-B4 集成 + Grad-CAM，整脸框 + top-2 区域 + 热图。
- **视频检测**：RealForensics CSN-r101，正脸说话视频。
- **主动防御**：CLIP PGD 扰动 + DwtDctSvd 水印 + 保护证书；仅图片。
- **视频防御**：逐帧扰动 + 水印，重建 MP4，并显示保护前后 RealForensics 分数/时间轴（实验性）。

## 访问
- 地址：`http://127.0.0.1:8787`
- 本地 BFF：`app/server/index.mjs`（只监听 `127.0.0.1:8787`）
- 远端服务：`127.0.0.1:18000`（SSH 隧道转发到共享 A800 的 18000）
- 当前 GPU：A800-SXM4-80GB，固定 GPU 1

## 前置

1. 远端 `deepfake-tts` 服务在跑（见 [`../server/README.md`](../server/README.md)）。
2. 本地 SSH 隧道已启动：

```bash
ssh -i "C:\Users\Matrix\Downloads\a800_ai_security" -p 55105 `
  -N -L 18000:127.0.0.1:18000 ai_security@103.79.25.90
```

3. `app/.env` 已配置（不要提交）：

```env
REMOTE_BASE_URL=http://127.0.0.1:18000
GATEWAY_TOKEN=<远端 app/config/gateway_token 的内容>
PORT=8787
HOST=127.0.0.1
```

模板见 [`.env.example`](.env.example)。

## 启动

```bash
cd app
pnpm install
pnpm build
pnpm start
```

打开 `http://127.0.0.1:8787`。

开发模式（可选）：先 `pnpm dev:server`，再 `pnpm dev:web`，Vite 在 5173，`/api` 代理到 8787。

## 页面功能

### 音频克隆
- 上传参考音频（3–30s，wav/mp3/m4a/flac，≤50MB），浏览器内可试听
- **m4a/mp3 等格式由本地 BFF 用 ffmpeg 统一转成 24kHz 单声道 WAV 后再上传**，所以远端模型不需要直接解码 m4a
- 填写参考文本（逐字稿）与目标文本（想让克隆声音说的话）
- 选择语言（默认中文）、勾选素材授权
- 提交后显示排队/加载模型/合成/整理等阶段与进度
- 成功后播放、下载 WAV、保存到 `%USERPROFILE%\Downloads\DeepfakeStudio\`

### 音频检测
- 上传待检测音频（wav/mp3/m4a/flac，≤50MB，≤120s）
- **自己选模型**：
  - `Spectra-AASIST3 · 多语言（推荐）`：中文真人判 real、Qwen 克隆判 fake；较慢
  - `XLS-R 300M · ASVspoof 2019`：更快；英文为主，英文高质量克隆可能漏检
  - `自动选择`：由服务端按优先级选择
- 结果：fake 概率、判定（偏假/偏真/不确定）、置信度、4 秒窗口时间线、可疑片段、模型说明与警告
- “最近生成/最近检测”保留本地历史，可重新打开结果

### 图片换脸
- 上传源脸图和目标图（JPG/PNG/WEBP，≤20MB）
- 可选模型：
  - **HyperSwap 256**：FaceFusion 2025，256px，ResearchRAIL 非商业研究
  - **InsightFace inswapper_128**：2023，128px，旧版基线（保留对照）
- 目标多人脸默认选最大脸；结果 PNG 下载/保存；多人脸会显示提示
- 模型卡片注明厂商、年份、分辨率、许可、速度；详见 [docs/09](../docs/09-model-audit.md)

### 图片检测
- 上传图片，EffNet-B4（Celeb-DF + FF++）集成打分
- 输出整脸框、top-2 面部区域框、Grad-CAM 热图、概率与警告
- 页面明确标注：这是 2023 基线，AIDE/CFA 新检测分支升级中

### 视频检测
- 上传正脸说话视频（MP4/MOV/WEBM，≤100MB）
- 可选模型：
  - **RealForensics CSN-r101**：2022，MIT，25 帧，视觉时序（默认）
  - **AVFF / OpenAVFF Stage-3**：2024，视频+音频，16 帧，音画联合；许可证未明确
- 显示整段视频判断、置信度、帧数
- 两类模型都可能对 Seedance 2.5 漏检；需要自建样本评估

### 主动防御
- 上传本人/授权照片，选择低/中/高强度
- 当前基线：CLIP PGD 扰动 + DwtDctSvd 水印（2022/2023）
- 页面明确标注：它没有针对换脸身份编码器，实际保护有限；SGD-Guard/TrustMark 升级中
- 输出 PSNR / SSIM、水印解码、保护图和 HMAC 证书

## 本地数据

```text
app/data/
├─ uploads/       # 上传的参考音频
├─ results/       # 从远端下载回来的 WAV
├─ store.json     # 任务历史（JSON，轻量持久化）
└─ ui-*.png       # UI 测试截图（可删）
```

以上目录已加入 [`.gitignore`](../.gitignore)。

## 本地 API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/health` | 本地 + 远端健康状态（GPU / 模型 / 队列） |
| GET | `/api/config` | 语言、大小限制、模型名 |
| POST | `/api/jobs` | multipart：`reference_audio`、`reference_text`、`target_text`、`language`、`consent` |
| POST | `/api/detect` | multipart：`file`、`model`、`consent`；提交 `detect.audio` |
| GET | `/api/detect/models` | 远端可用的音频检测模型（含说明/语言/速度） |
| POST | `/api/faceswap` | multipart：`source_image`、`target_image`、`consent`；提交 `image.face_swap` |
| POST | `/api/detect/image` | multipart：`file`、`consent`；提交 `detect.image` |
| POST | `/api/detect/video` | multipart：`file`、`consent`；提交 `detect.video`，返回 `report` |
| POST | `/api/defend` | multipart：`file`、`strength`、`consent`；提交 `defend.image` |
| GET | `/api/jobs/:id` | 刷新并返回任务；克隆成功后自动下载音频，检测成功后返回 `report` |
| GET | `/api/jobs` | 最近任务 |
| POST | `/api/jobs/:id/cancel` | 取消任务 |
| GET | `/api/files/:id` | 播放；`?download=1` 下载 |
| POST | `/api/jobs/:id/save` | 复制到下载文件夹 |

Token 只在 BFF 进程内使用，不进入浏览器。

## 测试

```bash
cd app
pnpm typecheck
pnpm build
pnpm test:ui      # 英文目标文本 + 保存按钮
pnpm test:ui:zh   # 中文目标文本
pnpm test:detect  # 音频检测（默认 Spectra，可传 AUDIO/MODEL）
pnpm test:faceswap  # 图片换脸（SOURCE/TARGET）
pnpm test:image-detect  # 图片检测（IMAGE/OUT）
pnpm test:video-detect  # 视频检测（VIDEO）
pnpm test:defense  # 图片防御（IMAGE）
```

UI 测试使用本机 Chrome（`playwright-core`，无需下载浏览器）。克隆测试会上传 `.ssh_tmp/clone.wav`；检测测试默认上传 `.ssh_tmp/api_result_zh.wav`，可用 `AUDIO`/`MODEL` 环境变量替换。

## 已知限制

- 已实现音频克隆、音频检测、图片换脸、图片检测、视频检测、图片防御；视频换脸/音频防御还没做。
- 参考音频在 BFF 侧用 **ffmpeg** 转码；本机需要 `ffmpeg` 在 PATH，或在 `.env` 里设 `FFMPEG_PATH`。ffmpeg 不可用时会返回 `INVALID_MEDIA`，不会把 m4a 原样发给远端。
- 远端 Python 服务只保证解码 WAV；直接调用远端 API 上传 m4a 仍会失败，请走本地网页/BFF。
- 本地历史是 JSON 文件，不是 SQLite；任务量很小，够 demo。
- 参考音频 >30s 或 <3s 会被远端拒绝；UI 只提示，最终以远端校验为准。
- 远端不可达时，任务会保留并显示警告；恢复隧道后刷新即可继续。
- 生成结果是 Qwen3-TTS 模型输出，不代表真人原声；请只使用本人/授权素材。
