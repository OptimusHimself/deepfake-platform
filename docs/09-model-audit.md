# 09 · 模型审计与升级路线（2026-10-31）

> 这页回答：网页里每个模型/方法是什么时候的技术、性能如何、为什么旧防御没效果、接下来换什么。旧模型不删除，继续作为 legacy 对照保留在网页下拉/单选项中。

## 1. 当前线上模型

### 图片换脸

| 模型 | 年代 | 分辨率 | 许可 | 实测/说明 |
|---|---|---|---|---|
| **InsightFace inswapper_128** | 2023 | 128×128 | 非商业研究 | 预热后约 0.15s/张；侧脸、遮挡、细节较弱；legacy 对照 |
| **HyperSwap 1a 256**（已上线，默认） | 2025 | 256×256 | ResearchRAIL（非商业研究） | FaceFusion 3.3 默认；预热后 **0.122s/张**，首张约 10s 加载；身份和细节更好 |

### 图片检测

| 模型 | 年代 | 训练数据 | 许可 | 说明 |
|---|---|---|---|---|
| EffNet-B4 `honi05` | 2023 | Celeb-DF v2 | MIT | 自带 Grad-CAM；跨生成器泛化差 |
| EffNet-B4 DeepfakeBench | 2023 | FF++ | DeepfakeBench 权重（研究） | 作为第二分支；阈值 58% 为小样本校准 |
| 当前集成 | 2023 | Celeb-DF + FF++ | MIT + 研究 | 只适合作为 demo 基线；不能当 SOTA |

> 最新检测现状并不乐观：Deepfake-Eval-2024 在真实传播数据上，UFD AUC 0.56、NPR 0.53，很多“高 AUC”模型到 in-the-wild 接近抛硬币。换检测器必须同时换评估集，不能只看论文数字。

### 图片主动防御

| 方法 | 年代 | 技术 | 问题 |
|---|---|---|---|
| CLIP ViT-B/32 PGD + DwtDctSvd | 2022/2023 | 全局 CLIP 语义扰动 + DWT-DCT-SVD 水印 | **没有针对换脸模型的身份编码器**；水印抗压缩/裁剪弱；实际保护有限 |

### 视频检测

| 模型 | 年代 | 输入 | 许可 | 说明 |
|---|---|---|---|---|
| **RealForensics CSN-r101**（已上线） | 2022 | 25 帧人脸 / 视频 | MIT | FF++ 预训练；CelebDF 86.9%、DFDC 75.9%、FaceShifter 99.7%（视频 AUC）；视觉单模态 |
| AVFF / OpenAVFF（已接入） | 2024/2025 | 视频+音频 / 16 帧 | 非官方实现，需核实 | 音画融合，最适合正脸说话/lip-sync；Stage3 权重 713.5MB（Google Drive），仓库无明确 LICENSE |

**2026-11-01 修复的两个预处理 bug**：

- RealForensics：旧代码把 224px 对齐脸再中心裁 140px，只保留眼睛/鼻子，脸不完整，真实手机视频被推到 **99.99% fake**。改为使用完整对齐脸后，同一真实视频降到 **11.26% fake（real）**。
- AVFF：OpenAVFF 的 CSV 约定 `0=real`，输出第一列是 real 概率；旧代码把它当 fake。改为 `fake = 1 - p(real)` 后，同一视频为 **0.0% fake（real）**。

> 旧历史里的 100% fake 是这两个 bug 造成的，不代表模型判断。修复后需要重新上传视频测试。

### 视频防御（实验性）

- 方法：逐帧 CLIP PGD 扰动 + DwtDctSvd 水印，重建 H.264 MP4，保留原音轨。
- 限制：最多 250 帧；低强度 8 步、中强度 16 步；H.264 会削弱扰动和水印。
- 实测 2s 视频：PSNR 41.7dB、SSIM 0.9857、水印匹配 100%（编码前）；保护前 RealForensics 6% fake → 保护后 95% fake。
- **注意**：这个前后分数只证明扰动对 RealForensics 有影响，**不等于换脸/重绘失败**。真正的防御评估要用 HyperSwap/inswapper 攻击保护后的视频，再算身份相似度和可检测性。
- 下一步：SGD-Guard / NullSwap 这类针对身份编码器的防御，而不是继续用通用 CLIP 扰动。

**为什么之前保护没用**：inswapper/HyperSwap 取的是 ArcFace 身份 embedding，而旧方案推的是 CLIP 全局特征。视觉上看不出差别，换脸模型仍能提身份；我之前给的“相似度 0.898→0”是错误测试，已撤回。

## 2. 升级目标

### 换脸

- **HyperSwap 256**（FaceFusion 3.3，2025）：默认；保留 inswapper 128 作 legacy。
- 可选 **AlphaFace 256**（2026，非商业）；先做质量/速度对比再决定是否默认。
- 评价：同组源脸/目标图盲测、ArcFace 身份相似度、细节/侧脸、延迟。

### 检测

- **AIDE（ICLR 2025）**：多专家 + 频域特征，作为新分支。
- **CFA / TALL** 等 face-specific 检测器：换脸专用分支。
- **DINOv2/CLIP 特征 + 线性探针**：跨生成器分支。
- 用内部 20 真 + 20 假（后续扩到 100+100）测 AUC/EER；达不到 0.90 就如实报告，不硬调阈值。
- 红框/区域继续用 Grad-CAM 或分割头。

### 主动防御

- **SGD-Guard（IJCAI 2026）**：CLIP + 身份联合空间、语义梯度发散、SD-EOT、抗 JPEG/扩散净化；代码：[BACKAI/SGD-Guard_IJCAI26](https://github.com/BACKAI/SGD-Guard_IJCAI26)
- **NullSwap（ICCV 2025）**：identity cloaking。
- **FaceShield（ICCV 2025）**：face-specific defense。
- 水印换 **TrustMark**（抗压缩/裁剪）或 Dual Defense（2024）。
- 评估：原图/保护图各跑 **HyperSwap + inswapper**，5 个 target/seed；ArcFace 相似度、PSNR/SSIM、JPEG q70 后效果。

## 3. 新验收标准

| 项 | 标准 |
|---|---|
| 换脸 | HyperSwap 256 同组盲测 ≥8/10 优于 inswapper 128；身份/细节不降 |
| 检测 | 内部集 AUC ≥0.90、FPR ≤15%；否则报告真实值并继续迭代 |
| 防御画质 | 中档 PSNR ≥40dB、SSIM ≥0.98 |
| 防御有效性 | 对 HyperSwap/inswapper 各 5 次，身份相似度平均下降 ≥0.20，至少 3/5 次 <0.5 |
| 鲁棒性 | JPEG q70 后仍保留大部分身份下降 |
| 水印 | TrustMark 在 JPEG q70 后仍可解码 |

## 4. 网页展示

- 模型选项保留旧版，卡片注明：**厂商、年份、分辨率、许可、速度、定位（推荐/legacy）**。
- 检测/防御也标注技术年代和局限，避免把 2023 基线说成最新。
- 旧的 inswapper 128、EffNet-B4 集成、CLIP PGD + DwtDctSvd 继续可见、可切换、可对比。
