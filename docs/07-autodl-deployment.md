# 07 · GPU 服务器部署与联通（当前共享 A800 / AutoDL 备选）

## 0. 当前使用的服务器（2026-10-31 实测）

> 以下是当前实际部署目标。§1 之后的 AutoDL 内容保留，作为换卡/迁移时的参考。

| 项 | 实测 |
|---|---|
| 主机 | `g0105`，SSH `ai_security@103.79.25.90 -p 55105` |
| GPU | 8 × **A800-SXM4-80GB**，驱动 `590.48.01` |
| 当前用卡 | **GPU 1**（GPU 0 被其他任务占用，约 34GB / 96%） |
| 项目目录 | `/ssd/ai_security/deepfake-platform` |
| 环境 | `envs/tts`：Python 3.10.21 venv、torch 2.6.0+cu124、qwen-tts 0.1.1、transformers 4.57.3、insightface 0.7.3、onnxruntime-gpu 1.23.2 |
| 模型 | TTS 4.3GB；音频检测 Spectra 1.2GB + XLS-R 底座 1.3GB + XLS-R 分类 1.2GB；换脸 inswapper 554MB + buffalo_l；图片检测 2 个 EffNet-B4；防御 CLIP 578MB |
| 服务 | `tmux` 会话 `deepfake-tts`，监听 `127.0.0.1:18000`；本地网页 `app/` 在 `127.0.0.1:8787`（依赖本机 ffmpeg 把 m4a/mp3 转 WAV） |
| 本地接入 | SSH 隧道，密钥 `C:\Users\Matrix\Downloads\a800_ai_security` |
| 磁盘 | 根分区仅 25GB 可用；`/ssd` 约 527GB 可用（93% 已用） |

P2 实测：

- 模型加载 **2.4s**，加载后显存 3.91GB；
- 3.68s 输出音频生成 **6.8s**，峰值 4.29GB；
- API 端到端（8.08s 参考音频）约 **12s**，产物 4.24s WAV；
- 无 `flash-attn`（使用 PyTorch 手动 attention），无系统 `sox` / `ffmpeg` / `nvcc`；
- `qwen-tts` 未装 `gradio`（非必需依赖），API 正常。

P3 音频检测实测：

- Spectra-AASIST3：用户真实中文 0% fake，Qwen 克隆中文 99.98%、英文 97%；
- XLS-R ASVspoof：真实中文 28.8%，Qwen 克隆中文 82.3%、英文 10.2%；
- 检测模型按需加载，GPU 1 余量充足；结果含 4 秒窗口时间线与模型警告。

P3 图片/换脸/防御实测：

- 换脸（inswapper_128）：预热后约 **0.145s/张**，首张约 5s；
- 图片检测：示例合照真人最高 fake 56%、换脸图 61%，阈值 58%；输出整脸框 + top-2 区域 + 热图；
- 图片防御：中档 PSNR **40.87dB**、SSIM **0.9802**、水印解码成功；旧版 CLIP 全局扰动实际保护有限，新方法评估中。

```bash
# 本地连接
ssh -i "C:\Users\Matrix\Downloads\a800_ai_security" -p 55105 ai_security@103.79.25.90

# 本地隧道
ssh -i "C:\Users\Matrix\Downloads\a800_ai_security" -p 55105 `
  -N -L 18000:127.0.0.1:18000 ai_security@103.79.25.90

# 远端服务状态
tmux ls
tail -f /ssd/ai_security/deepfake-platform/logs/gateway.log
```

共享机注意：不要用 GPU 0；GPU 1 现在空闲但需与师兄协调长期占用；所有环境/模型/缓存放 `/ssd`，不要写满根分区。

> **P2 实现**：当前是单进程 `code/app.py`（FastAPI，同时承担网关与 TTS），环境在 `envs/tts`，启动脚本 `code/run.sh`。P3/P4 再按 §5 拆成网关 + 分模型服务。

## 1. 已核实的平台事实

- AutoDL 实例没有独立公网 IP；官方为每个实例的 **6006 / 6008** 端口提供公网映射，地址在控制台「自定义服务」获取，例如 `https://u39-b3fb-39a640fd.nmb2.seetacloud.com:8443`。
- 官方文档提示「开放端口」需要企业认证；个人账号通常应使用 **SSH 隧道**把实例端口代理到本地（[开放端口](https://www.autodl.com/docs/port/)、[SSH 隧道](https://www.autodl.com/docs/ssh_proxy/)）。
- SSH 隧道命令形如：

```bash
ssh -CNg -L 18000:127.0.0.1:18000 root@region-3.autodl.com -p 48332
```

- Windows 也可用 AutoDL 官方免安装工具（输入端口号即可），适合不想记命令的场景。

> 结论：默认走 SSH 隧道；6006/6008 作为备选，启用前先在控制台确认账号权限。

## 2. GPU 选型决策表

| GPU | 显存 | 适合阶段 | 能跑什么 | 注意 |
|---|---|---|---|---|
| RTX 4090 | 24GB | P2 / P3 | Qwen3-TTS 1.7B + 图像检测；单路 512/720p 视频 | 视频重模型可能 OOM；性价比高 |
| RTX 4090D | 24GB | P2 / P3 | 同 4090，性能约低 5–10% | 国内版，CUDA 生态一致；价格通常更低；视频仍受 24GB 限制 |
| RTX 5090 | 32GB | P2–P4 | 同上，余量更大 | 看 AutoDL 库存与价格 |
| A800-SXM4-80GB | 80GB | P2–P6 | 当前共享服务器；TTS + 检测 + 视频余量充足 | 共享机需协调；当前用 GPU 1 |
| L20 | 48GB | P4 | 720/1080p 唇形/换脸，TTS 常驻 | 推荐做视频阶段主力 |
| vGPU-48GB | 48GB | P2–P4 | 与 48GB 档相同；TTS + 检测常驻，再加载单路视频 | 虚拟分卡（通常 A100/A800，以下单页为准）；同物理卡邻居可能影响带宽 |
| A6000 | 48GB | P4 | 同上，生态成熟 | 价格通常高于 L20 |
| A100 80GB | 80GB | P5/P6 | 并发重模型、批量评估 | 演示阶段通常没必要 |
| MTT S4000 | 48GB | 不推荐 | MUSA 生态，非 CUDA；本项目依赖需移植 | 48GB 不能抵消移植成本，演示阶段不选 |

建议路径：

1. **P2 先租 24GB（4090）**：只跑 Qwen3-TTS + 图片检测，成本最低，够验证全链路。
2. **P4 再升 48GB（L20/A6000/vGPU-48GB）**：视频模型显存与时长都更从容。
3. 只有需要“TTS 与视频同时常驻/并发”时才考虑 80GB。

> 如果 vGPU-48GB 价格可接受，也可以从 P2 直接用它，省去中途换卡；只做音频克隆 + 图片检测时，4090 24GB 更省钱。vGPU 是虚拟分卡，不等于独占物理卡，长期使用前先做一次基准测试（见 §11）。
>
> 同为 24GB 时：4090 与 4090D 价差不大选 4090；4090D 更便宜且 CUDA 生态一致，是合理替代。**MTT S4000 的 48GB 不解决生态问题**，Qwen3-TTS、flash-attn、InsightFace 等 CUDA 依赖需要移植，演示阶段不选。

数据盘：视频模型权重动辄 20–60GB，建议数据盘 ≥100GB；权重放 `/root/autodl-tmp`，不要放系统盘。

## 3. 实例与目录

### 3.1 基础镜像

- Ubuntu 22.04 + PyTorch 2.x + CUDA 12.x（选 AutoDL 预装镜像，避免自己编 CUDA）。
- Python 3.12（conda 独立环境）。
- ffmpeg（系统包或静态包）。
- 磁盘：系统盘放代码，数据盘放权重与缓存。

### 3.2 目录布局

```text
/root/deepfake-platform/              # 代码（系统盘，可 git pull）
├─ gateway/                           # FastAPI 网关
├─ services/tts/                      # Qwen3-TTS 服务
├─ services/vision/                   # 换脸/唇形/检测/防御
├─ scripts/                           # 启停、健康检查、下载模型
└─ config/

/root/autodl-tmp/deepfake/            # 数据盘（持久）
├─ models/                            # 权重
├─ cache/uploads/                     # sha256 去重
├─ artifacts/                         # 产物（TTL）
├─ logs/
└─ gateway.db
```

软链：`ln -s /root/autodl-tmp/deepfake/models /root/deepfake-platform/models`，让各服务用统一相对路径。

## 4. 环境与依赖

### 4.1 三个独立环境

| 环境 | 用途 | 主要依赖 |
|---|---|---|
| `gateway` | 网关 | fastapi、uvicorn、pydantic、httpx、sqlite |
| `tts` | Qwen3-TTS | torch、qwen-tts、flash-attn、soundfile、numpy |
| `vision` | 视频/检测/防御 | torch、insightface、onnxruntime-gpu、opencv-python、diffusers、ffmpeg-python、Pillow |

分环境的原因：`flash-attn`、`insightface`、diffusers 的版本约束容易互相冲突；网关保持轻量，重启快。

### 4.2 安装要点

```bash
conda create -n tts python=3.12 -y
conda activate tts
pip install -U pip
pip install -U qwen-tts
pip install -U flash-attn --no-build-isolation   # 编译慢；可找预编译 wheel
```

- flash-attn 需要 fp16/bf16；编译内存不足时 `MAX_JOBS=4`。
- 国内下载权重优先 ModelScope；HuggingFace 可设 `HF_ENDPOINT=https://hf-mirror.com`。
- 所有模型下载到数据盘；记录版本/commit 到 `models/MANIFEST.md`。

### 4.3 Qwen3-TTS 权重

```bash
modelscope download --model Qwen/Qwen3-TTS-Tokenizer-12Hz --local_dir /root/autodl-tmp/deepfake/models/Qwen3-TTS-Tokenizer-12Hz
modelscope download --model Qwen/Qwen3-TTS-12Hz-1.7B-Base --local_dir /root/autodl-tmp/deepfake/models/Qwen3-TTS-12Hz-1.7B-Base
modelscope download --model Qwen/Qwen3-TTS-12Hz-0.6B-Base --local_dir /root/autodl-tmp/deepfake/models/Qwen3-TTS-12Hz-0.6B-Base
```

- 1.7B 主用，0.6B 作为 OOM 降级。
- 首次加载会校验/编译，预留 1–2 分钟；服务启动时预热。

## 5. 服务布局

| 服务 | 端口 | 监听 | 说明 |
|---|---|---|---|
| 网关 | 18000 | `127.0.0.1` | 唯一对外入口；Token 鉴权 |
| TTS | 18001 | `127.0.0.1` | Qwen3-TTS 0.6B/1.7B |
| 视觉 | 18002 | `127.0.0.1` | 换脸/唇形/说话头/检测/防御 |
| 检测（可选拆分） | 18003 | `127.0.0.1` | 高负载时把检测独立出来 |

启动顺序：网关 → TTS → 视觉。网关启动时容忍工作服务未就绪（状态 `loading/offline`），工作服务就绪后自动注册。

### 5.1 进程管理

AutoDL 容器内不一定有 systemd；优先用 `supervisor`：

```ini
[program:gateway]
command=/root/miniconda3/envs/gateway/bin/uvicorn app.main:app --host 127.0.0.1 --port 18000
directory=/root/deepfake-platform/gateway
autostart=true
autorestart=true
stdout_logfile=/root/autodl-tmp/deepfake/logs/gateway.log
stderr_logfile=/root/autodl-tmp/deepfake/logs/gateway.err.log
```

- 每个服务 `--workers 1`（GPU 任务不要多 worker）。
- 日志按天轮转，保留 7 天。
- 退出信号要处理：等待当前任务结束或写回 `interrupted`。

### 5.2 环境变量

远端 `config/remote.env`：

```bash
GATEWAY_TOKEN=<32 字节随机 hex>
INTERNAL_TOKEN=<另一个随机 hex>
DATA_ROOT=/root/autodl-tmp/deepfake
MODEL_ROOT=/root/autodl-tmp/deepfake/models
ARTIFACT_TTL_HOURS=24
UPLOAD_TTL_HOURS=24
MAX_UPLOAD_MB=500
LOG_LEVEL=info
```

- Token 用 `openssl rand -hex 32` 生成，不提交到 git。
- 内部 Token 只用于网关 ↔ 工作服务。

## 6. SSH 隧道（默认方式）

### 6.1 命令

在 Windows PowerShell 执行（替换 host/port）：

```bash
ssh -CNg -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes `
  -L 18000:127.0.0.1:18000 root@region-3.autodl.com -p 48332
```

- 无输出是正常的；窗口保持打开即隧道可用。
- `-N` 不执行远程命令，`-g` 允许本地转发，`-C` 压缩。
- 本机 18000 被占用时改本地端口，并同步改本地配置 `remote.baseUrl`。

### 6.2 验证

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:18000/v1/health
```

返回 `status: ok` 即通；401 是 Token 问题；连接拒绝是隧道/服务问题。

### 6.3 稳定性

- 网络断开后 SSH 会退出；本地 BFF 显示 `REMOTE_UNREACHABLE`，任务保留，重连后可重试。
- P6 可用 Windows 任务计划/`autossh` 自动重连；演示阶段手动即可。
- AutoDL 实例关机/重启后 IP/端口可能变化，需更新命令与配置。

## 7. 6006/6008 公网方式（备选）

1. 在控制台确认账号具备自定义服务/开放端口权限（官方提示需企业认证）。
2. 让网关监听 6006：`uvicorn ... --port 6006`，或 nginx 监听 6006 反代 18000。
3. 在「自定义服务」复制公网地址，填入本地 `remote.baseUrl`（HTTPS）。
4. 必须启用 Token；不暴露 18001/18002；不要关闭鉴权。
5. 公网模式下建议加 IP 白名单/速率限制；演示结束及时关闭实例。

> 不建议为了省事把 18000 直接绑 `0.0.0.0` 裸奔；AutoDL 的公网映射已经足够，且可随时撤销。

## 8. 本地 BFF 配置

`config/local.json`（代码阶段创建，不提交 Token）：

```json
{
  "remote": {
    "mode": "ssh_tunnel",
    "baseUrl": "http://127.0.0.1:18000",
    "token": "<same as GATEWAY_TOKEN>",
    "healthIntervalMs": 10000,
    "timeoutMs": 30000
  },
  "storage": {
    "dataDir": "./data",
    "artifactTtlDays": 7,
    "maxUploadMb": { "image": 20, "audio": 50, "video": 500 }
  },
  "detection": { "threshold": 0.5, "cpuFallback": true },
  "generation": { "defaultLanguage": "Chinese", "defaultQuality": "high", "asrFallback": true }
}
```

- `mode`：`ssh_tunnel` / `public_url`，仅影响 UI 提示与健康检查文案。
- Token 只写不读回；设置页显示“已配置”。

## 9. 首次部署（P2：Qwen3-TTS 闭环）

- [ ] 租 24GB 4090，选 PyTorch 2.x + CUDA 12.x 镜像，数据盘 ≥100GB
- [ ] 创建 `gateway` / `tts` 环境，安装依赖
- [ ] 下载 Tokenizer + 1.7B Base + 0.6B Base 到数据盘
- [ ] 用官方示例跑通 `generate_voice_clone`（CLI，确认音频正常）
- [ ] 起 TTS 服务（18001），实现 `/internal/health`、`/internal/capabilities`、`/internal/execute`
- [ ] 起网关（18000），实现鉴权、`/v1/health`、`/v1/capabilities`、`/v1/assets`、`/v1/jobs`、SSE、文件下载
- [ ] 本地 SSH 隧道 + `curl /v1/health`
- [ ] 本地 BFF 配置 Token，提交一个 `audio.clone`，产物回传本地并可播放
- [ ] 记录实测：加载时间、10s 音频耗时、显存峰值，回填 [03 §2.1](03-generation-and-routing.md#21-模型选择)

验收：一条命令起服务、一条隧道通、一次克隆成功、失败时有明确错误码。

## 10. 运维手册

### 10.1 日常

| 操作 | 命令/位置 |
|---|---|
| 看服务状态 | `supervisorctl status` |
| 看日志 | `tail -f /root/autodl-tmp/deepfake/logs/gateway.log` |
| 看 GPU | `nvidia-smi` |
| 看队列 | `GET /v1/health` 的 `queue` |
| 清缓存 | 删除 `cache/uploads` 中超过 TTL 的文件；产物同理 |
| 重启单个服务 | `supervisorctl restart tts` |

### 10.2 常见故障

| 现象 | 排查 | 处理 |
|---|---|---|
| 本机连接拒绝 | 隧道是否在跑；远端服务是否监听 18000 | 重开隧道/重启网关 |
| 401 | Token 不一致 | 同步 `GATEWAY_TOKEN` 与本地配置 |
| 模型一直 loading | 权重路径/磁盘/显存 | 看 tts 日志；`nvidia-smi`；重新下载 |
| CUDA OOM | 并发/分辨率/模型过大 | 降档、卸载其他模型、换 0.6B |
| 磁盘满 | `df -h`、`du -sh` | 清 artifacts/cache；扩数据盘 |
| 任务卡 running | 工作进程死锁/被杀 | 网关超时标记失败；重启对应服务 |
| 隧道频繁断 | 本机网络/休眠 | 关闭休眠；P6 自动重连 |

### 10.3 更新模型

1. 新权重下载到新目录，不改旧目录。
2. 改服务配置指向新目录，重启服务。
3. 健康检查 + 冒烟测试（3 条输入）。
4. 通过后更新能力清单 `version`；保留旧目录一周以便回滚。
5. 记录到 `models/MANIFEST.md`（来源、commit、许可证、显存实测）。

### 10.4 备份

- 远端：权重目录 + `config/` + `gateway.db`；实例快照前先停服务。
- 本地：`data/studio.db` + `data/certs` + `manifests`；资产文件可按需备份。
- 不备份 Token 明文到云端。

## 11. 性能目标（P2/P3 实测回填）

上卡后先跑一次基准，确认 vGPU/物理卡的型号、显存与依赖：

```bash
nvidia-smi
python -c "import torch; print(torch.cuda.get_device_name(0)); print(torch.cuda.get_device_properties(0))"
python -c "import flash_attn; print(flash_attn.__version__)"   # 使用 flash-attn 时
```

再用 10s 参考音频跑一次 `generate_voice_clone`，记录端到端耗时与 `nvidia-smi` 显存峰值。vGPU 重点看：型号是否与下单一致、`flash-attn` 是否能加载、同卡邻居是否导致耗时波动。

| 场景 | 目标 | 备注 |
|---|---|---|
| 服务冷启动 | <120s | 含权重加载 |
| 10s 克隆音频 | <20s（4090，warm） | 不含首次加载 |
| 单张图片检测 | <3s | GPU |
| 60s 720p 视频检测 | <90s | 抽帧 60 张 |
| 图片保护（中档） | <30s | 含指标 |
| 10s 音频保护（中档） | <60s | 含指标 |
| 隧道空闲延迟 | <30ms | 同城网络 |

达不到时优先降分辨率/抽帧数，不要静默延长到用户以为卡死。

## 12. 成本与停机

- 按小时计费；演示结束关实例，权重在数据盘（关机不计 GPU 费，但可能收存储费）。
- 首次部署预留 2–3 小时；模型下载占大头。
- 视频阶段再升 48GB；不要在 24GB 上硬跑 1080p 长视频。
- 每次实验记录：GPU 型号、时长、显存峰值、失败原因，便于决定 `ggg`。
