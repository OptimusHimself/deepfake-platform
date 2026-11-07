"""Video face swap using the existing FaceFusion/InsightFace swappers.

This is a frame-by-frame video pipeline around the same models used by the
image face-swap endpoint: HyperSwap 256 (FaceFusion) and inswapper_128.
It preserves the original audio and caps processing to keep a demo responsive.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Tuple

import cv2
import numpy as np

import faceswap

BASE = Path(os.environ.get("DF_BASE", "/ssd/ai_security/deepfake-platform"))
MAX_FRAMES = 300


def status() -> Dict[str, Any]:
    return {
        "model_id": "video-face-swap",
        "display_name": "视频换脸（HyperSwap / inswapper）",
        "status": "ready",
        "loaded": bool(faceswap._state.get("app")),
        "models": faceswap.list_models(),
        "max_frames": MAX_FRAMES,
    }


def _ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def swap_video(
    video_bytes: bytes,
    source_bytes: bytes,
    model_id: str = "hyperswap-256",
    max_frames: int = MAX_FRAMES,
) -> Tuple[bytes, Dict[str, Any]]:
    """Process a video frame-by-frame and rebuild it with audio."""
    import decord

    if model_id == "auto":
        model_id = "hyperswap-256"
    if model_id not in faceswap.SWAPPERS:
        raise KeyError(f"unsupported swapper: {model_id}")
    with tempfile.TemporaryDirectory(prefix="df-video-swap-") as tmp:
        root = Path(tmp)
        src = root / "input.mp4"
        src.write_bytes(video_bytes)
        reader = decord.VideoReader(str(src), ctx=decord.cpu(0))
        fps = float(reader.get_avg_fps() or 30.0)
        total = len(reader)
        count = min(total, max_frames)
        frame_dir = root / "frames"
        frame_dir.mkdir()
        app, _ = faceswap._get_app()
        source_img = faceswap._read_image(source_bytes)
        source_faces = app.get(source_img)
        source_face = faceswap._largest_face(source_faces)
        swapper = faceswap._load_swapper(model_id)
        swapped_frames = 0
        started = time.time()
        for index in range(count):
            frame = cv2.cvtColor(reader[index].asnumpy(), cv2.COLOR_RGB2BGR)
            faces = app.get(frame)
            if faces:
                target_face = faceswap._largest_face(faces)
                if model_id == "inswapper-128":
                    with faceswap._lock:
                        frame = swapper.get(frame, target_face, source_face, paste_back=True)
                else:
                    frame = faceswap._swap_hyperswap(model_id, app, source_img, frame, source_face, target_face)
                swapped_frames += 1
            cv2.imwrite(str(frame_dir / f"{index:06d}.jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
        out = root / "swapped.mp4"
        cmd = [
            _ffmpeg(), "-y", "-loglevel", "error",
            "-framerate", f"{fps:.6f}", "-i", str(frame_dir / "%06d.jpg"),
            "-i", str(src), "-map", "0:v:0", "-map", "1:a?", "-shortest",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", str(out),
        ]
        subprocess.run(cmd, check=True)
        result = out.read_bytes()
    report = {
        "schema_version": "1.0",
        "modality": "video",
        "verdict": "swapped",
        "model_version": model_id,
        "models": [{"model_id": model_id, "role": "video-face-swap"}],
        "metrics": {
            "frames": count,
            "swapped_frames": swapped_frames,
            "fps": round(fps, 2),
            "seconds": round(time.time() - started, 2),
            "truncated": count < total,
            "source_frames": total,
        },
        "warnings": [
            "逐帧换脸可能出现时间闪烁；用于防御实验，不是影视级换脸。",
            f"最多处理 {max_frames} 帧；更长视频会被截断。",
            "HyperSwap ResearchRAIL / inswapper 非商业研究；仅使用授权素材。",
        ],
    }
    return result, report
