export type ApiError = {
  code: string
  message: string
  hint?: string
  retryable?: boolean
}

export type Health = {
  ok: boolean
  baseUrl: string
  remote?: {
    status: string
    gpu: { name: string; vram_total_gb?: number; vram_free_gb?: number }
    models: Array<{ model_id: string; status: string; loaded: boolean }>
  }
  model?: { model_id: string; status: string; loaded: boolean }
  error?: ApiError
}

export type Config = {
  languages: string[]
  maxUploadMb: number
  maxTargetChars: number
  model: { id: string; name: string }
}

export type DetectionRegion = {
  bbox?: number[]
  score: number
  label?: string
  frame_index?: number | null
  time_s?: number | null
}

export type DetectionSegment = {
  start_s: number
  end_s: number
  score: number
  verdict: string
}

export type DetectionFace = {
  bbox: number[]
  score: number
  verdict: string
  det_score?: number
  zones: Array<{
    zone: string
    energy: number
    bbox: number[]
  }>
}

export type DetectionReport = {
  schema_version: string
  job_id: string
  modality: string
  verdict: 'real' | 'fake' | 'uncertain' | string
  score: number
  threshold: number
  confidence: 'low' | 'medium' | 'high' | string
  models: Array<{
    model_id: string
    score: number
    weight: number
    calibrated?: boolean
    windows?: number
  }>
  regions: DetectionRegion[]
  faces?: DetectionFace[]
  frames: unknown[]
  segments: DetectionSegment[]
  artifacts: Record<string, string>
  explanations: string[]
  warnings: string[]
  processing: {
    duration_s?: number | null
    sample_rate?: number | null
    window_s?: number | null
    hop_s?: number | null
    windows?: number | null
    truncated?: boolean
    width?: number | null
    height?: number | null
    faces?: number | null
  }
  model_version: string
  created_at: string
}

export type DetectionModel = {
  modelId: string
  displayName: string
  description?: string
  languages?: string
  speed?: string
  license?: string
  priority?: number
  status?: string
  vramGb?: number | null
}

export type FaceSwapModel = {
  modelId: string
  displayName: string
  description?: string
  vendor?: string
  year?: number
  resolution?: number
  speed?: string
  license?: string
  priority?: number
  status?: string
  legacy?: boolean
}

export type VideoDetectionModel = {
  modelId: string
  displayName: string
  description?: string
  year?: number
  license?: string
  status?: string
  priority?: number
  typicalSeconds?: number | null
}

export type Job = {
  id: string
  task?: string
  status: 'queued' | 'prepared' | 'running' | 'postprocessing' | 'succeeded' | 'failed' | 'canceled' | string
  stage: string
  progress: number
  modelId: string
  routeReason: string
  createdAt: string
  updatedAt: string
  referenceText: string
  targetText: string
  language: string
  durationS: number | null
  sizeBytes: number | null
  resultUrl: string | null
  overlayUrl?: string | null
  certUrl?: string | null
  resultMime?: string | null
  sourceImageName?: string | null
  targetImageName?: string | null
  report?: any
  error: ApiError | null
  warning: ApiError | null
}

export type JobList = { items: Job[] }
