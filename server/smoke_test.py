"""One-off Qwen3-TTS voice clone smoke test (GPU 1)."""

from __future__ import annotations

import os
import time
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

BASE = Path(os.environ.get("DF_BASE", "/ssd/ai_security/deepfake-platform"))
MODEL_DIR = Path(os.environ.get("DF_MODEL_DIR", str(BASE / "models" / "Qwen3-TTS-12Hz-1.7B-Base")))
REF = BASE / "cache" / "clone.wav"
OUT = BASE / "artifacts" / "smoke_voice_clone.wav"
REF_TEXT = (
    "Okay. Yeah. I resent you. I love you. I respect you. "
    "But you know what? You blew it! And thanks to you."
)

print("cuda:", torch.cuda.is_available(), torch.cuda.get_device_name(0), flush=True)
t0 = time.time()
model = Qwen3TTSModel.from_pretrained(
    str(MODEL_DIR),
    device_map="cuda:0",
    dtype=torch.bfloat16,
)
torch.cuda.synchronize()
print(
    "load_s:",
    round(time.time() - t0, 1),
    "vram_gb:",
    round(torch.cuda.memory_allocated() / 1024**3, 2),
    flush=True,
)

audio, sr = sf.read(str(REF), dtype="float32", always_2d=False)
print("ref_audio:", sr, "Hz", round(len(audio) / sr, 2), "s", flush=True)

t0 = time.time()
wavs, out_sr = model.generate_voice_clone(
    text="This is a voice clone smoke test for the local deepfake platform.",
    language="English",
    ref_audio=(audio, sr),
    ref_text=REF_TEXT,
)
torch.cuda.synchronize()
elapsed = time.time() - t0
print(
    "generate_s:",
    round(elapsed, 1),
    "out_sr:",
    out_sr,
    "out_s:",
    round(len(wavs[0]) / out_sr, 2),
    "vram_peak_gb:",
    round(torch.cuda.max_memory_allocated() / 1024**3, 2),
    flush=True,
)

OUT.parent.mkdir(parents=True, exist_ok=True)
sf.write(str(OUT), wavs[0], out_sr)
print("wrote:", OUT, OUT.stat().st_size, "bytes", flush=True)
