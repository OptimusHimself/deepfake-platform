"""Video protection prototype: per-frame CLIP PGD + DwtDctSvd watermark.

This is intentionally conservative: every frame is protected, audio is copied
from the original, and the protected video is re-detected with RealForensics
so the UI can show a before/after timeline.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Tuple

import cv2
import numpy as np
import torch

import defense

BASE = Path(os.environ.get("DF_BASE", "/ssd/ai_security/deepfake-platform"))
TOKEN = os.environ.get("GATEWAY_TOKEN", "")
MAX_FRAMES = 250


def status() -> Dict[str, Any]:
    return {
        "model_id": "clip-pgd-video",
        "display_name": "视频防御（逐帧 CLIP PGD + 水印）",
        "task": "defend.video",
        "status": "ready",
        "loaded": defense.status().get("loaded", False),
        "license": "CLIP MIT；水印 DwtDctSvd；实验性",
        "year": 2022,
        "description": "逐帧扰动 + 水印，重建 MP4；用于验证视频防御可行性，不是生产级方案。",
    }


def _ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def protect_video(data: bytes, strength: str = "low") -> Tuple[bytes, Dict[str, Any], Dict[str, Any]]:
    import decord

    with tempfile.TemporaryDirectory(prefix="df-video-defense-") as tmp:
        root = Path(tmp)
        src = root / "input.mp4"
        src.write_bytes(data)
        reader = decord.VideoReader(str(src), ctx=decord.cpu(0))
        fps = float(reader.get_avg_fps() or 25.0)
        total = len(reader)
        count = min(total, MAX_FRAMES)
        if count == 0:
            raise ValueError("无法解码视频")
        frame_dir = root / "frames"
        frame_dir.mkdir()
        psnrs, ssims, wm_matches = [], [], []
        last_cert: Dict[str, Any] = {}
        for index in range(count):
            frame = cv2.cvtColor(reader[index].asnumpy(), cv2.COLOR_RGB2BGR)
            ok, encoded = cv2.imencode(".png", frame)
            if not ok:
                continue
            protected_bytes, cert, metrics = defense.protect(encoded.tobytes(), strength)
            protected = cv2.imdecode(np.frombuffer(protected_bytes, np.uint8), cv2.IMREAD_COLOR)
            cv2.imwrite(str(frame_dir / f"{index:06d}.jpg"), protected, [cv2.IMWRITE_JPEG_QUALITY, 95])
            psnrs.append(float(metrics.get("psnr_db") or 0))
            ssims.append(float(metrics.get("ssim") or 0))
            wm_matches.append(bool(metrics.get("watermark_match")))
            last_cert = cert
        out = root / "protected.mp4"
        cmd = [
            _ffmpeg(), "-y", "-loglevel", "error",
            "-framerate", f"{fps:.6f}", "-i", str(frame_dir / "%06d.jpg"),
            "-i", str(src), "-map", "0:v:0", "-map", "1:a?", "-shortest",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", str(out),
        ]
        subprocess.run(cmd, check=True)
        protected_bytes = out.read_bytes()
    report = {
        "schema_version": "1.0",
        "modality": "video",
        "verdict": "protected",
        "model_version": "clip-pgd+dwtdctsvd-video",
        "method": "per-frame CLIP PGD + DwtDctSvd + H.264",
        "metrics": {
            "frames": count,
            "fps": round(fps, 2),
            "psnr_db": round(float(np.mean(psnrs)) if psnrs else 0, 2),
            "ssim": round(float(np.mean(ssims)) if ssims else 0, 4),
            "watermark_match_rate": round(sum(wm_matches) / len(wm_matches), 3) if wm_matches else 0,
            "strength": strength,
            "truncated": count < total,
            "source_frames": total,
        },
        "certificate": last_cert,
        "warnings": [
            "逐帧扰动是实验性视频防御，不保证阻止所有换脸/重绘/压缩攻击",
            "视频重编码（H.264）会削弱扰动和水印；请下载后检查实际效果",
            f"最多处理 {MAX_FRAMES} 帧；更长的视频会被截断",
        ],
        "explanations": ["每一帧做 CLIP PGD 扰动并嵌入 DwtDctSvd 水印，再重建 MP4。"],
        "artifacts": {},
    }
    # Compare before/after with the visual detector. This is deliberately
    # best-effort: the protected video must still be watchable.
    try:
        import videodetect

        before_report, _, _ = videodetect.detect(data)
        after_report, _, _ = videodetect.detect(protected_bytes)
        report["before"] = {
            "verdict": before_report.get("verdict"),
            "score": before_report.get("score"),
            "segments": before_report.get("segments", []),
        }
        report["after"] = {
            "verdict": after_report.get("verdict"),
            "score": after_report.get("score"),
            "segments": after_report.get("segments", []),
        }
    except Exception as exc:  # noqa: BLE001
        report["detection_error"] = str(exc)[:300]
    payload = {
        "schema_version": "1.0",
        "certificate_id": f"vdef_{secrets.token_hex(8)}",
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "file_sha256": hashlib.sha256(protected_bytes).hexdigest(),
        "metrics": report["metrics"],
        "method": report["method"],
        "notice": "保护只能降低被利用的概率，不保证阻止所有攻击。",
    }
    signature = hmac.new(TOKEN.encode("utf-8"), json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8"), hashlib.sha256).hexdigest()
    certificate = {**payload, "signature": signature, "signature_algorithm": "HMAC-SHA256"}
    report["certificate"] = certificate
    return protected_bytes, report, certificate
