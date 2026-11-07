"""Minimal P2 service: Qwen3-TTS voice clone + job API.

Run on the shared A800 server with CUDA_VISIBLE_DEVICES=1:

    GATEWAY_TOKEN=... CUDA_VISIBLE_DEVICES=1 \
      /ssd/ai_security/deepfake-platform/envs/tts/bin/python \
      -m uvicorn app:app --host 127.0.0.1 --port 18000

The API intentionally mirrors the contract in docs/02-api-contracts.md for the
audio.clone path. Image/video/detection endpoints are added in later phases.
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import sqlite3
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

import detector as audio_detector

BASE = Path(os.environ.get("DF_BASE", "/ssd/ai_security/deepfake-platform"))
DATA = BASE / "data"
UPLOADS = DATA / "uploads"
ARTIFACTS = DATA / "artifacts"
TMP = DATA / "tmp"
DB_PATH = DATA / "gateway.db"
MODEL_DIR = Path(
    os.environ.get(
        "DF_MODEL_DIR",
        str(BASE / "models" / "Qwen3-TTS-12Hz-1.7B-Base"),
    )
)
TOKEN = os.environ.get("GATEWAY_TOKEN", "")
MODEL_ID = "qwen3-tts-1.7b-base"
MAX_AUDIO_MB = 50
MAX_IMAGE_MB = 20
MAX_VIDEO_MB = 100
MAX_REF_SECONDS = 30
MIN_REF_SECONDS = 3
MAX_TARGET_CHARS = 2000
MAX_DETECT_SECONDS = 120
LANGUAGES = [
    "Chinese",
    "English",
    "Japanese",
    "Korean",
    "German",
    "French",
    "Russian",
    "Portuguese",
    "Spanish",
    "Italian",
]

for d in (DATA, UPLOADS, ARTIFACTS, TMP):
    d.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Deepfake Studio P2", version="0.1.0")
DB_LOCK = threading.Lock()
QUEUE: "queue.Queue[str]" = queue.Queue()
MODEL = None
MODEL_LOCK = threading.Lock()
STOP = threading.Event()


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail:
        error = detail
    else:
        error = {"code": "BAD_REQUEST", "message": str(detail), "retryable": False}
    return JSONResponse(status_code=exc.status_code, content={"error": error})


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={"error": {"code": "BAD_REQUEST", "message": "请求字段不合法", "retryable": False, "details": jsonable_encoder(exc.errors())}},
    )


def now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with DB_LOCK, db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS assets (
              id TEXT PRIMARY KEY,
              sha256 TEXT UNIQUE NOT NULL,
              kind TEXT NOT NULL,
              mime TEXT,
              size INTEGER,
              path TEXT NOT NULL,
              duration_s REAL,
              width INTEGER,
              height INTEGER,
              source TEXT DEFAULT 'upload',
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS artifacts (
              id TEXT PRIMARY KEY,
              job_id TEXT NOT NULL,
              role TEXT NOT NULL,
              kind TEXT NOT NULL,
              mime TEXT,
              size INTEGER,
              sha256 TEXT,
              path TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              task TEXT NOT NULL,
              status TEXT NOT NULL,
              model_id TEXT,
              route_reason TEXT,
              progress REAL DEFAULT 0,
              stage TEXT,
              inputs TEXT,
              text TEXT,
              options TEXT,
              outputs TEXT,
              report TEXT,
              warning TEXT,
              error TEXT,
              cancel_requested INTEGER DEFAULT 0,
              created_at TEXT NOT NULL,
              started_at TEXT,
              finished_at TEXT
            );
            CREATE TABLE IF NOT EXISTS idempotency (
              key TEXT PRIMARY KEY,
              job_id TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            """
        )
        # Lightweight migration for databases created before warning support.
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)").fetchall()}
        if "warning" not in cols:
            conn.execute("ALTER TABLE jobs ADD COLUMN warning TEXT")
        # Jobs interrupted by a restart cannot be safely resumed.
        conn.execute(
            "UPDATE jobs SET status='failed', stage='failed', finished_at=?, "
            "error=? WHERE status IN ('running','prepared')",
            (now(), json.dumps({"code": "REMOTE_LOST", "message": "service restarted", "hint": "重新提交任务", "retryable": True})),
        )


def require_token(authorization: Optional[str]) -> None:
    if not TOKEN:
        raise HTTPException(500, detail={"code": "SERVER_MISCONFIGURED", "message": "GATEWAY_TOKEN is not set"})
    if authorization != f"Bearer {TOKEN}":
        raise HTTPException(401, detail={"code": "UNAUTHORIZED", "message": "invalid or missing bearer token", "hint": "检查本地配置中的 Token", "retryable": False})


def row_to_job(row: sqlite3.Row) -> Dict[str, Any]:
    outputs = json.loads(row["outputs"]) if row["outputs"] else []
    error = json.loads(row["error"]) if row["error"] else None
    return {
        "id": row["id"],
        "task": row["task"],
        "status": row["status"],
        "model_id": row["model_id"],
        "route_reason": row["route_reason"],
        "progress": row["progress"] or 0.0,
        "stage": row["stage"],
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "inputs": json.loads(row["inputs"]) if row["inputs"] else {},
        "text": json.loads(row["text"]) if row["text"] else {},
        "options": json.loads(row["options"]) if row["options"] else {},
        "outputs": outputs,
        "report": json.loads(row["report"]) if row["report"] else None,
        "warning": json.loads(row["warning"]) if row["warning"] else None,
        "error": error,
    }


def public_asset(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "sha256": row["sha256"],
        "kind": row["kind"],
        "mime": row["mime"],
        "size_bytes": row["size"],
        "duration_s": row["duration_s"],
        "width": row["width"],
        "height": row["height"],
        "source": row["source"],
        "created_at": row["created_at"],
    }


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    with DB_LOCK, db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
    return row_to_job(row) if row else None


def update_job(job_id: str, **fields: Any) -> None:
    if not fields:
        return
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = list(fields.values()) + [job_id]
    with DB_LOCK, db() as conn:
        conn.execute(f"UPDATE jobs SET {sets} WHERE id=?", vals)


def fail_job(job_id: str, code: str, message: str, hint: str, retryable: bool = False) -> None:
    update_job(
        job_id,
        status="failed",
        stage="failed",
        finished_at=now(),
        error=json.dumps({"code": code, "message": message, "hint": hint, "retryable": retryable}, ensure_ascii=False),
    )


def get_asset(asset_id: str) -> Optional[sqlite3.Row]:
    with DB_LOCK, db() as conn:
        return conn.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()


def get_artifact(artifact_id: str) -> Optional[sqlite3.Row]:
    with DB_LOCK, db() as conn:
        return conn.execute("SELECT * FROM artifacts WHERE id=?", (artifact_id,)).fetchone()


def guess_kind(mime: str, suffix: str, path: Path) -> str:
    if mime and mime.startswith("audio/"):
        return "audio"
    if mime and mime.startswith("image/"):
        return "image"
    if mime and mime.startswith("video/"):
        return "video"
    if suffix.lower() in {".wav", ".mp3", ".flac", ".m4a", ".ogg"}:
        return "audio"
    if suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}:
        return "image"
    if suffix.lower() in {".mp4", ".mov", ".mkv", ".webm"}:
        return "video"
    try:
        with sf.SoundFile(str(path)) as f:
            _ = f.frames
        return "audio"
    except Exception:
        return "unknown"


def probe_audio(path: Path) -> Optional[float]:
    try:
        with sf.SoundFile(str(path)) as f:
            if f.samplerate:
                return round(f.frames / float(f.samplerate), 3)
    except Exception:
        return None
    return None


def load_model():
    global MODEL
    with MODEL_LOCK:
        if MODEL is None:
            if not MODEL_DIR.exists():
                raise FileNotFoundError(f"model directory not found: {MODEL_DIR}")
            from qwen_tts import Qwen3TTSModel

            MODEL = Qwen3TTSModel.from_pretrained(
                str(MODEL_DIR),
                device_map="cuda:0",
                dtype=torch.bfloat16,
            )
        return MODEL


def create_artifact(job_id: str, path: Path, role: str, kind: str, mime: str) -> Dict[str, Any]:
    data = path.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    artifact_id = new_id("art")
    with DB_LOCK, db() as conn:
        conn.execute(
            "INSERT INTO artifacts(id, job_id, role, kind, mime, size, sha256, path, created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (artifact_id, job_id, role, kind, mime, len(data), sha, str(path), now()),
        )
    return {
        "artifact_id": artifact_id,
        "role": role,
        "kind": kind,
        "mime": mime,
        "size_bytes": len(data),
        "sha256": sha,
        "url": f"/v1/files/{artifact_id}",
    }


def process_detect_job(job: Dict[str, Any]) -> None:
    job_id = job["id"]
    row = get_asset(job["inputs"].get("file", ""))
    if not row:
        fail_job(job_id, "INVALID_MEDIA", "检测音频不存在", "重新上传音频", False)
        return
    if row["kind"] != "audio":
        fail_job(job_id, "UNSUPPORTED_MIME", "检测文件必须是音频", "换一个音频文件", False)
        return
    update_job(job_id, status="running", stage="loading_detector", progress=0.05, started_at=now())
    try:
        audio, duration = audio_detector.load_audio(Path(row["path"]))
        truncated = duration > MAX_DETECT_SECONDS
        if truncated:
            audio = audio[:MAX_DETECT_SECONDS * audio_detector.SR]
            duration = MAX_DETECT_SECONDS
        if len(audio) == 0:
            raise ValueError("empty audio")
        update_job(job_id, stage="analyzing", progress=0.25)
        model_id = job["model_id"]
        scores, starts = audio_detector.score_windows(model_id, audio)
        if not scores:
            raise ValueError("no analysis windows")
        scores_arr = np.asarray(scores, dtype=np.float32)
        aggregate = float(0.7 * np.percentile(scores_arr, 90) + 0.3 * np.mean(scores_arr))
        threshold = 0.5
        verdict = "fake" if aggregate >= 0.6 else "real" if aggregate <= 0.4 else "uncertain"
        confidence = "high" if abs(aggregate - 0.5) >= 0.25 else "medium" if abs(aggregate - 0.5) >= 0.1 else "low"

        segments: List[Dict[str, Any]] = []
        current: Optional[Dict[str, Any]] = None
        for score, start in zip(scores, starts):
            end = min(duration, round(start + audio_detector.WINDOW / audio_detector.SR, 3))
            if score >= threshold:
                if current is not None and start <= current["end_s"] + 0.05:
                    current["end_s"] = end
                    current["scores"].append(float(score))
                    current["score"] = float(np.mean(current["scores"]))
                else:
                    if current is not None:
                        current.pop("scores", None)
                        segments.append(current)
                    current = {"start_s": start, "end_s": end, "score": float(score), "scores": [float(score)]}
            elif current is not None:
                current.pop("scores", None)
                segments.append(current)
                current = None
        if current is not None:
            current.pop("scores", None)
            segments.append(current)
        for segment in segments:
            segment["score"] = round(float(segment["score"]), 4)
            segment["verdict"] = "fake" if segment["score"] >= threshold else "uncertain"

        explained = int(np.sum(scores_arr >= threshold))
        report = {
            "schema_version": "1.0",
            "job_id": job_id,
            "modality": "audio",
            "verdict": verdict,
            "score": round(aggregate, 4),
            "threshold": threshold,
            "confidence": confidence,
            "models": [
                {
                    "model_id": model_id,
                    "score": round(aggregate, 4),
                    "weight": 1.0,
                    "calibrated": False,
                    "windows": len(scores),
                }
            ],
            "regions": [],
            "frames": [],
            "segments": segments,
            "artifacts": {},
            "explanations": [
                f"{explained}/{len(scores)} 个 4 秒窗口的 fake 分数 ≥ {threshold}",
                "分数越高表示越像合成/克隆语音；聚合分数 = 0.7×P90 + 0.3×均值",
            ],
            "warnings": [
                "检测分数不是司法鉴定结论；压缩、降噪、重录都会影响结果",
                "模型在公开反欺骗数据上训练，对训练集外的生成器可能漏检或误报",
                "参考音频应为 16kHz 以上；低码率、强噪声会降低可信度",
            ],
            "processing": {
                "duration_s": duration,
                "sample_rate": audio_detector.SR,
                "window_s": audio_detector.WINDOW / audio_detector.SR,
                "hop_s": audio_detector.HOP / audio_detector.SR,
                "windows": len(scores),
                "truncated": truncated,
            },
            "model_version": audio_detector.DETECTORS[model_id]["version"],
            "created_at": now(),
        }
        out_dir = ARTIFACTS / job_id
        out_dir.mkdir(parents=True, exist_ok=True)
        report_path = out_dir / "report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        artifact = create_artifact(job_id, report_path, "report", "report", "application/json")
        if (get_job(job_id) or {}).get("status") == "canceled":
            return
        update_job(
            job_id,
            status="succeeded",
            stage="succeeded",
            progress=1.0,
            finished_at=now(),
            report=json.dumps(report, ensure_ascii=False),
            outputs=json.dumps([artifact], ensure_ascii=False),
        )
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        fail_job(job_id, "GPU_OOM", "显存不足", "换短一点的音频后重试", True)
    except Exception as exc:  # noqa: BLE001
        if type(exc).__name__ in {"LibsndfileError", "NoBackendError"}:
            fail_job(job_id, "INVALID_MEDIA", "无法解码检测音频", "请转成 WAV 后上传", False)
        else:
            fail_job(job_id, "INTERNAL", f"检测失败: {type(exc).__name__}", str(exc)[:500], False)


def process_detect_image_job(job: Dict[str, Any]) -> None:
    job_id = job["id"]
    row = get_asset(job["inputs"].get("file", ""))
    if not row:
        fail_job(job_id, "INVALID_MEDIA", "检测图片不存在", "重新上传图片", False)
        return
    if row["kind"] != "image":
        fail_job(job_id, "UNSUPPORTED_MIME", "detect.image 只接受图片", "上传 JPG/PNG/WEBP", False)
        return
    try:
        import imagedetect
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "MODEL_UNAVAILABLE", "图片检测模型依赖不可用", str(exc)[:300], False)
        return
    update_job(job_id, status="running", stage="loading_detector", progress=0.1, started_at=now())
    try:
        update_job(job_id, stage="analyzing", progress=0.4)
        report, overlay = imagedetect.detect(Path(row["path"]).read_bytes())
        if (get_job(job_id) or {}).get("status") == "canceled":
            return
        out_dir = ARTIFACTS / job_id
        out_dir.mkdir(parents=True, exist_ok=True)
        overlay_path = out_dir / "overlay.png"
        overlay_path.write_bytes(overlay)
        overlay_artifact = create_artifact(job_id, overlay_path, "overlay", "image", "image/png")
        report["job_id"] = job_id
        report["created_at"] = now()
        report.setdefault("artifacts", {})["overlay"] = overlay_artifact["url"]
        report_path = out_dir / "report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        report_artifact = create_artifact(job_id, report_path, "report", "report", "application/json")
        update_job(
            job_id,
            status="succeeded",
            stage="succeeded",
            progress=1.0,
            finished_at=now(),
            report=json.dumps(report, ensure_ascii=False),
            outputs=json.dumps([overlay_artifact, report_artifact], ensure_ascii=False),
        )
    except imagedetect.NoFaceError as exc:
        fail_job(job_id, "NO_FACE", str(exc), "换一张正脸清晰的照片", False)
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        fail_job(job_id, "GPU_OOM", "检测显存不足", "缩小图片后重试", True)
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "INTERNAL", f"图片检测失败: {type(exc).__name__}", str(exc)[:500], False)


def process_detect_video_job(job: Dict[str, Any]) -> None:
    job_id = job["id"]
    row = get_asset(job["inputs"].get("file", ""))
    if not row:
        fail_job(job_id, "INVALID_MEDIA", "检测视频不存在", "重新上传视频", False)
        return
    if row["kind"] != "video":
        fail_job(job_id, "UNSUPPORTED_MIME", "detect.video 只接受视频", "上传 MP4/MOV/WEBM", False)
        return
    model_id = job["model_id"]
    try:
        if model_id == "avff-stage3":
            import videodetect_avff as video_detector
        else:
            import videodetect as video_detector
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "MODEL_UNAVAILABLE", "视频检测模型依赖不可用", str(exc)[:300], False)
        return
    update_job(job_id, status="running", stage="loading_detector", progress=0.1, started_at=now())
    try:
        update_job(job_id, stage="analyzing", progress=0.4)
        suffix = Path(row["path"]).suffix or ".mp4"
        report, _, contact = video_detector.detect(Path(row["path"]).read_bytes(), suffix)
        if (get_job(job_id) or {}).get("status") == "canceled":
            return
        out_dir = ARTIFACTS / job_id
        out_dir.mkdir(parents=True, exist_ok=True)
        outputs = []
        if contact:
            contact_path = out_dir / "contact_sheet.png"
            contact_path.write_bytes(contact)
            contact_artifact = create_artifact(job_id, contact_path, "contact", "image", "image/png")
            report.setdefault("artifacts", {})["contact"] = contact_artifact["url"]
            outputs.append(contact_artifact)
        report["job_id"] = job_id
        report["created_at"] = now()
        report_path = out_dir / "report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        report_artifact = create_artifact(job_id, report_path, "report", "report", "application/json")
        outputs.append(report_artifact)
        update_job(
            job_id,
            status="succeeded",
            stage="succeeded",
            progress=1.0,
            finished_at=now(),
            report=json.dumps(report, ensure_ascii=False),
            outputs=json.dumps(outputs, ensure_ascii=False),
        )
    except ValueError as exc:
        fail_job(job_id, "INVALID_MEDIA", str(exc), "确认视频中有人脸且可解码", False)
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        fail_job(job_id, "GPU_OOM", "视频检测显存不足", "缩短视频后重试", True)
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "INTERNAL", f"视频检测失败: {type(exc).__name__}", str(exc)[:500], False)


def process_video_faceswap_job(job: Dict[str, Any]) -> None:
    job_id = job["id"]
    video_row = get_asset(job["inputs"].get("video", ""))
    source_row = get_asset(job["inputs"].get("source_image", ""))
    if not video_row or not source_row:
        fail_job(job_id, "INVALID_MEDIA", "换脸视频或源脸不存在", "重新上传", False)
        return
    if video_row["kind"] != "video" or source_row["kind"] != "image":
        fail_job(job_id, "UNSUPPORTED_MIME", "视频换脸需要视频 + 图片", "上传 MP4 和 JPG/PNG", False)
        return
    try:
        import faceswap
        import videofaceswap
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "MODEL_UNAVAILABLE", "视频换脸依赖不可用", str(exc)[:300], False)
        return
    update_job(job_id, status="running", stage="swapping", progress=0.05, started_at=now())
    try:
        options = job.get("options") or {}
        if isinstance(options, str):
            options = json.loads(options)
        model_id = (options or {}).get("model", job["model_id"])
        update_job(job_id, stage="swapping", progress=0.15)
        result, report = videofaceswap.swap_video(
            Path(video_row["path"]).read_bytes(),
            Path(source_row["path"]).read_bytes(),
            model_id=model_id,
        )
        if (get_job(job_id) or {}).get("status") == "canceled":
            return
        out_dir = ARTIFACTS / job_id
        out_dir.mkdir(parents=True, exist_ok=True)
        output_path = out_dir / "swapped.mp4"
        output_path.write_bytes(result)
        video_artifact = create_artifact(job_id, output_path, "primary", "video", "video/mp4")
        report["artifacts"] = {"video": video_artifact["url"]}
        report["job_id"] = job_id
        report["created_at"] = now()
        report_path = out_dir / "report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        report_artifact = create_artifact(job_id, report_path, "report", "report", "application/json")
        update_job(
            job_id,
            status="succeeded",
            stage="succeeded",
            progress=1.0,
            finished_at=now(),
            report=json.dumps(report, ensure_ascii=False),
            outputs=json.dumps([video_artifact, report_artifact], ensure_ascii=False),
        )
    except faceswap.NoFaceError as exc:
        fail_job(job_id, "NO_FACE", "没有检测到人脸", str(exc), False)
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        fail_job(job_id, "GPU_OOM", "视频换脸显存不足", "缩短视频后重试", True)
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "INTERNAL", f"视频换脸失败: {type(exc).__name__}", str(exc)[:500], False)


def process_defend_video_job(job: Dict[str, Any]) -> None:
    job_id = job["id"]
    row = get_asset(job["inputs"].get("file", ""))
    if not row:
        fail_job(job_id, "INVALID_MEDIA", "保护视频不存在", "重新上传视频", False)
        return
    if row["kind"] != "video":
        fail_job(job_id, "UNSUPPORTED_MIME", "defend.video 只接受视频", "上传 MP4/MOV/WEBM", False)
        return
    try:
        import defend_video
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "MODEL_UNAVAILABLE", "视频防御依赖不可用", str(exc)[:300], False)
        return
    strength = job.get("options") or {}
    update_job(job_id, status="running", stage="protecting", progress=0.05, started_at=now())
    try:
        options = json.loads(strength) if isinstance(strength, str) else strength
        level = (options or {}).get("strength", "low")
        update_job(job_id, stage="protecting", progress=0.15)
        protected, report, certificate = defend_video.protect_video(Path(row["path"]).read_bytes(), level)
        if (get_job(job_id) or {}).get("status") == "canceled":
            return
        out_dir = ARTIFACTS / job_id
        out_dir.mkdir(parents=True, exist_ok=True)
        video_path = out_dir / "protected.mp4"
        video_path.write_bytes(protected)
        cert_path = out_dir / "certificate.json"
        cert_path.write_text(json.dumps(certificate, ensure_ascii=False, indent=2), encoding="utf-8")
        video_artifact = create_artifact(job_id, video_path, "primary", "video", "video/mp4")
        cert_artifact = create_artifact(job_id, cert_path, "certificate", "certificate", "application/json")
        report["artifacts"] = {"protected": video_artifact["url"], "certificate": cert_artifact["url"]}
        report["job_id"] = job_id
        report["created_at"] = now()
        report_path = out_dir / "report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        report_artifact = create_artifact(job_id, report_path, "report", "report", "application/json")
        update_job(
            job_id,
            status="succeeded",
            stage="succeeded",
            progress=1.0,
            finished_at=now(),
            report=json.dumps(report, ensure_ascii=False),
            outputs=json.dumps([video_artifact, cert_artifact, report_artifact], ensure_ascii=False),
        )
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        fail_job(job_id, "GPU_OOM", "视频防御显存不足", "截短视频后重试", True)
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "INTERNAL", f"视频防御失败: {type(exc).__name__}", str(exc)[:500], False)


def process_defense_job(job: Dict[str, Any]) -> None:
    job_id = job["id"]
    row = get_asset(job["inputs"].get("file", ""))
    if not row:
        fail_job(job_id, "INVALID_MEDIA", "保护图片不存在", "重新上传图片", False)
        return
    if row["kind"] != "image":
        fail_job(job_id, "UNSUPPORTED_MIME", "defend.image 只接受图片", "上传 JPG/PNG/WEBP", False)
        return
    try:
        import defense
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "MODEL_UNAVAILABLE", "防御模型依赖不可用", str(exc)[:300], False)
        return
    strength = job["options"].get("strength") or "medium"
    if strength not in {"low", "medium", "high"}:
        fail_job(job_id, "BAD_REQUEST", f"未知强度: {strength}", "选择 low / medium / high", False)
        return
    update_job(job_id, status="running", stage="protecting", progress=0.1, started_at=now())
    try:
        protected, certificate, metrics = defense.protect(Path(row["path"]).read_bytes(), strength)
        if (get_job(job_id) or {}).get("status") == "canceled":
            return
        out_dir = ARTIFACTS / job_id
        out_dir.mkdir(parents=True, exist_ok=True)
        protected_path = out_dir / "protected.png"
        protected_path.write_bytes(protected)
        cert_path = out_dir / "certificate.json"
        cert_path.write_text(json.dumps(certificate, ensure_ascii=False, indent=2), encoding="utf-8")
        image_artifact = create_artifact(job_id, protected_path, "primary", "image", "image/png")
        cert_artifact = create_artifact(job_id, cert_path, "certificate", "certificate", "application/json")
        report = {
            "schema_version": "1.0",
            "modality": "image",
            "verdict": "protected",
            "score": metrics["psnr_db"],
            "threshold": None,
            "confidence": "high" if metrics["watermark_match"] else "low",
            "model_version": "clip-pgd+dwtdctsvd",
            "models": [{"model_id": "clip-pgd+dwtdctsvd", "score": metrics["psnr_db"], "weight": 1.0, "calibrated": False}],
            "explanations": [
                f"PSNR {metrics['psnr_db']}dB，SSIM {metrics['ssim']}",
                f"水印 {'解码成功' if metrics['watermark_match'] else '解码失败'}",
            ],
            "warnings": ["保护只能降低被利用的概率，不保证阻止所有换脸/重绘/压缩攻击。"],
            "metrics": metrics,
            "certificate": certificate,
            "artifacts": {"protected": image_artifact["url"], "certificate": cert_artifact["url"]},
            "created_at": now(),
        }
        update_job(
            job_id,
            status="succeeded",
            stage="succeeded",
            progress=1.0,
            finished_at=now(),
            report=json.dumps(report, ensure_ascii=False),
            outputs=json.dumps([image_artifact, cert_artifact], ensure_ascii=False),
        )
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        fail_job(job_id, "GPU_OOM", "防御优化显存不足", "缩小图片后重试", True)
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "INTERNAL", f"保护失败: {type(exc).__name__}", str(exc)[:500], False)


def process_faceswap_job(job: Dict[str, Any]) -> None:
    job_id = job["id"]
    source_row = get_asset(job["inputs"].get("source_image", ""))
    target_row = get_asset(job["inputs"].get("target_image", ""))
    if not source_row or not target_row:
        fail_job(job_id, "INVALID_MEDIA", "源图或目标图不存在", "重新上传两张图片", False)
        return
    if source_row["kind"] != "image" or target_row["kind"] != "image":
        fail_job(job_id, "UNSUPPORTED_MIME", "换脸只接受图片", "上传 JPG/PNG/WEBP", False)
        return
    try:
        import faceswap as face_swapper
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "MODEL_UNAVAILABLE", "换脸模型依赖不可用", str(exc)[:300], False)
        return
    update_job(job_id, status="running", stage="loading_model", progress=0.05, started_at=now())
    try:
        update_job(job_id, stage="swapping", progress=0.35)
        model_id = job["options"].get("model") or job["model_id"]
        output, info = face_swapper.swap(
            Path(source_row["path"]).read_bytes(),
            Path(target_row["path"]).read_bytes(),
            model_id,
        )
        if (get_job(job_id) or {}).get("status") == "canceled":
            return
        update_job(job_id, stage="postprocessing", progress=0.9)
        out_dir = ARTIFACTS / job_id
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / "face_swap.png"
        out_path.write_bytes(output)
        artifact = create_artifact(job_id, out_path, "primary", "image", "image/png")
        warning = None
        if info["source_faces"] > 1 or info["target_faces"] > 1:
            warning = {
                "code": "MULTIPLE_FACES",
                "message": f"源图 {info['source_faces']} 张脸，目标图 {info['target_faces']} 张脸",
                "hint": "默认选择面积最大的脸；多人脸精细选择后续加入",
            }
        update_job(
            job_id,
            status="succeeded",
            stage="succeeded",
            progress=1.0,
            finished_at=now(),
            outputs=json.dumps([artifact], ensure_ascii=False),
            warning=json.dumps(warning, ensure_ascii=False) if warning else None,
        )
    except face_swapper.NoFaceError as exc:
        fail_job(job_id, "NO_FACE", str(exc), "换一张正脸清晰的照片", False)
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        fail_job(job_id, "GPU_OOM", "换脸显存不足", "换分辨率更小的图片", True)
    except Exception as exc:  # noqa: BLE001
        fail_job(job_id, "INTERNAL", f"换脸失败: {type(exc).__name__}", str(exc)[:500], False)


def process_job(job_id: str) -> None:
    job = get_job(job_id)
    if not job:
        return
    if job["status"] == "canceled":
        return
    if job["task"] == "detect.audio":
        process_detect_job(job)
        return
    if job["task"] == "image.face_swap":
        process_faceswap_job(job)
        return
    if job["task"] == "detect.image":
        process_detect_image_job(job)
        return
    if job["task"] == "detect.video":
        process_detect_video_job(job)
        return
    if job["task"] == "defend.video":
        process_defend_video_job(job)
        return
    if job["task"] == "video.face_swap":
        process_video_faceswap_job(job)
        return
    if job["task"] == "defend.image":
        process_defense_job(job)
        return
    row = get_asset(job["inputs"].get("reference_audio", ""))
    if not row:
        fail_job(job_id, "INVALID_MEDIA", "参考音频不存在", "重新上传参考音频", False)
        return
    text = job["text"]
    target_text = (text.get("target_text") or "").strip()
    ref_text = (text.get("reference_text") or "").strip()
    language = job["options"].get("language") or "Chinese"
    if not target_text or not ref_text:
        fail_job(job_id, "NO_CAPABILITY", "缺少 target_text 或 reference_text", "补齐文本后重试", False)
        return
    if len(target_text) > MAX_TARGET_CHARS:
        fail_job(job_id, "INPUT_TOO_LONG", "目标文本超过 2000 字符", "缩短文本后重试", False)
        return
    if language not in LANGUAGES:
        fail_job(job_id, "UNSUPPORTED_LANGUAGE", f"不支持语言: {language}", "改为支持的语言", False)
        return
    duration = row["duration_s"]
    if duration is not None and (duration < MIN_REF_SECONDS or duration > MAX_REF_SECONDS):
        fail_job(job_id, "INPUT_TOO_SHORT" if duration < MIN_REF_SECONDS else "INPUT_TOO_LONG",
                 f"参考音频时长 {duration}s，要求 {MIN_REF_SECONDS}-{MAX_REF_SECONDS}s",
                 "裁剪参考音频到 3-30 秒", False)
        return

    update_job(job_id, status="running", stage="loading_model", progress=0.05, started_at=now())
    try:
        model = load_model()
        update_job(job_id, stage="generating", progress=0.2)
        ref_audio, ref_sr = sf.read(str(row["path"]), dtype="float32", always_2d=False)
        if getattr(ref_audio, "ndim", 1) > 1:
            ref_audio = ref_audio.mean(axis=1)
        wavs, sr = model.generate_voice_clone(
            text=target_text,
            language=language,
            ref_audio=(ref_audio, ref_sr),
            ref_text=ref_text,
        )
        if (get_job(job_id) or {}).get("status") == "canceled":
            return
        update_job(job_id, stage="postprocessing", progress=0.9)
        out_dir = ARTIFACTS / job_id
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / "audio.wav"
        sf.write(str(out_path), wavs[0], sr)
        artifact = create_artifact(job_id, out_path, "primary", "audio", "audio/wav")
        update_job(job_id, status="succeeded", stage="succeeded", progress=1.0,
                   finished_at=now(), outputs=json.dumps([artifact], ensure_ascii=False))
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        fail_job(job_id, "GPU_OOM", "显存不足", "缩短音频或改用 0.6B 模型后重试", True)
    except Exception as exc:  # noqa: BLE001 - surface a stable API error
        if type(exc).__name__ in {"LibsndfileError", "NoBackendError"}:
            fail_job(job_id, "INVALID_MEDIA", "无法解码参考音频", "请转成 WAV/MP3 后重新上传", False)
        else:
            fail_job(job_id, "INTERNAL", f"生成失败: {type(exc).__name__}", str(exc)[:500], False)


def worker() -> None:
    while not STOP.is_set():
        try:
            job_id = QUEUE.get(timeout=1.0)
        except queue.Empty:
            continue
        try:
            process_job(job_id)
        except Exception:  # noqa: BLE001 - worker must survive
            fail_job(job_id, "INTERNAL", "worker crashed", "查看服务日志", False)
        finally:
            QUEUE.task_done()


class Consent(BaseModel):
    subject: str = "self"
    purpose: str = "demo"
    agreed: bool = False


class JobRequest(BaseModel):
    task: str
    model: str = "auto"
    inputs: Dict[str, str] = Field(default_factory=dict)
    text: Dict[str, str] = Field(default_factory=dict)
    options: Dict[str, Any] = Field(default_factory=dict)
    consent: Consent


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    threading.Thread(target=worker, name="tts-worker", daemon=True).start()
    # Requeue jobs that were queued before a restart.
    with DB_LOCK, db() as conn:
        rows = conn.execute("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at").fetchall()
    for row in rows:
        QUEUE.put(row["id"])


@app.get("/v1/health")
def health(authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_token(authorization)
    gpu: Dict[str, Any] = {"name": None, "vram_total_gb": None, "vram_free_gb": None}
    try:
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            free, total = torch.cuda.mem_get_info(0)
            gpu = {
                "name": props.name,
                "vram_total_gb": round(total / 1024**3, 1),
                "vram_free_gb": round(free / 1024**3, 1),
            }
    except Exception:
        pass
    with DB_LOCK, db() as conn:
        queued = conn.execute("SELECT COUNT(*) c FROM jobs WHERE status='queued'").fetchone()["c"]
        running = conn.execute("SELECT COUNT(*) c FROM jobs WHERE status='running'").fetchone()["c"]
    try:
        import faceswap

        face_models = faceswap.status()
    except Exception as exc:  # noqa: BLE001
        face_models = [{"model_id": "inswapper-128", "available": False, "loaded": False, "error": str(exc)[:200]}]
    try:
        import imagedetect

        image_status = imagedetect.status()
    except Exception as exc:  # noqa: BLE001
        image_status = {"model_id": "effnet-b4-celebdf", "status": "offline", "loaded": False, "error": str(exc)[:200]}
    try:
        import defense

        defense_status = defense.status()
    except Exception as exc:  # noqa: BLE001
        defense_status = {"model_id": "clip-pgd-dwtdctsvd", "status": "offline", "loaded": False, "error": str(exc)[:200]}
    try:
        import videodetect

        video_status = videodetect.status()
    except Exception as exc:  # noqa: BLE001
        video_status = {"model_id": "realforensics-ff", "status": "offline", "loaded": False, "error": str(exc)[:200]}
    try:
        import videodetect_avff

        avff_status = videodetect_avff.status()
    except Exception as exc:  # noqa: BLE001
        avff_status = {"model_id": "avff-stage3", "status": "offline", "loaded": False, "error": str(exc)[:200]}
    try:
        import defend_video

        video_defense_status = defend_video.status()
    except Exception as exc:  # noqa: BLE001
        video_defense_status = {"model_id": "clip-pgd-video", "status": "offline", "loaded": False, "error": str(exc)[:200]}
    try:
        import videofaceswap

        video_faceswap_status = videofaceswap.status()
    except Exception as exc:  # noqa: BLE001
        video_faceswap_status = {"model_id": "video-face-swap", "status": "offline", "loaded": False, "error": str(exc)[:200]}
    return {
        "status": "ok" if gpu["name"] else "degraded",
        "gateway_version": "0.1.0",
        "gpu": gpu,
        "queue": {"queued": queued, "running": running, "max_concurrency": 1},
        "models": [
            {
                "model_id": MODEL_ID,
                "service": "tts",
                "status": "ready" if MODEL_DIR.exists() else "offline",
                "loaded": MODEL is not None,
            },
            *[
                {
                    "model_id": item["model_id"],
                    "service": "detector",
                    "status": item["status"],
                    "loaded": item["loaded"],
                }
                for item in audio_detector.detector_status()
            ],
            *[
                {
                    "model_id": item["model_id"],
                    "service": "faceswap",
                    "status": "ready" if item.get("available") else "offline",
                    "loaded": bool(item.get("loaded")),
                }
                for item in face_models
            ],
            {
                "model_id": "effnet-b4-celebdf",
                "service": "face-detector",
                "status": image_status.get("status", "offline"),
                "loaded": bool(image_status.get("loaded")),
            },
            {
                "model_id": "clip-pgd-dwtdctsvd",
                "service": "defense",
                "status": defense_status.get("status", "offline"),
                "loaded": bool(defense_status.get("loaded")),
            },
            {
                "model_id": "realforensics-ff",
                "service": "video-detector",
                "status": video_status.get("status", "offline"),
                "loaded": bool(video_status.get("loaded")),
            },
            {
                "model_id": "avff-stage3",
                "service": "video-detector",
                "status": avff_status.get("status", "offline"),
                "loaded": bool(avff_status.get("loaded")),
            },
            {
                "model_id": "clip-pgd-video",
                "service": "video-defense",
                "status": video_defense_status.get("status", "offline"),
                "loaded": bool(video_defense_status.get("loaded")),
            },
            {
                "model_id": "video-face-swap",
                "service": "video-faceswap",
                "status": video_faceswap_status.get("status", "offline"),
                "loaded": bool(video_faceswap_status.get("loaded")),
            },
        ],
    }


@app.get("/v1/capabilities")
def capabilities(authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_token(authorization)
    cap = {
        "model_id": MODEL_ID,
        "display_name": "Qwen3-TTS 1.7B Base",
        "task": "audio.clone",
        "service": "tts",
        "required_inputs": ["reference_audio"],
        "optional_inputs": [],
        "required_text": ["reference_text", "target_text"],
        "output_kind": "audio",
        "limits": {
            "max_input_duration_s": 120,
            "min_reference_duration_s": MIN_REF_SECONDS,
            "max_reference_duration_s": MAX_REF_SECONDS,
            "max_target_chars": MAX_TARGET_CHARS,
            "max_file_mb": MAX_AUDIO_MB,
            "languages": LANGUAGES,
        },
        "resources": {"vram_gb": 10, "typical_seconds": 8, "max_concurrency": 1, "gpu_group": "tts"},
        "priority": 100,
        "quality_tier": "high",
        "status": "ready" if MODEL_DIR.exists() else "offline",
        "version": "1.7B",
        "license": "Apache-2.0",
    }
    detect_caps = []
    for item in audio_detector.detector_status():
        detect_caps.append(
            {
                "model_id": item["model_id"],
                "display_name": item["display_name"],
                "task": "detect.audio",
                "service": "detector",
                "required_inputs": ["file"],
                "optional_inputs": [],
                "required_text": [],
                "output_kind": "report",
                "limits": {
                    "max_input_duration_s": MAX_DETECT_SECONDS,
                    "max_file_mb": MAX_AUDIO_MB,
                    "formats": ["wav", "mp3", "m4a", "flac"],
                },
                "resources": {
                    "vram_gb": item["vram_gb"],
                    "typical_seconds": 4,
                    "max_concurrency": 1,
                    "gpu_group": "detector",
                },
                "priority": item["priority"],
                "quality_tier": "high" if item["priority"] >= 100 else "standard",
                "status": item["status"],
                "version": item["version"],
                "license": item["license"],
                "description": item["description"],
                "languages": item["languages"],
                "speed": item["speed"],
            }
        )
    try:
        import faceswap

        face_models = faceswap.list_models()
    except Exception:  # noqa: BLE001
        face_models = []
    face_caps = []
    for item in face_models:
        face_caps.append(
            {
                "model_id": item["model_id"],
                "display_name": item["display_name"],
                "task": "image.face_swap",
                "service": "faceswap",
                "required_inputs": ["source_image", "target_image"],
                "optional_inputs": [],
                "required_text": [],
                "output_kind": "image",
                "limits": {"max_file_mb": MAX_IMAGE_MB, "formats": ["jpg", "jpeg", "png", "webp"]},
                "resources": {"vram_gb": 2, "typical_seconds": 2, "max_concurrency": 1, "gpu_group": "faceswap"},
                "priority": item["priority"],
                "quality_tier": "high" if item["model_id"] == "hyperswap-256" else "standard",
                "status": "ready" if item.get("available") else "offline",
                "version": item["model_id"],
                "license": item["license"],
                "description": item["quality"],
                "vendor": item["vendor"],
                "year": item["year"],
                "resolution": item["resolution"],
                "speed": item["speed"],
                "legacy": item["legacy"],
            }
        )
    image_cap = {
        "model_id": "effnet-b4-celebdf",
        "display_name": "EffNet-B4 · Celeb-DF + Grad-CAM",
        "task": "detect.image",
        "service": "face-detector",
        "required_inputs": ["file"],
        "optional_inputs": [],
        "required_text": [],
        "output_kind": "report",
        "limits": {"max_file_mb": MAX_IMAGE_MB, "formats": ["jpg", "jpeg", "png", "webp"]},
        "resources": {"vram_gb": 2, "typical_seconds": 2, "max_concurrency": 1, "gpu_group": "face-detector"},
        "priority": 100,
        "quality_tier": "high",
        "status": "ready" if (BASE / "models" / "face-detector" / "best_model.pt").exists() else "offline",
        "version": "effnet-b4-celebdf",
        "license": "MIT",
        "description": "Celeb-DF v2 训练的换脸检测器；返回整脸框、top-2 区域与热图。",
    }
    defense_cap = {
        "model_id": "clip-pgd-dwtdctsvd",
        "display_name": "CLIP PGD + DwtDctSvd",
        "task": "defend.image",
        "service": "defense",
        "required_inputs": ["file"],
        "optional_inputs": [],
        "required_text": [],
        "output_kind": "image",
        "limits": {"max_file_mb": MAX_IMAGE_MB, "formats": ["jpg", "jpeg", "png", "webp"], "strengths": ["low", "medium", "high"]},
        "resources": {"vram_gb": 2, "typical_seconds": 8, "max_concurrency": 1, "gpu_group": "defense"},
        "priority": 100,
        "quality_tier": "standard",
        "status": "ready" if (BASE / "models" / "clip-vit-base-patch32").exists() else "offline",
        "version": "1.0",
        "license": "CLIP MIT；DwtDctSvd 水印",
        "description": "CLIP PGD 扰动 + 水印，保护本人图片并生成可验证证书。",
    }
    video_cap = {
        "model_id": "realforensics-ff",
        "display_name": "RealForensics CSN-r101",
        "task": "detect.video",
        "service": "video-detector",
        "required_inputs": ["file"],
        "optional_inputs": [],
        "required_text": [],
        "output_kind": "report",
        "limits": {"max_file_mb": MAX_VIDEO_MB, "formats": ["mp4", "mov", "webm"], "frames": 25},
        "resources": {"vram_gb": 8, "typical_seconds": 5, "max_concurrency": 1, "gpu_group": "video-detector"},
        "priority": 100,
        "quality_tier": "high",
        "status": "ready" if (BASE / "models" / "realforensics" / "realforensics_ff.pth").exists() else "offline",
        "version": "realforensics_ff",
        "license": "MIT",
        "description": "CVPR 2022 RealForensics FF++ 预训练；25 帧人脸片段，视频级 fake 概率。",
        "year": 2022,
    }
    avff_cap = {
        "model_id": "avff-stage3",
        "display_name": "AVFF (OpenAVFF Stage-3)",
        "task": "detect.video",
        "service": "video-detector",
        "required_inputs": ["file"],
        "optional_inputs": [],
        "required_text": [],
        "output_kind": "report",
        "limits": {"max_file_mb": MAX_VIDEO_MB, "formats": ["mp4", "mov", "webm"], "frames": 16},
        "resources": {"vram_gb": 8, "typical_seconds": 5, "max_concurrency": 1, "gpu_group": "video-detector"},
        "priority": 80,
        "quality_tier": "standard",
        "status": "ready" if (BASE / "models" / "avff" / "stage-3.pth").exists() else "offline",
        "version": "stage-3",
        "license": "未明确（非官方实现，仅研究验证）",
        "description": "CVPR 2024 AVFF 非官方实现；视频+音频联合，适合正脸说话/lip-sync。",
        "year": 2024,
    }
    video_defense_cap = {
        "model_id": "clip-pgd-video",
        "display_name": "视频防御（逐帧 CLIP PGD + 水印）",
        "task": "defend.video",
        "service": "video-defense",
        "required_inputs": ["file"],
        "optional_inputs": [],
        "required_text": [],
        "output_kind": "video",
        "limits": {"max_file_mb": MAX_VIDEO_MB, "formats": ["mp4", "mov", "webm"], "max_frames": 250},
        "resources": {"vram_gb": 8, "typical_seconds": 60, "max_concurrency": 1, "gpu_group": "video-defense"},
        "priority": 50,
        "quality_tier": "experimental",
        "status": "ready",
        "version": "video-v1",
        "license": "CLIP MIT；DwtDctSvd",
        "description": "逐帧扰动 + 水印后重建 MP4；实验性，用于验证视频防御可行性。",
        "year": 2022,
    }
    video_face_cap = {
        "model_id": "video-face-swap",
        "display_name": "视频换脸（HyperSwap / inswapper）",
        "task": "video.face_swap",
        "service": "video-faceswap",
        "required_inputs": ["video", "source_image"],
        "optional_inputs": [],
        "required_text": [],
        "output_kind": "video",
        "limits": {"max_file_mb": MAX_VIDEO_MB, "formats": ["mp4", "mov", "webm"], "max_frames": 300},
        "resources": {"vram_gb": 8, "typical_seconds": 60, "max_concurrency": 1, "gpu_group": "video-faceswap"},
        "priority": 90,
        "quality_tier": "experimental",
        "status": "ready",
        "version": "video-v1",
        "license": "HyperSwap ResearchRAIL / inswapper 非商业研究",
        "description": "逐帧 HyperSwap 256 或 inswapper 128，保留音轨；最多 300 帧。",
        "year": 2025,
    }
    return {"gateway_version": "0.1.0", "generated_at": now(), "capabilities": [cap, *detect_caps, *face_caps, image_cap, defense_cap, video_cap, avff_cap, video_defense_cap, video_face_cap]}


@app.post("/v1/assets", status_code=201)
async def upload_asset(
    file: UploadFile = File(...),
    kind: Optional[str] = Form(default=None),
    client_name: Optional[str] = Form(default=None),
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_token(authorization)
    suffix = Path(file.filename or "upload.bin").suffix.lower()
    tmp_path = TMP / f"{uuid.uuid4().hex}{suffix}"
    sha = hashlib.sha256()
    size = 0
    try:
        with tmp_path.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_AUDIO_MB * 1024 * 1024 and (file.content_type or "").startswith("audio/"):
                    raise HTTPException(413, detail={"code": "PAYLOAD_TOO_LARGE", "message": "音频超过 50MB"})
                if size > MAX_IMAGE_MB * 1024 * 1024 and (file.content_type or "").startswith("image/"):
                    raise HTTPException(413, detail={"code": "PAYLOAD_TOO_LARGE", "message": "图片超过 20MB"})
                if size > MAX_VIDEO_MB * 1024 * 1024 and (file.content_type or "").startswith("video/"):
                    raise HTTPException(413, detail={"code": "PAYLOAD_TOO_LARGE", "message": "视频超过 100MB"})
                sha.update(chunk)
                out.write(chunk)
        mime = file.content_type or "application/octet-stream"
        detected = guess_kind(mime, suffix, tmp_path)
        if kind and kind not in {"image", "audio", "video"}:
            raise HTTPException(422, detail={"code": "UNSUPPORTED_MIME", "message": f"未知 kind: {kind}"})
        if detected == "unknown" and not kind:
            raise HTTPException(415, detail={"code": "UNSUPPORTED_MIME", "message": "无法识别文件类型"})
        kind = kind or detected
        digest = sha.hexdigest()
        ext = suffix or ".bin"
        dest = UPLOADS / f"{digest}{ext}"
        if not dest.exists():
            tmp_path.replace(dest)
        else:
            tmp_path.unlink(missing_ok=True)
        with DB_LOCK, db() as conn:
            existing = conn.execute("SELECT * FROM assets WHERE sha256=?", (digest,)).fetchone()
            if existing:
                return {"asset": public_asset(existing), "deduplicated": True}
            asset_id = new_id("ast")
            conn.execute(
                "INSERT INTO assets(id, sha256, kind, mime, size, path, duration_s, created_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (asset_id, digest, kind, mime, size, str(dest), probe_audio(dest) if kind == "audio" else None, now()),
            )
            row = conn.execute("SELECT * FROM assets WHERE id=?", (asset_id,)).fetchone()
        return {"asset": public_asset(row), "deduplicated": False}
    finally:
        tmp_path.unlink(missing_ok=True)


@app.get("/v1/assets/{asset_id}")
def read_asset(asset_id: str, authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_token(authorization)
    row = get_asset(asset_id)
    if not row:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "asset not found"})
    return {"asset": public_asset(row)}


@app.post("/v1/jobs", status_code=202)
def submit_job(
    req: JobRequest,
    idempotency_key: Optional[str] = Header(default=None, alias="Idempotency-Key"),
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    require_token(authorization)
    if not req.consent.agreed:
        raise HTTPException(422, detail={"code": "CONSENT_REQUIRED", "message": "需要确认素材授权", "hint": "勾选同意后再提交"})
    if req.task not in {"audio.clone", "detect.audio", "detect.image", "detect.video", "image.face_swap", "video.face_swap", "defend.image", "defend.video"}:
        raise HTTPException(422, detail={"code": "NO_CAPABILITY", "message": f"不支持的 task: {req.task}", "retryable": False})
    if idempotency_key:
        with DB_LOCK, db() as conn:
            existing = conn.execute("SELECT job_id FROM idempotency WHERE key=?", (idempotency_key,)).fetchone()
        if existing:
            job = get_job(existing["job_id"])
            if job:
                return {"job": job}

    if req.task == "detect.audio":
        file_id = req.inputs.get("file")
        file_row = get_asset(file_id) if file_id else None
        if not file_row:
            raise HTTPException(422, detail={"code": "NO_CAPABILITY", "message": "缺少检测音频", "hint": "上传 file", "retryable": False})
        if file_row["kind"] != "audio":
            raise HTTPException(422, detail={"code": "UNSUPPORTED_MIME", "message": "file 必须是音频"})
        available = audio_detector.list_model_ids()
        if not available:
            raise HTTPException(503, detail={"code": "MODEL_UNAVAILABLE", "message": "没有可用的音频检测模型", "retryable": True})
        model_id = req.model if req.model and req.model != "auto" else audio_detector.auto_model_id()
        if model_id not in available:
            raise HTTPException(422, detail={"code": "UNSUPPORTED_MODEL", "message": f"检测模型不可用: {model_id}", "hint": f"可用: {', '.join(available)}", "retryable": False})
        duration = file_row["duration_s"]
        if duration is not None and duration > MAX_DETECT_SECONDS:
            raise HTTPException(422, detail={"code": "INPUT_TOO_LONG", "message": f"音频 {duration}s，最多检测 {MAX_DETECT_SECONDS}s", "hint": "截短后再试"})
        job_id = new_id("job")
        info = audio_detector.DETECTORS[model_id]
        route_reason = f"detect.audio 输入 file 齐全；选择 {info['display_name']}（priority {info['priority']}）"
        with DB_LOCK, db() as conn:
            conn.execute(
                "INSERT INTO jobs(id, task, status, model_id, route_reason, progress, stage, inputs, text, options, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, "detect.audio", "queued", model_id, route_reason, 0.0, "queued",
                 json.dumps({"file": file_row["id"]}, ensure_ascii=False), json.dumps({}, ensure_ascii=False),
                 json.dumps(req.options, ensure_ascii=False), now()),
            )
            if idempotency_key:
                conn.execute("INSERT OR REPLACE INTO idempotency(key, job_id, created_at) VALUES(?,?,?)",
                             (idempotency_key, job_id, now()))
        QUEUE.put(job_id)
        return {"job": get_job(job_id)}

    if req.task == "detect.image":
        file_id = req.inputs.get("file")
        file_row = get_asset(file_id) if file_id else None
        if not file_row:
            raise HTTPException(422, detail={"code": "NO_CAPABILITY", "message": "缺少检测图片", "hint": "上传 file", "retryable": False})
        if file_row["kind"] != "image":
            raise HTTPException(422, detail={"code": "UNSUPPORTED_MIME", "message": "file 必须是图片"})
        if not (BASE / "models" / "face-detector" / "best_model.pt").exists():
            raise HTTPException(503, detail={"code": "MODEL_UNAVAILABLE", "message": "图片检测模型未安装", "retryable": True})
        job_id = new_id("job")
        route_reason = "detect.image 输入 file 齐全；使用 EffNet-B4 Celeb-DF + Grad-CAM"
        with DB_LOCK, db() as conn:
            conn.execute(
                "INSERT INTO jobs(id, task, status, model_id, route_reason, progress, stage, inputs, text, options, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, "detect.image", "queued", "effnet-b4-celebdf", route_reason, 0.0, "queued",
                 json.dumps({"file": file_row["id"]}, ensure_ascii=False), json.dumps({}, ensure_ascii=False),
                 json.dumps(req.options, ensure_ascii=False), now()),
            )
            if idempotency_key:
                conn.execute("INSERT OR REPLACE INTO idempotency(key, job_id, created_at) VALUES(?,?,?)",
                             (idempotency_key, job_id, now()))
        QUEUE.put(job_id)
        return {"job": get_job(job_id)}

    if req.task == "defend.image":
        file_id = req.inputs.get("file")
        file_row = get_asset(file_id) if file_id else None
        if not file_row:
            raise HTTPException(422, detail={"code": "NO_CAPABILITY", "message": "缺少保护图片", "hint": "上传 file", "retryable": False})
        if file_row["kind"] != "image":
            raise HTTPException(422, detail={"code": "UNSUPPORTED_MIME", "message": "file 必须是图片"})
        strength = str(req.options.get("strength") or "medium")
        if strength not in {"low", "medium", "high"}:
            raise HTTPException(422, detail={"code": "BAD_REQUEST", "message": f"未知强度: {strength}", "hint": "low / medium / high"})
        if not (BASE / "models" / "clip-vit-base-patch32").exists():
            raise HTTPException(503, detail={"code": "MODEL_UNAVAILABLE", "message": "防御模型未安装", "retryable": True})
        job_id = new_id("job")
        route_reason = f"defend.image 输入 file 齐全；CLIP PGD + DwtDctSvd，强度 {strength}"
        with DB_LOCK, db() as conn:
            conn.execute(
                "INSERT INTO jobs(id, task, status, model_id, route_reason, progress, stage, inputs, text, options, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, "defend.image", "queued", "clip-pgd+dwtdctsvd", route_reason, 0.0, "queued",
                 json.dumps({"file": file_row["id"]}, ensure_ascii=False), json.dumps({}, ensure_ascii=False),
                 json.dumps({"strength": strength}, ensure_ascii=False), now()),
            )
            if idempotency_key:
                conn.execute("INSERT OR REPLACE INTO idempotency(key, job_id, created_at) VALUES(?,?,?)",
                             (idempotency_key, job_id, now()))
        QUEUE.put(job_id)
        return {"job": get_job(job_id)}

    if req.task == "defend.video":
        file_id = req.inputs.get("file")
        file_row = get_asset(file_id) if file_id else None
        if not file_row:
            raise HTTPException(422, detail={"code": "NO_CAPABILITY", "message": "缺少保护视频", "hint": "上传 file", "retryable": False})
        if file_row["kind"] != "video":
            raise HTTPException(422, detail={"code": "UNSUPPORTED_MIME", "message": "file 必须是视频"})
        strength = str(req.options.get("strength") or "low")
        if strength not in {"low", "medium"}:
            raise HTTPException(422, detail={"code": "BAD_REQUEST", "message": "视频防御支持 low / medium", "retryable": False})
        if not (BASE / "models" / "clip-vit-base-patch32").exists():
            raise HTTPException(503, detail={"code": "MODEL_UNAVAILABLE", "message": "防御模型未安装", "retryable": True})
        job_id = new_id("job")
        route_reason = f"defend.video 输入 file 齐全；逐帧 CLIP PGD + DwtDctSvd，强度 {strength}"
        with DB_LOCK, db() as conn:
            conn.execute(
                "INSERT INTO jobs(id, task, status, model_id, route_reason, progress, stage, inputs, text, options, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, "defend.video", "queued", "clip-pgd-video", route_reason, 0.0, "queued",
                 json.dumps({"file": file_row["id"]}, ensure_ascii=False), json.dumps({}, ensure_ascii=False),
                 json.dumps({"strength": strength}, ensure_ascii=False), now()),
            )
            if idempotency_key:
                conn.execute("INSERT OR REPLACE INTO idempotency(key, job_id, created_at) VALUES(?,?,?)",
                             (idempotency_key, job_id, now()))
        QUEUE.put(job_id)
        return {"job": get_job(job_id)}

    if req.task == "detect.video":
        file_id = req.inputs.get("file")
        file_row = get_asset(file_id) if file_id else None
        if not file_row:
            raise HTTPException(422, detail={"code": "NO_CAPABILITY", "message": "缺少检测视频", "hint": "上传 file", "retryable": False})
        if file_row["kind"] != "video":
            raise HTTPException(422, detail={"code": "UNSUPPORTED_MIME", "message": "file 必须是视频"})
        video_models = {
            "realforensics-ff": BASE / "models" / "realforensics" / "realforensics_ff.pth",
            "avff-stage3": BASE / "models" / "avff" / "stage-3.pth",
        }
        model_id = req.model if req.model and req.model != "auto" else "realforensics-ff"
        if model_id not in video_models or not video_models[model_id].exists():
            raise HTTPException(422, detail={"code": "UNSUPPORTED_MODEL", "message": f"视频检测模型不可用: {model_id}", "hint": "realforensics-ff / avff-stage3", "retryable": False})
        job_id = new_id("job")
        route_reason = f"detect.video 输入 file 齐全；选择 {model_id}"
        with DB_LOCK, db() as conn:
            conn.execute(
                "INSERT INTO jobs(id, task, status, model_id, route_reason, progress, stage, inputs, text, options, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, "detect.video", "queued", model_id, route_reason, 0.0, "queued",
                 json.dumps({"file": file_row["id"]}, ensure_ascii=False), json.dumps({}, ensure_ascii=False),
                 json.dumps(req.options, ensure_ascii=False), now()),
            )
            if idempotency_key:
                conn.execute("INSERT OR REPLACE INTO idempotency(key, job_id, created_at) VALUES(?,?,?)",
                             (idempotency_key, job_id, now()))
        QUEUE.put(job_id)
        return {"job": get_job(job_id)}

    if req.task == "image.face_swap":
        source_id = req.inputs.get("source_image")
        target_id = req.inputs.get("target_image")
        source_row = get_asset(source_id) if source_id else None
        target_row = get_asset(target_id) if target_id else None
        if not source_row or not target_row:
            raise HTTPException(422, detail={"code": "NO_CAPABILITY", "message": "缺少源图或目标图", "hint": "上传 source_image 和 target_image", "retryable": False})
        if source_row["kind"] != "image" or target_row["kind"] != "image":
            raise HTTPException(422, detail={"code": "UNSUPPORTED_MIME", "message": "source_image 和 target_image 必须是图片"})
        try:
            import faceswap

            available = [item["model_id"] for item in faceswap.list_models() if item.get("available")]
            model_id = req.model if req.model and req.model != "auto" else faceswap.auto_model_id()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, detail={"code": "MODEL_UNAVAILABLE", "message": "换脸模型未安装", "hint": str(exc)[:200], "retryable": True})
        if model_id not in available:
            raise HTTPException(422, detail={"code": "UNSUPPORTED_MODEL", "message": f"换脸模型不可用: {model_id}", "hint": f"可用: {', '.join(available)}", "retryable": False})
        info = faceswap.SWAPPERS[model_id]
        job_id = new_id("job")
        route_reason = f"image.face_swap 输入 source_image + target_image 齐全；选择 {info['display_name']}（{info['year']}，{info['resolution']}px）"
        with DB_LOCK, db() as conn:
            conn.execute(
                "INSERT INTO jobs(id, task, status, model_id, route_reason, progress, stage, inputs, text, options, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, "image.face_swap", "queued", model_id, route_reason, 0.0, "queued",
                 json.dumps({"source_image": source_row["id"], "target_image": target_row["id"]}, ensure_ascii=False),
                 json.dumps({}, ensure_ascii=False), json.dumps({**req.options, "model": model_id}, ensure_ascii=False), now()),
            )
            if idempotency_key:
                conn.execute("INSERT OR REPLACE INTO idempotency(key, job_id, created_at) VALUES(?,?,?)",
                             (idempotency_key, job_id, now()))
        QUEUE.put(job_id)
        return {"job": get_job(job_id)}

    if req.task == "video.face_swap":
        source_id = req.inputs.get("source_image")
        video_id = req.inputs.get("video")
        source_row = get_asset(source_id) if source_id else None
        video_row = get_asset(video_id) if video_id else None
        if not source_row or not video_row:
            raise HTTPException(422, detail={"code": "NO_CAPABILITY", "message": "缺少源脸或视频", "hint": "上传 source_image 和 video", "retryable": False})
        if source_row["kind"] != "image" or video_row["kind"] != "video":
            raise HTTPException(422, detail={"code": "UNSUPPORTED_MIME", "message": "source_image 必须是图片，video 必须是视频"})
        try:
            import faceswap

            available = [item["model_id"] for item in faceswap.list_models() if item.get("available")]
            model_id = req.model if req.model and req.model != "auto" else "hyperswap-256"
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(503, detail={"code": "MODEL_UNAVAILABLE", "message": "换脸模型未安装", "hint": str(exc)[:200], "retryable": True})
        if model_id not in available:
            raise HTTPException(422, detail={"code": "UNSUPPORTED_MODEL", "message": f"换脸模型不可用: {model_id}", "hint": f"可用: {', '.join(available)}", "retryable": False})
        job_id = new_id("job")
        route_reason = f"video.face_swap 输入 video + source_image 齐全；逐帧 {model_id}"
        with DB_LOCK, db() as conn:
            conn.execute(
                "INSERT INTO jobs(id, task, status, model_id, route_reason, progress, stage, inputs, text, options, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, "video.face_swap", "queued", model_id, route_reason, 0.0, "queued",
                 json.dumps({"source_image": source_row["id"], "video": video_row["id"]}, ensure_ascii=False),
                 json.dumps({}, ensure_ascii=False), json.dumps({"model": model_id}, ensure_ascii=False), now()),
            )
            if idempotency_key:
                conn.execute("INSERT OR REPLACE INTO idempotency(key, job_id, created_at) VALUES(?,?,?)",
                             (idempotency_key, job_id, now()))
        QUEUE.put(job_id)
        return {"job": get_job(job_id)}

    ref = req.inputs.get("reference_audio")
    ref_row = get_asset(ref) if ref else None
    if not ref_row:
        raise HTTPException(422, detail={"code": "NO_CAPABILITY", "message": "缺少参考音频", "hint": "上传 reference_audio", "retryable": False})
    if ref_row["kind"] != "audio":
        raise HTTPException(422, detail={"code": "UNSUPPORTED_MIME", "message": "reference_audio 必须是音频"})
    target = (req.text.get("target_text") or "").strip()
    ref_text = (req.text.get("reference_text") or "").strip()
    missing = [k for k, v in (("reference_text", ref_text), ("target_text", target)) if not v]
    if missing:
        raise HTTPException(422, detail={"code": "NO_CAPABILITY", "message": "缺少必要文本", "hint": f"missing: {', '.join(missing)}", "missing_roles": missing, "retryable": False})
    duration = ref_row["duration_s"]
    if duration is not None and duration < MIN_REF_SECONDS:
        raise HTTPException(422, detail={"code": "INPUT_TOO_SHORT", "message": f"参考音频只有 {duration}s，至少 3s"})
    if duration is not None and duration > MAX_REF_SECONDS:
        raise HTTPException(422, detail={"code": "INPUT_TOO_LONG", "message": f"参考音频 {duration}s，最多 30s"})
    if len(target) > MAX_TARGET_CHARS:
        raise HTTPException(422, detail={"code": "INPUT_TOO_LONG", "message": "目标文本超过 2000 字符"})
    language = req.options.get("language") or "Chinese"
    if language not in LANGUAGES:
        raise HTTPException(422, detail={"code": "UNSUPPORTED_LANGUAGE", "message": f"不支持语言: {language}"})

    job_id = new_id("job")
    route_reason = "audio.clone 需要 reference_audio + reference_text + target_text；qwen3-tts-1.7b-base 优先级 100 且可用"
    with DB_LOCK, db() as conn:
        conn.execute(
            "INSERT INTO jobs(id, task, status, model_id, route_reason, progress, stage, inputs, text, options, created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (job_id, "audio.clone", "queued", MODEL_ID, route_reason, 0.0, "queued",
             json.dumps(req.inputs, ensure_ascii=False), json.dumps(req.text, ensure_ascii=False),
             json.dumps(req.options, ensure_ascii=False), now()),
        )
        if idempotency_key:
            conn.execute("INSERT OR REPLACE INTO idempotency(key, job_id, created_at) VALUES(?,?,?)",
                         (idempotency_key, job_id, now()))
    QUEUE.put(job_id)
    return {"job": get_job(job_id)}


@app.get("/v1/jobs/{job_id}")
def read_job(job_id: str, authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_token(authorization)
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "job not found"})
    return {"job": job}


@app.get("/v1/jobs")
def list_jobs(limit: int = 20, authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_token(authorization)
    limit = max(1, min(limit, 100))
    with DB_LOCK, db() as conn:
        rows = conn.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    return {"items": [row_to_job(r) for r in rows], "next_cursor": None}


@app.post("/v1/jobs/{job_id}/cancel", status_code=202)
def cancel_job(job_id: str, authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    require_token(authorization)
    job = get_job(job_id)
    if not job:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "job not found"})
    if job["status"] in {"succeeded", "failed", "canceled"}:
        raise HTTPException(409, detail={"code": "JOB_NOT_CANCELABLE", "message": "任务已结束"})
    update_job(job_id, status="canceled", stage="canceled", finished_at=now(), progress=0.0)
    return {"job": get_job(job_id)}


@app.get("/v1/jobs/{job_id}/events")
def job_events(job_id: str, authorization: Optional[str] = Header(default=None)) -> StreamingResponse:
    require_token(authorization)
    if not get_job(job_id):
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "job not found"})

    def gen():
        last = None
        event_id = 0
        last_heartbeat = time.monotonic()
        while True:
            job = get_job(job_id)
            if not job:
                break
            snapshot = (job["status"], job["progress"], job["stage"])
            if snapshot != last:
                last = snapshot
                event_id += 1
                event = "job.succeeded" if job["status"] == "succeeded" else "job.failed" if job["status"] == "failed" else "job.updated"
                yield f"event: {event}\nid: {event_id}\ndata: {json.dumps(job, ensure_ascii=False)}\n\n"
            if job["status"] in {"succeeded", "failed", "canceled"}:
                break
            time.sleep(0.5)
            if time.monotonic() - last_heartbeat >= 15:
                last_heartbeat = time.monotonic()
                yield f"event: heartbeat\ndata: {json.dumps({'ts': now()})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/v1/files/{artifact_id}")
def download_file(artifact_id: str, authorization: Optional[str] = Header(default=None)):
    require_token(authorization)
    row = get_artifact(artifact_id)
    if not row:
        raise HTTPException(404, detail={"code": "NOT_FOUND", "message": "artifact not found"})
    path = Path(row["path"])
    if not path.exists():
        raise HTTPException(410, detail={"code": "ARTIFACT_EXPIRED", "message": "artifact file missing"})
    return FileResponse(path, media_type=row["mime"] or "application/octet-stream", filename=path.name)


@app.on_event("shutdown")
def on_shutdown() -> None:
    STOP.set()
