# Handoff 推进记录 · 2026-11-07

## 已完成

- 初始化 Git，提交现有代码基线 `09ec38a`，建立 `main` 和工作分支 `codex/handoff-data-validation`。
- 排除密钥、素材、模型、运行数据与构建产物；没有修改 `app/.env`。
- `pnpm check`（TypeScript + Vite 构建）通过。
- 本地 `/api/health` 返回远端在线，队列空闲，`video-face-swap` ready；这不是生成端到端验收。
- 新增 Node 22+ 数据下载入口，HTTP 错误、低于 1KB 文件、JPEG 首尾标记缺失、MP4 文件头缺失、预期 SHA-256 不匹配均失败，不覆盖已有文件。完成后原子替换并记录来源、许可、时间、大小和 SHA-256。
- 自动测试覆盖占位文本、404、截断 JPEG、错误哈希、路径越界、失败保留原文件和成功写入。

## 使用

```powershell
node --test scripts/fetch-dataset.test.mjs
node scripts/fetch-dataset.mjs scripts/rtfs-sample-plan.json demo_data/verified
```

计划示例固定 HF revision，完成全部样本后生成 `manifest.jsonl`。计划可提供 `sha256` 来校验预期内容；未提供时记录的是本次下载的哈希，不能证明上游真实性。输出目录建议每次实验单独建立，失败时不会发布新 manifest。

## 尚未解决

- 下载器当前只做 JPEG/MP4 基础结构检查，不能替代完整解码；尚不支持 ZIP 校验、断点续传与压缩包条目提取。暂勿将旧下载产物用于评估。
- 本地 `rtfs_meta.json` 的文件清单只有 `photos.csv`，没有源照片文件或照片 ZIP。三个源脸名称只出现在生成视频名称中；重建 2 视频 × 3 源脸前，需要确认合法源图获取位置。
- 远端已报告视频换脸 ready，但本次没有上传素材、执行生成或部署变更；2–5 秒带音轨视频、无人脸、无音轨、超长输入仍待实际验收。
- 本机 `python` 指向 Windows Store 占位程序，不能用它运行 Python ZIP 校验或远端模块测试。

下一步优先解决源图获取位置，然后用已授权素材完成视频换脸验收并记录音轨、时长、帧数和耗时，再推进评估。
