import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import dotenv from 'dotenv'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { promises as fs, createReadStream } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(__dirname, '..')
dotenv.config({ path: path.join(APP_ROOT, '.env') })

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 8787)
const REMOTE_BASE = (process.env.REMOTE_BASE_URL || 'http://127.0.0.1:18000').replace(/\/+$/, '')
const TOKEN = (process.env.GATEWAY_TOKEN || '').trim()
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(APP_ROOT, 'data'))
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
const RESULT_DIR = path.join(DATA_DIR, 'results')
const STORE_PATH = path.join(DATA_DIR, 'store.json')
const DIST_DIR = path.join(APP_ROOT, 'dist')
const MAX_UPLOAD = 100 * 1024 * 1024
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'
const LANGUAGES = ['Chinese', 'English', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian']
const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.aac', '.opus'])

await fs.mkdir(UPLOAD_DIR, { recursive: true })
await fs.mkdir(RESULT_DIR, { recursive: true })

function now() {
  return new Date().toISOString()
}

function newJobId() {
  return `job_${crypto.randomBytes(8).toString('hex')}`
}

function apiError(code, message, hint, statusCode = 400, retryable = false) {
  const err = new Error(message)
  err.code = code
  err.hint = hint
  err.statusCode = statusCode
  err.retryable = retryable
  return err
}

class RemoteError extends Error {
  constructor(code, message, hint, statusCode = 502, retryable = true) {
    super(message)
    this.code = code
    this.hint = hint
    this.statusCode = statusCode
    this.retryable = retryable
  }
}

async function readStore() {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && Array.isArray(parsed.jobs) ? parsed : { jobs: [] }
  } catch {
    return { jobs: [] }
  }
}

let store = await readStore()

async function saveStore() {
  const tmp = `${STORE_PATH}.tmp`
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
  await fs.rename(tmp, STORE_PATH)
}

function findJob(id) {
  return store.jobs.find((job) => job.id === id)
}

function publicJob(job) {
  return {
    id: job.id,
    task: job.task || 'audio.clone',
    status: job.status,
    stage: job.stage,
    progress: job.progress ?? 0,
    modelId: job.modelId,
    routeReason: job.routeReason,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    referenceText: job.referenceText,
    targetText: job.targetText,
    language: job.language,
    durationS: job.durationS ?? null,
    sizeBytes: job.sizeBytes ?? null,
    resultUrl: job.localFile ? `/api/files/${job.id}` : null,
    overlayUrl: job.overlayFile ? `/api/files/${job.id}?kind=overlay` : null,
    certUrl: job.certFile ? `/api/files/${job.id}?kind=cert` : null,
    resultMime: job.resultMime ?? null,
    sourceImageName: job.sourceImageName ?? null,
    targetImageName: job.targetImageName ?? null,
    report: job.report ?? null,
    error: job.error ?? null,
    warning: job.warning ?? null,
  }
}

function jobFinished(job) {
  if (job.status === 'failed' || job.status === 'canceled') return true
  if (job.status !== 'succeeded') return false
  if (job.task === 'detect.audio' || job.task === 'detect.image' || job.task === 'detect.video') return Boolean(job.report)
  return Boolean(job.localFile)
}

async function remoteFetch(pathname, options = {}) {
  if (!TOKEN) {
    throw new RemoteError('LOCAL_MISCONFIGURED', '本地没有配置 GATEWAY_TOKEN', '在 app/.env 中填写远端 token', 500, false)
  }
  const url = `${REMOTE_BASE}${pathname}`
  let response
  try {
    response = await fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${TOKEN}`,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 30000),
    })
  } catch (err) {
    const timeout = err?.name === 'TimeoutError'
    throw new RemoteError(
      timeout ? 'REMOTE_TIMEOUT' : 'REMOTE_UNREACHABLE',
      timeout ? '远端请求超时' : '连不上远端 GPU 服务',
      '确认 SSH 隧道已启动（本地 18000 → 远端 18000），并且远端服务仍在运行',
      503,
      true,
    )
  }
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // keep raw text for the error message
  }
  if (!response.ok) {
    const err = data?.error || {}
    throw new RemoteError(
      err.code || 'REMOTE_ERROR',
      err.message || `远端返回 HTTP ${response.status}`,
      err.hint || text.slice(0, 300) || '查看远端日志',
      response.status,
      err.retryable ?? response.status >= 500,
    )
  }
  return data
}

function publicHealth(remote) {
  const model = remote?.models?.find((m) => m.model_id === 'qwen3-tts-1.7b-base') || remote?.models?.[0] || null
  return {
    ok: true,
    remote,
    model,
    baseUrl: REMOTE_BASE,
  }
}

async function transcodeToWav(buffer, filename, ext) {
  const token = crypto.randomBytes(6).toString('hex')
  const input = path.join(UPLOAD_DIR, `transcode-${token}${ext}`)
  const output = path.join(UPLOAD_DIR, `transcode-${token}-out.wav`)
  await fs.writeFile(input, buffer)
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(
        FFMPEG,
        ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', output],
        { windowsHide: true },
      )
      let stderr = ''
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
        if (stderr.length > 2000) stderr = stderr.slice(-2000)
      })
      proc.on('error', (err) => {
        if (err.code === 'ENOENT') {
          reject(apiError('INVALID_MEDIA', '本地找不到 ffmpeg，无法转换音频', '安装 ffmpeg 或设置 FFMPEG_PATH 后重启', 500))
        } else {
          reject(err)
        }
      })
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(apiError('INVALID_MEDIA', '无法解码这段音频', stderr.trim() || '请换成 WAV/MP3，或重新导出 m4a', 422))
      })
    })
    return await fs.readFile(output)
  } finally {
    await fs.unlink(input).catch(() => undefined)
    await fs.unlink(output).catch(() => undefined)
  }
}

async function uploadAsset(buffer, filename, mimetype, kind) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimetype || 'application/octet-stream' }), filename)
  if (kind) form.append('kind', kind)
  const data = await remoteFetch('/v1/assets', { method: 'POST', body: form, timeoutMs: 120000 })
  if (!data?.asset?.id) throw apiError('REMOTE_BAD_RESPONSE', '远端没有返回资产 ID', '检查远端服务版本', 502)
  return data.asset
}

async function refreshJob(job) {
  if (!job.remoteJobId) return job
  if (jobFinished(job)) return job
  const data = await remoteFetch(`/v1/jobs/${job.remoteJobId}`, { timeoutMs: 15000 })
  const remote = data?.job
  if (!remote) throw new RemoteError('REMOTE_BAD_RESPONSE', '远端任务响应格式不正确', '检查远端版本', 502, false)

  job.status = remote.status
  job.stage = remote.stage
  job.progress = remote.progress ?? 0
  job.modelId = remote.model_id || job.modelId
  job.routeReason = remote.route_reason || job.routeReason
  job.updatedAt = now()

  if (remote.status === 'failed') {
    job.error = remote.error || { code: 'REMOTE_ERROR', message: '远端任务失败', retryable: false }
    await saveStore()
    return job
  }

  if (job.task === 'defend.image' || job.task === 'defend.video' || job.task === 'video.face_swap') {
    job.report = remote.report || job.report || null
    if (remote.status === 'succeeded' && job.report && !job.localFile) {
      const outputs = remote.outputs || []
      const primary = outputs.find((o) => o.role === 'primary') || outputs[0]
      const cert = outputs.find((o) => o.role === 'certificate')
      for (const [role, output] of [['primary', primary], ['cert', cert]]) {
        if (!output?.artifact_id) continue
        const response = await fetch(`${REMOTE_BASE}/v1/files/${output.artifact_id}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
          signal: AbortSignal.timeout(60000),
        })
        if (!response.ok) continue
        const isVideo = job.task === 'defend.video' || job.task === 'video.face_swap'
        const target = path.join(RESULT_DIR, role === 'primary' ? `${job.id}-${isVideo ? 'video' : 'protected'}.${isVideo ? 'mp4' : 'png'}` : `${job.id}-certificate.json`)
        await fs.writeFile(target, Buffer.from(await response.arrayBuffer()))
        if (role === 'primary') {
          job.localFile = target
          job.resultMime = isVideo ? 'video/mp4' : 'image/png'
        } else {
          job.certFile = target
        }
      }
    }
    await saveStore()
    return job
  }

  if (job.task === 'detect.audio' || job.task === 'detect.image' || job.task === 'detect.video') {
    if (remote.status === 'succeeded') {
      job.report = remote.report || null
      job.durationS = remote.report?.processing?.duration_s ?? job.durationS
      if (!job.report) {
        job.error = { code: 'REMOTE_BAD_RESPONSE', message: '远端没有返回检测报告', retryable: true }
      } else if (job.task === 'detect.image' && job.report.artifacts?.overlay && !job.overlayFile) {
        const overlay = await fetch(`${REMOTE_BASE}${job.report.artifacts.overlay}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
          signal: AbortSignal.timeout(30000),
        })
        if (overlay.ok) {
          const overlayPath = path.join(RESULT_DIR, `${job.id}-overlay.png`)
          await fs.writeFile(overlayPath, Buffer.from(await overlay.arrayBuffer()))
          job.overlayFile = overlayPath
        }
      } else if (job.task === 'detect.video' && job.report.artifacts?.contact && !job.overlayFile) {
        const contact = await fetch(`${REMOTE_BASE}${job.report.artifacts.contact}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
          signal: AbortSignal.timeout(30000),
        })
        if (contact.ok) {
          const contactPath = path.join(RESULT_DIR, `${job.id}-contact.png`)
          await fs.writeFile(contactPath, Buffer.from(await contact.arrayBuffer()))
          job.overlayFile = contactPath
        }
      }
    }
    await saveStore()
    return job
  }

  if (remote.status === 'succeeded' && !job.localFile) {
    const output = (remote.outputs || []).find((o) => o.role === 'primary') || (remote.outputs || [])[0]
    if (!output?.artifact_id) {
      job.error = { code: 'REMOTE_BAD_RESPONSE', message: '远端没有返回产物', retryable: false }
      await saveStore()
      return job
    }
    const response = await fetch(`${REMOTE_BASE}/v1/files/${output.artifact_id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(60000),
    })
    if (!response.ok) {
      throw new RemoteError('DOWNLOAD_FAILED', `下载产物失败 HTTP ${response.status}`, '稍后重试', 502, true)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    const mime = output.mime || (job.task === 'image.face_swap' ? 'image/png' : 'audio/wav')
    const ext = mime.includes('png') ? '.png' : mime.includes('jpeg') ? '.jpg' : mime.includes('webp') ? '.webp' : '.wav'
    const dest = path.join(RESULT_DIR, `${job.id}${ext}`)
    await fs.writeFile(dest, buffer)
    job.localFile = dest
    job.resultMime = mime
    job.sizeBytes = buffer.length
    job.durationS = output.duration_s ?? job.durationS ?? null
    job.warning = remote.warning || job.warning || null
  }

  await saveStore()
  return job
}

const refreshInflight = new Map()
function ensureRefresh(job) {
  if (!job.remoteJobId) return Promise.resolve(job)
  if (jobFinished(job)) return Promise.resolve(job)
  if (refreshInflight.has(job.id)) return refreshInflight.get(job.id)
  const promise = refreshJob(job)
    .catch((err) => {
      // Keep the local job alive; the UI shows a transient warning.
      job.warning = {
        code: err.code || 'REMOTE_UNREACHABLE',
        message: err.message || '刷新远端状态失败',
        hint: err.hint || '检查 SSH 隧道',
      }
      job.updatedAt = now()
      return job
    })
    .finally(() => refreshInflight.delete(job.id))
  refreshInflight.set(job.id, promise)
  return promise
}

const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 })
await app.register(multipart, {
  limits: { fileSize: MAX_UPLOAD, files: 2, fields: 10 },
})

// Accept body-less POSTs from curl / PowerShell clients.
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, _body, done) => {
  done(null, {})
})

app.setErrorHandler((err, request, reply) => {
  const isFileTooLarge = err.code === 'FST_REQ_FILE_TOO_LARGE' || err.code === 'FST_FILES_LIMIT'
  const status = isFileTooLarge ? 413 : err.statusCode || 500
  const code = isFileTooLarge ? 'PAYLOAD_TOO_LARGE' : err.code || 'INTERNAL'
  const message = isFileTooLarge ? '上传文件超过限制' : err.message || '服务器内部错误'
  const hint = err.hint || (isFileTooLarge ? '音频 ≤50MB，图片 ≤20MB，视频 ≤100MB；裁剪/压缩后再试' : '查看本地/远端日志')
  const retryable = err.retryable ?? status >= 500
  reply.status(status).send({ error: { code, message, hint, retryable } })
})

app.get('/api/health', async () => {
  try {
    const remote = await remoteFetch('/v1/health', { timeoutMs: 5000 })
    return publicHealth(remote)
  } catch (err) {
    return {
      ok: false,
      baseUrl: REMOTE_BASE,
      error: {
        code: err.code || 'REMOTE_UNREACHABLE',
        message: err.message || '远端不可达',
        hint: err.hint || '确认 SSH 隧道已启动',
        retryable: err.retryable ?? true,
      },
    }
  }
})

app.get('/api/config', async () => ({
  languages: LANGUAGES,
  maxUploadMb: MAX_UPLOAD / 1024 / 1024,
  maxTargetChars: 2000,
  model: { id: 'qwen3-tts-1.7b-base', name: 'Qwen3-TTS 1.7B Base' },
}))

app.get('/api/detect/models', async () => {
  try {
    const data = await remoteFetch('/v1/capabilities', { timeoutMs: 5000 })
    const models = (data?.capabilities || [])
      .filter((item) => item.task === 'detect.audio')
      .map((item) => ({
        modelId: item.model_id,
        displayName: item.display_name,
        description: item.description,
        languages: item.languages,
        speed: item.speed,
        license: item.license,
        priority: item.priority,
        status: item.status,
        vramGb: item.resources?.vram_gb ?? null,
      }))
    return { models }
  } catch (err) {
    return {
      models: [],
      error: {
        code: err.code || 'REMOTE_UNREACHABLE',
        message: err.message || '无法读取检测模型',
        hint: err.hint || '确认 SSH 隧道和远端服务',
      },
    }
  }
})

app.get('/api/faceswap/models', async () => {
  try {
    const data = await remoteFetch('/v1/capabilities', { timeoutMs: 5000 })
    const models = (data?.capabilities || [])
      .filter((item) => item.task === 'image.face_swap')
      .map((item) => ({
        modelId: item.model_id,
        displayName: item.display_name,
        description: item.description,
        vendor: item.vendor,
        year: item.year,
        resolution: item.resolution,
        speed: item.speed,
        license: item.license,
        priority: item.priority,
        status: item.status,
        legacy: item.legacy === true,
      }))
    return { models }
  } catch (err) {
    return {
      models: [],
      error: {
        code: err.code || 'REMOTE_UNREACHABLE',
        message: err.message || '无法读取换脸模型',
        hint: err.hint || '确认 SSH 隧道和远端服务',
      },
    }
  }
})

app.get('/api/video/models', async () => {
  try {
    const data = await remoteFetch('/v1/capabilities', { timeoutMs: 5000 })
    const models = (data?.capabilities || [])
      .filter((item) => item.task === 'detect.video')
      .map((item) => ({
        modelId: item.model_id,
        displayName: item.display_name,
        description: item.description,
        year: item.year,
        license: item.license,
        status: item.status,
        priority: item.priority,
        typicalSeconds: item.resources?.typical_seconds ?? null,
      }))
    return { models }
  } catch (err) {
    return {
      models: [],
      error: {
        code: err.code || 'REMOTE_UNREACHABLE',
        message: err.message || '无法读取视频检测模型',
        hint: err.hint || '确认 SSH 隧道和远端服务',
      },
    }
  }
})

app.get('/api/jobs', async () => ({
  items: [...store.jobs]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 20)
    .map(publicJob),
}))

app.get('/api/jobs/:id', async (request, reply) => {
  const job = findJob(request.params.id)
  if (!job) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '任务不存在', retryable: false } })
  }
  await ensureRefresh(job)
  return { job: publicJob(job) }
})

app.post('/api/jobs', async (request, reply) => {
  const fields = {}
  let fileBuffer = null
  let filename = 'reference.wav'
  let mimetype = 'audio/wav'

  const parts = request.parts()
  for await (const part of parts) {
    if (part.type === 'file') {
      filename = part.filename || filename
      mimetype = part.mimetype || mimetype
      fileBuffer = await part.toBuffer()
    } else {
      fields[part.fieldname] = part.value
    }
  }

  if (!fileBuffer) {
    throw apiError('MISSING_AUDIO', '请上传参考音频', '选择 3–30 秒的单人清晰录音', 400)
  }
  const ext = path.extname(filename).toLowerCase()
  if (!mimetype.startsWith('audio/') && !AUDIO_EXT.has(ext)) {
    throw apiError('UNSUPPORTED_MIME', '参考文件不是音频', '支持 wav / mp3 / m4a / flac / ogg', 415)
  }
  if (fields.consent !== 'true') {
    throw apiError('CONSENT_REQUIRED', '请确认素材授权', '勾选“本人或已获授权”后再提交', 422)
  }

  const referenceText = String(fields.reference_text || '').trim()
  const targetText = String(fields.target_text || '').trim()
  const language = String(fields.language || 'Chinese')
  if (!referenceText) throw apiError('INPUT_TOO_SHORT', '请填写参考文本', '逐字转写参考音频的内容', 422)
  if (!targetText) throw apiError('INPUT_TOO_SHORT', '请填写目标文本', '输入想让克隆声音说的话', 422)
  if (referenceText.length > 2000) throw apiError('INPUT_TOO_LONG', '参考文本超过 2000 字符', '截短参考文本', 422)
  if (targetText.length > 2000) throw apiError('INPUT_TOO_LONG', '目标文本超过 2000 字符', '分成多段生成', 422)
  if (!LANGUAGES.includes(language)) throw apiError('UNSUPPORTED_LANGUAGE', '不支持该语言', '重新选择语言', 422)

  const inputExt = AUDIO_EXT.has(ext) ? ext : '.bin'
  const wavBuffer = await transcodeToWav(fileBuffer, filename, inputExt)
  fileBuffer = wavBuffer
  filename = `${path.basename(filename, ext) || 'reference'}.wav`
  mimetype = 'audio/wav'

  const localUpload = path.join(UPLOAD_DIR, `${crypto.randomBytes(8).toString('hex')}.wav`)
  await fs.writeFile(localUpload, fileBuffer)

  const form = new FormData()
  form.append('file', new Blob([fileBuffer], { type: 'audio/wav' }), filename)
  form.append('kind', 'audio')
  const assetData = await remoteFetch('/v1/assets', { method: 'POST', body: form, timeoutMs: 120000 })
  const asset = assetData?.asset
  if (!asset?.id) throw apiError('REMOTE_BAD_RESPONSE', '远端没有返回资产 ID', '检查远端服务版本', 502)

  const payload = {
    task: 'audio.clone',
    model: 'auto',
    inputs: { reference_audio: asset.id },
    text: { reference_text: referenceText, target_text: targetText },
    options: { language },
    consent: { subject: 'self', purpose: 'local demo', agreed: true },
  }
  const remoteJobData = await remoteFetch('/v1/jobs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(payload),
    timeoutMs: 60000,
  })
  const remoteJob = remoteJobData?.job
  if (!remoteJob?.id) throw apiError('REMOTE_BAD_RESPONSE', '远端没有返回任务 ID', '检查远端服务版本', 502)

  const job = {
    id: newJobId(),
    remoteJobId: remoteJob.id,
    remoteAssetId: asset.id,
    localUpload,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    modelId: remoteJob.model_id || 'qwen3-tts-1.7b-base',
    routeReason: remoteJob.route_reason || '',
    referenceText,
    targetText,
    language,
    durationS: asset.duration_s ?? null,
    createdAt: now(),
    updatedAt: now(),
    localFile: null,
    sizeBytes: null,
    error: null,
    warning: null,
  }
  store.jobs.push(job)
  await saveStore()
  return reply.status(202).send({ job: publicJob(job) })
})

app.post('/api/detect', async (request, reply) => {
  const fields = {}
  let fileBuffer = null
  let filename = 'sample.wav'
  let mimetype = 'audio/wav'
  const parts = request.parts()
  for await (const part of parts) {
    if (part.type === 'file') {
      filename = part.filename || filename
      mimetype = part.mimetype || mimetype
      fileBuffer = await part.toBuffer()
    } else {
      fields[part.fieldname] = part.value
    }
  }
  if (!fileBuffer) {
    throw apiError('MISSING_AUDIO', '请上传要检测的音频', '支持 wav / mp3 / m4a / flac', 400)
  }
  const ext = path.extname(filename).toLowerCase()
  if (!mimetype.startsWith('audio/') && !AUDIO_EXT.has(ext)) {
    throw apiError('UNSUPPORTED_MIME', '检测文件不是音频', '支持 wav / mp3 / m4a / flac', 415)
  }
  if (fields.consent !== 'true') {
    throw apiError('CONSENT_REQUIRED', '请确认有权分析该音频', '勾选授权后再提交', 422)
  }
  const requestedModel = String(fields.model || 'auto')
  const wavBuffer = await transcodeToWav(fileBuffer, filename, AUDIO_EXT.has(ext) ? ext : '.bin')
  const uploadName = `${path.basename(filename, ext) || 'sample'}.wav`
  const localUpload = path.join(UPLOAD_DIR, `${crypto.randomBytes(8).toString('hex')}.wav`)
  await fs.writeFile(localUpload, wavBuffer)

  const form = new FormData()
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), uploadName)
  form.append('kind', 'audio')
  const assetData = await remoteFetch('/v1/assets', { method: 'POST', body: form, timeoutMs: 120000 })
  const asset = assetData?.asset
  if (!asset?.id) throw apiError('REMOTE_BAD_RESPONSE', '远端没有返回资产 ID', '检查远端服务版本', 502)

  const payload = {
    task: 'detect.audio',
    model: requestedModel,
    inputs: { file: asset.id },
    text: {},
    options: {},
    consent: { subject: 'self', purpose: 'local demo detection', agreed: true },
  }
  const remoteJobData = await remoteFetch('/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(payload),
    timeoutMs: 60000,
  })
  const remoteJob = remoteJobData?.job
  if (!remoteJob?.id) throw apiError('REMOTE_BAD_RESPONSE', '远端没有返回检测任务 ID', '检查远端服务版本', 502)

  const job = {
    id: newJobId(),
    remoteJobId: remoteJob.id,
    remoteAssetId: asset.id,
    localUpload,
    task: 'detect.audio',
    status: 'queued',
    stage: 'queued',
    progress: 0,
    modelId: remoteJob.model_id || (requestedModel === 'auto' ? 'auto' : requestedModel),
    routeReason: remoteJob.route_reason || '',
    referenceText: '',
    targetText: '',
    language: 'auto',
    durationS: asset.duration_s ?? null,
    createdAt: now(),
    updatedAt: now(),
    localFile: null,
    sizeBytes: null,
    report: null,
    error: null,
    warning: null,
  }
  store.jobs.push(job)
  await saveStore()
  return reply.status(202).send({ job: publicJob(job) })
})

app.post('/api/defend', async (request, reply) => {
  let file = null
  let filename = 'image.jpg'
  let mimetype = 'image/jpeg'
  let consent = false
  let strength = 'medium'
  const parts = request.parts()
  for await (const part of parts) {
    if (part.type === 'file') {
      filename = part.filename || filename
      mimetype = part.mimetype || mimetype
      file = await part.toBuffer()
    } else if (part.fieldname === 'consent') {
      consent = part.value === 'true'
    } else if (part.fieldname === 'strength') {
      strength = part.value || strength
    }
  }
  if (!file) throw apiError('MISSING_IMAGE', '请上传要保护的图片', 'JPG / PNG / WEBP', 400)
  if (!mimetype.startsWith('image/')) throw apiError('UNSUPPORTED_MIME', '保护文件不是图片', 'JPG / PNG / WEBP', 415)
  if (file.length > 20 * 1024 * 1024) throw apiError('PAYLOAD_TOO_LARGE', '图片超过 20MB', '压缩后再试', 413)
  if (!consent) throw apiError('CONSENT_REQUIRED', '请确认这是本人/授权图片', '勾选授权后再提交', 422)
  if (!['low', 'medium', 'high'].includes(strength)) throw apiError('BAD_REQUEST', '未知保护强度', 'low / medium / high', 422)
  const asset = await uploadAsset(file, filename, mimetype, 'image')
  const payload = {
    task: 'defend.image',
    model: 'clip-pgd-dwtdctsvd',
    inputs: { file: asset.id },
    text: {},
    options: { strength },
    consent: { subject: 'self', purpose: 'local demo image protection', agreed: true },
  }
  const remoteJobData = await remoteFetch('/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(payload),
    timeoutMs: 60000,
  })
  const remoteJob = remoteJobData?.job
  if (!remoteJob?.id) throw apiError('REMOTE_BAD_RESPONSE', '远端没有返回保护任务 ID', '检查远端服务版本', 502)
  const job = {
    id: newJobId(),
    remoteJobId: remoteJob.id,
    remoteAssetId: asset.id,
    task: 'defend.image',
    status: 'queued',
    stage: 'queued',
    progress: 0,
    modelId: remoteJob.model_id || 'clip-pgd-dwtdctsvd',
    routeReason: remoteJob.route_reason || '',
    referenceText: '',
    targetText: '',
    language: '',
    durationS: null,
    sourceImageName: filename,
    createdAt: now(),
    updatedAt: now(),
    localFile: null,
    certFile: null,
    resultMime: null,
    sizeBytes: null,
    report: null,
    error: null,
    warning: null,
  }
  store.jobs.push(job)
  await saveStore()
  return reply.status(202).send({ job: publicJob(job) })
})

app.post('/api/defend/video', async (request, reply) => {
  let file = null
  let filename = 'video.mp4'
  let mimetype = 'video/mp4'
  let consent = false
  let strength = 'low'
  const parts = request.parts()
  for await (const part of parts) {
    if (part.type === 'file') {
      filename = part.filename || filename
      mimetype = part.mimetype || mimetype
      file = await part.toBuffer()
    } else if (part.fieldname === 'consent') {
      consent = part.value === 'true'
    } else if (part.fieldname === 'strength') {
      strength = part.value || strength
    }
  }
  if (!file) throw apiError('MISSING_VIDEO', '请上传要保护的视频', 'MP4 / MOV / WEBM', 400)
  if (!mimetype.startsWith('video/')) throw apiError('UNSUPPORTED_MIME', '保护文件不是视频', 'MP4 / MOV / WEBM', 415)
  if (file.length > 100 * 1024 * 1024) throw apiError('PAYLOAD_TOO_LARGE', '视频超过 100MB', '压缩/截短后再试', 413)
  if (!consent) throw apiError('CONSENT_REQUIRED', '请确认这是本人/授权视频', '勾选授权后再提交', 422)
  if (!['low', 'medium'].includes(strength)) throw apiError('BAD_REQUEST', '视频防御强度只支持 low / medium', '选择低/中', 422)
  const asset = await uploadAsset(file, filename, mimetype, 'video')
  const payload = {
    task: 'defend.video',
    model: 'clip-pgd-video',
    inputs: { file: asset.id },
    text: {},
    options: { strength },
    consent: { subject: 'self', purpose: 'local demo video protection', agreed: true },
  }
  const remoteJobData = await remoteFetch('/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(payload),
    timeoutMs: 60000,
  })
  const remoteJob = remoteJobData?.job
  if (!remoteJob?.id) throw apiError('REMOTE_BAD_RESPONSE', '远端没有返回视频防御任务 ID', '检查远端服务版本', 502)
  const job = {
    id: newJobId(),
    remoteJobId: remoteJob.id,
    remoteAssetId: asset.id,
    task: 'defend.video',
    status: 'queued',
    stage: 'queued',
    progress: 0,
    modelId: remoteJob.model_id || 'clip-pgd-video',
    routeReason: remoteJob.route_reason || '',
    referenceText: '',
    targetText: '',
    language: '',
    durationS: null,
    sourceImageName: filename,
    createdAt: now(),
    updatedAt: now(),
    localFile: null,
    certFile: null,
    resultMime: null,
    sizeBytes: null,
    report: null,
    error: null,
    warning: null,
  }
  store.jobs.push(job)
  await saveStore()
  return reply.status(202).send({ job: publicJob(job) })
})

app.post('/api/video-faceswap', async (request, reply) => {
  let sourceFile = null
  let sourceName = 'source.jpg'
  let sourceMime = 'image/jpeg'
  let videoFile = null
  let videoName = 'video.mp4'
  let videoMime = 'video/mp4'
  let consent = false
  let model = 'hyperswap-256'
  const parts = request.parts()
  for await (const part of parts) {
    if (part.type === 'file') {
      if (part.fieldname === 'source_image') {
        sourceFile = await part.toBuffer()
        sourceName = part.filename || sourceName
        sourceMime = part.mimetype || sourceMime
      } else if (part.fieldname === 'video') {
        videoFile = await part.toBuffer()
        videoName = part.filename || videoName
        videoMime = part.mimetype || videoMime
      }
    } else if (part.fieldname === 'consent') {
      consent = part.value === 'true'
    } else if (part.fieldname === 'model') {
      model = part.value || model
    }
  }
  if (!sourceFile) throw apiError('MISSING_IMAGE', '请上传源脸图片', 'JPG / PNG / WEBP', 400)
  if (!videoFile) throw apiError('MISSING_VIDEO', '请上传目标视频', 'MP4 / MOV / WEBM', 400)
  if (!sourceMime.startsWith('image/')) throw apiError('UNSUPPORTED_MIME', '源脸必须是图片', 'JPG / PNG / WEBP', 415)
  if (!videoMime.startsWith('video/')) throw apiError('UNSUPPORTED_MIME', '目标必须是视频', 'MP4 / MOV / WEBM', 415)
  if (sourceFile.length > 20 * 1024 * 1024) throw apiError('PAYLOAD_TOO_LARGE', '源脸图片超过 20MB', '压缩后重试', 413)
  if (videoFile.length > 100 * 1024 * 1024) throw apiError('PAYLOAD_TOO_LARGE', '视频超过 100MB', '截短后重试', 413)
  if (!consent) throw apiError('CONSENT_REQUIRED', '请确认素材本人/授权', '勾选授权后再提交', 422)
  const sourceAsset = await uploadAsset(sourceFile, sourceName, sourceMime, 'image')
  const videoAsset = await uploadAsset(videoFile, videoName, videoMime, 'video')
  const payload = {
    task: 'video.face_swap',
    model,
    inputs: { source_image: sourceAsset.id, video: videoAsset.id },
    text: {},
    options: { model },
    consent: { subject: 'self', purpose: 'local demo video face swap', agreed: true },
  }
  const remoteJobData = await remoteFetch('/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(payload),
    timeoutMs: 60000,
  })
  const remoteJob = remoteJobData?.job
  if (!remoteJob?.id) throw apiError('REMOTE_BAD_RESPONSE', '远端没有返回视频换脸任务 ID', '检查远端服务版本', 502)
  const job = {
    id: newJobId(),
    remoteJobId: remoteJob.id,
    remoteAssetIds: [sourceAsset.id, videoAsset.id],
    task: 'video.face_swap',
    status: 'queued',
    stage: 'queued',
    progress: 0,
    modelId: remoteJob.model_id || model,
    routeReason: remoteJob.route_reason || '',
    referenceText: '',
    targetText: '',
    language: '',
    durationS: null,
    sourceImageName: sourceName,
    targetImageName: videoName,
    createdAt: now(),
    updatedAt: now(),
    localFile: null,
    certFile: null,
    resultMime: null,
    sizeBytes: null,
    report: null,
    error: null,
    warning: null,
  }
  store.jobs.push(job)
  await saveStore()
  return reply.status(202).send({ job: publicJob(job) })
})

app.post('/api/detect/video', async (request, reply) => {
  let file = null
  let filename = 'video.mp4'
  let mimetype = 'video/mp4'
  let consent = false
  let model = 'realforensics-ff'
  const parts = request.parts()
  for await (const part of parts) {
    if (part.type === 'file') {
      filename = part.filename || filename
      mimetype = part.mimetype || mimetype
      file = await part.toBuffer()
    } else if (part.fieldname === 'consent') {
      consent = part.value === 'true'
    } else if (part.fieldname === 'model') {
      model = part.value || model
    }
  }
  if (!file) throw apiError('MISSING_VIDEO', '请上传要检测的视频', 'MP4 / MOV / WEBM', 400)
  if (!mimetype.startsWith('video/')) throw apiError('UNSUPPORTED_MIME', '检测文件不是视频', 'MP4 / MOV / WEBM', 415)
  if (file.length > 100 * 1024 * 1024) throw apiError('PAYLOAD_TOO_LARGE', '视频超过 100MB', '压缩/截短后再试', 413)
  if (!consent) throw apiError('CONSENT_REQUIRED', '请确认有权分析这段视频', '勾选授权后再提交', 422)
  const asset = await uploadAsset(file, filename, mimetype, 'video')
  const payload = {
    task: 'detect.video',
    model,
    inputs: { file: asset.id },
    text: {},
    options: {},
    consent: { subject: 'self', purpose: 'local demo video detection', agreed: true },
  }
  const remoteJobData = await remoteFetch('/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(payload),
    timeoutMs: 60000,
  })
  const remoteJob = remoteJobData?.job
  if (!remoteJob?.id) throw apiError('REMOTE_BAD_RESPONSE', '远端没有返回视频检测任务 ID', '检查远端服务版本', 502)
  const job = {
    id: newJobId(),
    remoteJobId: remoteJob.id,
    remoteAssetId: asset.id,
    task: 'detect.video',
    status: 'queued',
    stage: 'queued',
    progress: 0,
    modelId: remoteJob.model_id || 'realforensics-ff',
    routeReason: remoteJob.route_reason || '',
    referenceText: '',
    targetText: '',
    language: '',
    durationS: null,
    sourceImageName: filename,
    createdAt: now(),
    updatedAt: now(),
    localFile: null,
    resultMime: null,
    sizeBytes: null,
    report: null,
    error: null,
    warning: null,
  }
  store.jobs.push(job)
  await saveStore()
  return reply.status(202).send({ job: publicJob(job) })
})

app.post('/api/detect/image', async (request, reply) => {
  let file = null
  let filename = 'image.jpg'
  let mimetype = 'image/jpeg'
  let consent = false
  const parts = request.parts()
  for await (const part of parts) {
    if (part.type === 'file') {
      filename = part.filename || filename
      mimetype = part.mimetype || mimetype
      file = await part.toBuffer()
    } else if (part.fieldname === 'consent') {
      consent = part.value === 'true'
    }
  }
  if (!file) throw apiError('MISSING_IMAGE', '请上传要检测的图片', '支持 JPG / PNG / WEBP', 400)
  if (!mimetype.startsWith('image/')) throw apiError('UNSUPPORTED_MIME', '检测文件不是图片', '支持 JPG / PNG / WEBP', 415)
  if (file.length > 20 * 1024 * 1024) throw apiError('PAYLOAD_TOO_LARGE', '图片超过 20MB', '压缩后再试', 413)
  if (!consent) throw apiError('CONSENT_REQUIRED', '请确认有权分析这张图片', '勾选授权后再提交', 422)
  const asset = await uploadAsset(file, filename, mimetype, 'image')
  const payload = {
    task: 'detect.image',
    model: 'effnet-b4-celebdf',
    inputs: { file: asset.id },
    text: {},
    options: {},
    consent: { subject: 'self', purpose: 'local demo image detection', agreed: true },
  }
  const remoteJobData = await remoteFetch('/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(payload),
    timeoutMs: 60000,
  })
  const remoteJob = remoteJobData?.job
  if (!remoteJob?.id) throw apiError('REMOTE_BAD_RESPONSE', '远端没有返回图片检测任务 ID', '检查远端服务版本', 502)
  const job = {
    id: newJobId(),
    remoteJobId: remoteJob.id,
    remoteAssetId: asset.id,
    task: 'detect.image',
    status: 'queued',
    stage: 'queued',
    progress: 0,
    modelId: remoteJob.model_id || 'effnet-b4-celebdf',
    routeReason: remoteJob.route_reason || '',
    referenceText: '',
    targetText: '',
    language: '',
    durationS: null,
    sourceImageName: filename,
    createdAt: now(),
    updatedAt: now(),
    localFile: null,
    overlayFile: null,
    resultMime: null,
    sizeBytes: null,
    report: null,
    error: null,
    warning: null,
  }
  store.jobs.push(job)
  await saveStore()
  return reply.status(202).send({ job: publicJob(job) })
})

app.post('/api/faceswap', async (request, reply) => {
  const fields = {}
  const files = {}
  const parts = request.parts()
  for await (const part of parts) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer()
      files[part.fieldname] = { buffer, filename: part.filename || 'image.jpg', mimetype: part.mimetype || 'image/jpeg' }
    } else {
      fields[part.fieldname] = part.value
    }
  }
  if (fields.consent !== 'true') {
    throw apiError('CONSENT_REQUIRED', '请确认有权使用这两张图片', '勾选授权后再提交', 422)
  }
  const source = files.source_image
  const target = files.target_image
  if (!source || !target) {
    throw apiError('MISSING_IMAGE', '请同时上传源脸图和目标图', 'source_image + target_image', 400)
  }
  for (const [name, item] of Object.entries({ source_image: source, target_image: target })) {
    if (!item.mimetype.startsWith('image/')) {
      throw apiError('UNSUPPORTED_MIME', `${name} 不是图片`, '支持 JPG / PNG / WEBP', 415)
    }
    if (item.buffer.length > 20 * 1024 * 1024) {
      throw apiError('PAYLOAD_TOO_LARGE', `${name} 超过 20MB`, '压缩后再试', 413)
    }
  }
  const sourceAsset = await uploadAsset(source.buffer, source.filename, source.mimetype, 'image')
  const targetAsset = await uploadAsset(target.buffer, target.filename, target.mimetype, 'image')
  const payload = {
    task: 'image.face_swap',
    model: String(fields.model || 'auto'),
    inputs: { source_image: sourceAsset.id, target_image: targetAsset.id },
    text: {},
    options: {},
    consent: { subject: 'self', purpose: 'local demo face swap', agreed: true },
  }
  const remoteJobData = await remoteFetch('/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(payload),
    timeoutMs: 60000,
  })
  const remoteJob = remoteJobData?.job
  if (!remoteJob?.id) throw apiError('REMOTE_BAD_RESPONSE', '远端没有返回换脸任务 ID', '检查远端服务版本', 502)
  const job = {
    id: newJobId(),
    remoteJobId: remoteJob.id,
    remoteAssetIds: [sourceAsset.id, targetAsset.id],
    task: 'image.face_swap',
    status: 'queued',
    stage: 'queued',
    progress: 0,
    modelId: remoteJob.model_id || 'inswapper-128',
    routeReason: remoteJob.route_reason || '',
    referenceText: '',
    targetText: '',
    language: '',
    durationS: null,
    sourceImageName: source.filename,
    targetImageName: target.filename,
    createdAt: now(),
    updatedAt: now(),
    localFile: null,
    resultMime: null,
    sizeBytes: null,
    report: null,
    error: null,
    warning: null,
  }
  store.jobs.push(job)
  await saveStore()
  return reply.status(202).send({ job: publicJob(job) })
})

app.post('/api/jobs/:id/cancel', async (request, reply) => {
  const job = findJob(request.params.id)
  if (!job) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '任务不存在', retryable: false } })
  if (['succeeded', 'failed', 'canceled'].includes(job.status)) {
    return reply.status(409).send({ error: { code: 'JOB_NOT_CANCELABLE', message: '任务已结束', retryable: false } })
  }
  try {
    await remoteFetch(`/v1/jobs/${job.remoteJobId}/cancel`, { method: 'POST', timeoutMs: 10000 })
    job.status = 'canceled'
    job.stage = 'canceled'
    job.updatedAt = now()
    await saveStore()
  } catch (err) {
    throw err
  }
  return { job: publicJob(job) }
})

app.get('/api/jobs/:id/report', async (request, reply) => {
  const job = findJob(request.params.id)
  if (!job?.report) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '还没有检测报告', retryable: false } })
  }
  reply
    .header('Content-Type', 'application/json; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="report-${job.id}.json"`)
    .header('Cache-Control', 'no-store')
  return reply.send(JSON.stringify(job.report, null, 2))
})

app.get('/api/files/:id', async (request, reply) => {
  const job = findJob(request.params.id)
  const overlay = request.query?.kind === 'overlay'
  const cert = request.query?.kind === 'cert'
  const target = cert ? job?.certFile : overlay ? job?.overlayFile : job?.localFile
  if (!target) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '产物还没有下载到本地', retryable: false } })
  }
  const resolved = path.resolve(target)
  if (!resolved.startsWith(path.resolve(RESULT_DIR) + path.sep)) {
    return reply.status(403).send({ error: { code: 'FORBIDDEN', message: '非法文件路径', retryable: false } })
  }
  const download = request.query?.download === '1'
  const mime = cert ? 'application/json' : overlay ? 'image/png' : job.resultMime || 'audio/wav'
  const ext = cert ? '.json' : mime.includes('png') ? '.png' : mime.includes('jpeg') ? '.jpg' : mime.includes('webp') ? '.webp' : '.wav'
  const prefix = cert ? 'protect-certificate' : overlay ? 'face-detect-overlay' : job.task === 'image.face_swap' ? 'face-swap' : job.task === 'detect.image' ? 'face-detect' : job.task === 'defend.image' ? 'protected' : 'voice-clone'
  const filename = `${prefix}-${job.id}${ext}`
  reply
    .header('Content-Type', mime)
    .header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`)
    .header('Cache-Control', 'no-store')
  return reply.send(createReadStream(resolved))
})

app.post('/api/jobs/:id/save', async (request, reply) => {
  const job = findJob(request.params.id)
  if (!job?.localFile) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '还没有可保存的音频', retryable: false } })
  }
  const dir = path.join(os.homedir(), 'Downloads', 'DeepfakeStudio')
  await fs.mkdir(dir, { recursive: true })
  const mime = job.resultMime || 'audio/wav'
  const ext = mime.includes('png') ? '.png' : mime.includes('jpeg') ? '.jpg' : mime.includes('webp') ? '.webp' : '.wav'
  const prefix = job.task === 'image.face_swap' ? 'face-swap' : 'voice-clone'
  const dest = path.join(dir, `${prefix}-${job.id}${ext}`)
  await fs.copyFile(job.localFile, dest)
  return { path: dest, filename: path.basename(dest) }
})

try {
  await fs.access(path.join(DIST_DIR, 'index.html'))
  await app.register(fastifyStatic, { root: DIST_DIR, prefix: '/' })
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在', retryable: false } })
    }
    return reply.sendFile('index.html')
  })
} catch {
  app.get('/', async () => ({
    message: '前端还没有构建。先在 app/ 下执行 pnpm build，再重启本地服务。',
  }))
}

await app.listen({ host: HOST, port: PORT })
console.log(`[local] http://${HOST}:${PORT}`)
console.log(`[local] remote ${REMOTE_BASE}`)
if (!TOKEN) console.warn('[local] GATEWAY_TOKEN is not configured')
