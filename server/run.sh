#!/usr/bin/env bash
set -euo pipefail

BASE="${DF_BASE:-/ssd/ai_security/deepfake-platform}"
cd "$BASE/code"

export GATEWAY_TOKEN="$(cat "$BASE/config/gateway_token")"
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-1}"
export DF_BASE="$BASE"
export DF_MODEL_DIR="${DF_MODEL_DIR:-$BASE/models/Qwen3-TTS-12Hz-1.7B-Base}"
export HF_HOME="$BASE/cache/huggingface"
export MODELSCOPE_CACHE="$BASE/cache/modelscope"
export PYTHONUNBUFFERED=1

exec "$BASE/envs/tts/bin/python" -m uvicorn app:app \
  --host 127.0.0.1 \
  --port "${PORT:-18000}"
