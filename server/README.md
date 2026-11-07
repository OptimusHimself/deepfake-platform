# 远端服务（音频克隆/检测 + 图片换脸/检测 + 图片防御）

当前服务器上的可用服务：`audio.clone`、`detect.audio`、`image.face_swap`、`detect.image`、`defend.image`。上传、排队、生成/分析、下载/报告都已跑通；视频与音频/视频防御在后续阶段加入。

## 当前服务器（2026-10-31 实测）

- 主机：`g0105`，8 × **A800-SXM4-80GB**，驱动 `590.48.01`
- 固定使用 **GPU 1**（GPU 0 被其他任务占用，约 34GB / 96%）
- 代码：`/ssd/ai_security/deepfake-platform/code`
- 环境：`/ssd/ai_security/deepfake-platform/envs/tts`
  - Python 3.10.21（从 `persona_vectors` 的 Python 创建 venv，复用其 torch）
  - torch `2.6.0+cu124`、torchaudio `2.6.0+cu124`
  - qwen-tts `0.1.1`、transformers `4.57.3`、accelerate `1.12.0`
  - **没有安装 gradio**（qwen-tts 的非必需依赖）；**没有系统 sox / ffmpeg / nvcc**
- 模型：
  - Qwen3-TTS：`models/Qwen3-TTS-12Hz-1.7B-Base`（4.3GB）
  - 检测：`models/Spectra-AASIST3`（1.2GB）+ `models/wav2vec2-xls-r-300m`（1.3GB，Spectra 的 SSL 底座）
  - 检测：`models/wav2vec2-large-xlsr-deepfake`（1.2GB，XLS-R ASVspoof）
  - 换脸：`models/inswapper/inswapper_128.onnx`（554MB，2023 legacy）+ `models/hyperswap/hyperswap_1a_256.onnx`（约 402MB，2025）+ `models/buffalo_l`
  - 图片检测：`models/face-detector/best_model.pt`（Celeb-DF）+ `effnb4_best.pth`（FF++）
  - 防御：`models/clip-vit-base-patch32`（578MB）
  - 视频检测：`models/realforensics/realforensics_ff.pth`（86MB）+ `vendor/RealForensics`（CSN-r101，MIT）
- 数据：`/ssd/ai_security/deepfake-platform/data`
- 服务：`tmux` 会话 `deepfake-tts`，只听 `127.0.0.1:18000`

## 实测结果

### 音频克隆

| 项 | 结果 |
|---|---|
| 模型下载（ModelScope） | 4.3GB，约 6.5 分钟 |
| 模型加载 | **2.4s** |
| 加载后显存 | 3.91GB |
| 3.68s 输出音频生成 | **6.8s**，峰值 4.29GB |
| API 端到端（8.08s 参考音频） | 上传 + 排队 + 生成 + 下载 ≈ **12s** |
| 产物 | 4.24s / 203KB WAV |

### 音频检测（两个模型可选）

| 模型 | 真人中文样本 | Qwen 克隆中文 | Qwen 克隆英文 | 特点 |
|---|---|---|---|---|
| **Spectra-AASIST3**（推荐） | **0%** fake | **99.98%** fake | **97%** fake | XLS-R + KAN-AASIST，多语言基准强；0.3B |
| XLS-R 300M · ASVspoof 2019 | 28.8% fake | 82.3% fake | 10.2% fake | 更快/更小；英文为主，英文高质量克隆可能漏检 |

> 真人样本来自你上传的中文参考音频；克隆样本来自平台 Qwen3-TTS 生成。样本量很小，只用于演示选型，不代表 benchmark。

### 图片换脸

| 模型 | 年代 / 分辨率 | 说明 |
|---|---|---|
| **HyperSwap 1a 256** | 2025 / 256px / ResearchRAIL（非商业研究） | FaceFusion 3.3 默认；预热后 **0.122s/张**，首张约 10s |
| InsightFace inswapper_128 | 2023 / 128px / 非商业研究 | legacy 对照；预热后约 0.145s/张 |

- 目标多人脸默认选面积最大的脸，返回 `MULTIPLE_FACES` 提示。
- 模型卡片在网页显示厂商、年份、分辨率、许可、速度；旧模型不删除，可切换对比。

### 图片检测

- 模型：EffNet-B4 Celeb-DF + EffNet-B4 FF++ 集成，Grad-CAM。
- 示例（两脸合照）：真人最高 fake 56%，换脸图最高 **61%** fake；阈值 **58%**。
- 输出：整脸框、top-2 面部区域框、热图、概率、警告。
- 阈值是在少量内部样本上校准的，**不是正式 EER/FPR 评估**；新生成器可能漏检/误报。

### 视频检测

| 模型 | 年代 | 输入 | 许可 | 说明 |
|---|---|---|---|---|
| **RealForensics CSN-r101**（默认） | 2022 | 25 帧人脸 / 视频 | MIT | FF++ 预训练；CelebDF 86.9%、DFDC 75.9%、FaceShifter 99.7%（视频 AUC）；视觉单模态 |
| **AVFF / OpenAVFF Stage-3** | 2024 | 视频+音频 / 16 帧 | 未明确（非官方实现） | 音画融合；适合正脸说话/lip-sync；权重 713.5MB |

- 实测：RealForensics 预热后约 2–3s/条；AVFF 约 4–5s/条；首次加载约 5s。
- **2026-11-01 修复**：RealForensics 旧版中心裁 140px 只保留眼鼻，真实手机视频会 99.99% fake；改为完整对齐脸后，同一视频 11.26% fake（real）。AVFF 旧版把 `0=real` 的输出当 fake；改为 `1-p(real)` 后，同一视频 0.0% fake（real）。
- **视觉单模态 / 音画模型都可能对 Seedance 2.5 漏检**，需要自建样本评估。
- AVFF 仓库没有明确 LICENSE，仅用于本地研究验证；对外使用前需确认。

### 图片防御
- 当前基线：CLIP ViT-B/32 PGD + DwtDctSvd 水印 + HMAC-SHA256 证书（2022/2023 技术）。
- 实测（550×550 medium）：PSNR **40.87dB**、SSIM **0.9802**、水印解码成功。
- **局限**：优化的是 CLIP 全局语义，没有针对换脸身份编码器；实际对 HyperSwap/inswapper 的保护有限。SGD-Guard（IJCAI 2026）/ NullSwap（ICCV 2025）+ TrustMark 正在替换。

### 视频防御（实验）

- 逐帧 CLIP PGD + DwtDctSvd 水印，保留音轨，重建 H.264 MP4；最多 250 帧。
- 2s 实测：PSNR **41.7dB**、SSIM **0.9857**、水印匹配 **100%**（编码前）；RealForensics 保护前 6% fake → 保护后 95% fake。
- **注意**：这只证明扰动对检测器有影响，不等于换脸/重绘失败；需用 HyperSwap/inswapper 攻击后再算身份相似度。
- 视频接口：`POST /api/defend/video`，task `defend.video`。
- 保护不保证免疫压缩、裁剪、重绘或自适应攻击。

## 启动

```bash
BASE=/ssd/ai_security/deepfake-platform
tmux new -d -s deepfake-tts "bash $BASE/code/run.sh >> $BASE/logs/gateway.log 2>&1"
```

首次任务会按需加载 Qwen3-TTS 或检测模型；日志：

```bash
tail -f /ssd/ai_security/deepfake-platform/logs/gateway.log
```

## 本地隧道

```bash
ssh -i "C:\Users\Matrix\Downloads\a800_ai_security" -p 55105 `
  -N -L 18000:127.0.0.1:18000 ai_security@103.79.25.90
```

## API 冒烟

```bash
TOKEN=$(cat /ssd/ai_security/deepfake-platform/config/gateway_token)  # 远端
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18000/v1/health
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18000/v1/capabilities
```

- 克隆：上传参考音频 → 提交 `audio.clone` → 轮询/SSE → 下载 `/v1/files/{id}`。
- 音频检测：上传音频 → 提交 `detect.audio`（`model` 可选 `spectra-aasist3` / `xlsr-asvspoof` / `auto`）→ 轮询 job → 读取 `job.report`。
- 图片换脸：上传两张图片 → 提交 `image.face_swap`（`inputs.source_image` + `inputs.target_image`）→ 下载 PNG。
- 图片检测：上传图片 → 提交 `detect.image` → 读取 `report` 和 `artifacts.overlay`。
- 视频检测：上传视频 → 提交 `detect.video` → 读取 `report`（RealForensics）。
- 图片防御：上传图片 → 提交 `defend.image`（`options.strength`）→ 下载保护图 + `certificate`。
- 请求体见 `docs/02-api-contracts.md`。

## 已知限制 / 注意

- **不要用 GPU 0**；启动脚本默认 `CUDA_VISIBLE_DEVICES=1`。
- 根分区只剩约 25GB；所有环境、模型、缓存都在 `/ssd`。装包时设置 `PIP_CACHE_DIR`、`HF_HOME`、`MODELSCOPE_CACHE`、`CONDA_PKGS_DIRS` 到 `/ssd`。
- 当前支持 `audio.clone`、`detect.audio`、`detect.image`、`detect.video`、`image.face_swap`、`defend.image`。
- 换脸权重仅限非商业研究；商用需换授权模型。
- 图片检测阈值 58% 为内部小样本校准，不能当司法鉴定或通用 benchmark。
- 图片防御只做单图，视频/音频防御后续加入。
- **Forensics v2 尚未接入**：`eliya/forensics_0.3B_v2_deepfake_age_gender_classifier` 是 gated（人工审批）+ CC-BY-NC-4.0；当前 HF token 对文件返回 403。批准后可加为默认检测模型（5s 窗口，阈值约 0.1–0.2）。
- 检测分数不是司法鉴定结论；模型在公开反欺骗数据上训练，对训练集外的生成器可能漏检或误报。
- Spectra 的 `model.py` 已改为从本地 `SPECTRA_SSL_DIR`（XLS-R 底座）加载；重新下载后需保留这个补丁，`detector.py` 会在缺失时自动补。
- `sox` 系统二进制缺失：12Hz voice clone 走 `(numpy, sr)` 输入，不依赖它；如果以后切到 25Hz tokenizer 或需要转码，再补 `sox`/`ffmpeg`。
- `gradio` 未装：qwen-tts 的 Web Demo 不可用，但 API/模型推理正常。
- venv 复用了 `persona_vectors` 的系统 site-packages（torch 等）；如果那个共享环境被改动，可能影响本服务。后续可复制成完全独立环境。
- 服务是共享服务器上的常驻进程；停止用 `tmux kill-session -t deepfake-tts`，会释放 GPU 1。
