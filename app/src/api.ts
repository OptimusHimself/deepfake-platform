import type { ApiError, Config, DetectionModel, FaceSwapModel, Health, Job, JobList, VideoDetectionModel } from './types'

export class ApiRequestError extends Error {
  code: string
  hint?: string
  retryable?: boolean

  constructor(error: ApiError) {
    super(error.message)
    this.name = 'ApiRequestError'
    this.code = error.code
    this.hint = error.hint
    this.retryable = error.retryable
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = (data as { error?: ApiError }).error
    throw new ApiRequestError(
      error ?? {
        code: 'HTTP_ERROR',
        message: `请求失败（HTTP ${response.status}）`,
        hint: '稍后重试或查看本地服务日志',
        retryable: response.status >= 500,
      },
    )
  }
  return data as T
}

export async function getHealth(): Promise<Health> {
  const response = await fetch('/api/health', { cache: 'no-store' })
  return readJson<Health>(response)
}

export async function getConfig(): Promise<Config> {
  const response = await fetch('/api/config', { cache: 'no-store' })
  return readJson<Config>(response)
}

export async function getJobs(): Promise<JobList> {
  const response = await fetch('/api/jobs', { cache: 'no-store' })
  return readJson<JobList>(response)
}

export async function getJob(id: string): Promise<Job> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { cache: 'no-store' })
  const data = await readJson<{ job: Job }>(response)
  return data.job
}

export async function submitJob(form: FormData): Promise<Job> {
  const response = await fetch('/api/jobs', { method: 'POST', body: form })
  const data = await readJson<{ job: Job }>(response)
  return data.job
}

export async function getDetectionModels(): Promise<{ models: DetectionModel[]; error?: ApiError }> {
  const response = await fetch('/api/detect/models', { cache: 'no-store' })
  return readJson<{ models: DetectionModel[]; error?: ApiError }>(response)
}

export async function getFaceSwapModels(): Promise<{ models: FaceSwapModel[]; error?: ApiError }> {
  const response = await fetch('/api/faceswap/models', { cache: 'no-store' })
  return readJson<{ models: FaceSwapModel[]; error?: ApiError }>(response)
}

export async function getVideoModels(): Promise<{ models: VideoDetectionModel[]; error?: ApiError }> {
  const response = await fetch('/api/video/models', { cache: 'no-store' })
  return readJson<{ models: VideoDetectionModel[]; error?: ApiError }>(response)
}

export async function submitDetection(form: FormData): Promise<Job> {
  const response = await fetch('/api/detect', { method: 'POST', body: form })
  const data = await readJson<{ job: Job }>(response)
  return data.job
}

export async function submitFaceSwap(form: FormData): Promise<Job> {
  const response = await fetch('/api/faceswap', { method: 'POST', body: form })
  const data = await readJson<{ job: Job }>(response)
  return data.job
}

export async function submitImageDetection(form: FormData): Promise<Job> {
  const response = await fetch('/api/detect/image', { method: 'POST', body: form })
  const data = await readJson<{ job: Job }>(response)
  return data.job
}

export async function submitVideoDetection(form: FormData): Promise<Job> {
  const response = await fetch('/api/detect/video', { method: 'POST', body: form })
  const data = await readJson<{ job: Job }>(response)
  return data.job
}

export async function submitDefense(form: FormData): Promise<Job> {
  const response = await fetch('/api/defend', { method: 'POST', body: form })
  const data = await readJson<{ job: Job }>(response)
  return data.job
}

export async function submitVideoDefense(form: FormData): Promise<Job> {
  const response = await fetch('/api/defend/video', { method: 'POST', body: form })
  const data = await readJson<{ job: Job }>(response)
  return data.job
}

export async function submitVideoFaceSwap(form: FormData): Promise<Job> {
  const response = await fetch('/api/video-faceswap', { method: 'POST', body: form })
  const data = await readJson<{ job: Job }>(response)
  return data.job
}

export async function cancelJob(id: string): Promise<Job> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const data = await readJson<{ job: Job }>(response)
  return data.job
}

export async function saveJob(id: string): Promise<{ path: string; filename: string }> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(id)}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  return readJson<{ path: string; filename: string }>(response)
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiRequestError) {
    return { code: error.code, message: error.message, hint: error.hint, retryable: error.retryable }
  }
  if (error instanceof Error) {
    return { code: 'NETWORK_ERROR', message: error.message, hint: '检查本地服务是否在运行', retryable: true }
  }
  return { code: 'UNKNOWN', message: '发生了未知错误', retryable: true }
}
