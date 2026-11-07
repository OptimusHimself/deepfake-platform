import { useCallback, useEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import { getDetectionModels, getJob, getJobs, submitDetection, toApiError } from './api'
import type { ApiError, DetectionModel, DetectionReport, Health, Job } from './types'

const VERDICT_LABEL: Record<string, string> = {
  fake: '偏假',
  real: '偏真',
  uncertain: '不确定',
}
const CONFIDENCE_LABEL: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
}
const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '分析中',
  loading_detector: '加载检测模型',
  analyzing: '逐窗口分析',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

function done(job: Job) {
  return job.status === 'failed' || job.status === 'canceled' || (job.status === 'succeeded' && Boolean(job.report))
}

function busy(job: Job | null) {
  return Boolean(job && !done(job))
}

function formatTime(iso: string) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
  } catch {
    return iso
  }
}

function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${value.toFixed(1)}s`
}

function truncate(text: string, max = 42) {
  if (!text) return '（无文本）'
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function WaveIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M3 12h2M7 8v8M11 5v14M15 8v8M19 11h2" />
    </svg>
  )
}

function UploadIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 16V4m0 0 4 4m-4-4L8 8" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  )
}

function AlertIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9v4m0 3h.01" />
    </svg>
  )
}

function CheckIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  )
}

function RefreshIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 6.3" />
      <path d="M20 5v6h-6" />
    </svg>
  )
}

function XIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}

type Props = {
  health: Health | null
  refreshHealth: () => void
}

export default function DetectionPanel({ health, refreshHealth }: Props) {
  const [models, setModels] = useState<DetectionModel[]>([])
  const [modelsError, setModelsError] = useState<ApiError | null>(null)
  const [model, setModel] = useState('auto')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [duration, setDuration] = useState<number | null>(null)
  const [consent, setConsent] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [history, setHistory] = useState<Job[]>([])
  const [error, setError] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [now, setNow] = useState(Date.now())
  const inputRef = useRef<HTMLInputElement | null>(null)

  const loadModels = useCallback(async () => {
    try {
      const data = await getDetectionModels()
      setModels(data.models || [])
      setModelsError(data.error ?? null)
      if (data.models?.length && model !== 'auto' && !data.models.some((item) => item.modelId === model)) {
        setModel('auto')
      }
    } catch (err) {
      setModels([])
      setModelsError(toApiError(err))
    }
  }, [model])

  const loadHistory = useCallback(async () => {
    try {
      const data = await getJobs()
      setHistory((data.items || []).filter((item) => item.task === 'detect.audio').slice(0, 6))
    } catch {
      // non-critical
    }
  }, [])

  useEffect(() => {
    void loadModels()
    void loadHistory()
  }, [loadModels, loadHistory])

  useEffect(() => {
    if (!previewUrl) return
    return () => URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  useEffect(() => {
    if (!job || done(job)) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [job])

  useEffect(() => {
    if (!job || done(job)) return
    let cancelled = false
    const tick = async () => {
      try {
        const next = await getJob(job.id)
        if (cancelled) return
        setJob(next)
        if (next.status === 'failed' && next.error) setError(next.error)
      } catch (err) {
        if (!cancelled) setError(toApiError(err))
      }
    }
    void tick()
    const id = window.setInterval(tick, 1500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [job?.id, job?.status, job?.report])

  useEffect(() => {
    if (job?.status === 'succeeded' || job?.status === 'failed' || job?.status === 'canceled') {
      void loadHistory()
    }
  }, [job?.status, loadHistory])

  const acceptFile = (next: File | null) => {
    setError(null)
    if (!next) {
      setFile(null)
      setPreviewUrl(null)
      setDuration(null)
      return
    }
    if (!next.type.startsWith('audio/') && !/\.(wav|mp3|m4a|flac|ogg|aac|opus)$/i.test(next.name)) {
      setError({ code: 'UNSUPPORTED_MIME', message: '请选择音频文件', hint: '支持 wav / mp3 / m4a / flac', retryable: false })
      return
    }
    if (next.size > 50 * 1024 * 1024) {
      setError({ code: 'PAYLOAD_TOO_LARGE', message: '文件超过 50MB', hint: '截短音频后再试', retryable: false })
      return
    }
    const url = URL.createObjectURL(next)
    setFile(next)
    setPreviewUrl(url)
    setDuration(null)
    const audio = new Audio()
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration)
    }
    audio.src = url
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    const next = event.dataTransfer.files?.[0]
    if (next) acceptFile(next)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!file || !consent || !health?.ok || submitting || busy(job) || models.length === 0) return
    setSubmitting(true)
    setError(null)
    setJob(null)
    const form = new FormData()
    form.append('file', file, file.name)
    form.append('model', model)
    form.append('consent', 'true')
    try {
      const created = await submitDetection(form)
      setJob(created)
      setNow(Date.now())
    } catch (err) {
      setError(toApiError(err))
    } finally {
      setSubmitting(false)
    }
  }

  const openHistory = async (item: Job) => {
    setError(null)
    setJob(item)
    if (!done(item)) {
      try {
        const fresh = await getJob(item.id)
        setJob(fresh)
      } catch (err) {
        setError(toApiError(err))
      }
    }
  }

  const reset = () => {
    setJob(null)
    setError(null)
    setFile(null)
    setPreviewUrl(null)
    setDuration(null)
    setConsent(false)
  }

  const report: DetectionReport | null = job?.report ?? null
  const isBusy = busy(job)
  const canSubmit = Boolean(file && consent && health?.ok && !submitting && !isBusy && models.length > 0)
  const elapsed = job ? Math.max(0, Math.round(((done(job) ? new Date(job.updatedAt).getTime() : now) - new Date(job.createdAt).getTime()) / 1000)) : 0
  const progress = job ? Math.max(0.04, Math.min(1, job.progress || 0)) : 0
  const totalDuration = report?.processing?.duration_s ?? job?.durationS ?? duration ?? 1
  const verdict = report ? (VERDICT_LABEL[report.verdict] ?? report.verdict) : ''
  const verdictClass = report?.verdict ?? 'uncertain'

  return (
    <>
      <div className="workspace">
        <form className="card input-card" onSubmit={handleSubmit}>
          <div className="card-head">
            <div>
              <span className="kicker">STEP 01</span>
              <h2>上传待检测音频</h2>
            </div>
            <span className="tag muted">detect.audio</span>
          </div>

          <div className="field">
            <div className="field-head">
              <label htmlFor="detect-audio-input">音频文件</label>
              <span className="hint">wav / mp3 / m4a / flac · ≤50MB</span>
            </div>
            <div
              className={`dropzone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click()
              }}
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
            >
              <input
                id="detect-audio-input"
                ref={inputRef}
                type="file"
                accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg"
                hidden
                onChange={(event) => {
                  acceptFile(event.target.files?.[0] ?? null)
                  event.target.value = ''
                }}
              />
              {file ? (
                <div className="file-row">
                  <span className="file-icon"><WaveIcon /></span>
                  <div className="file-meta">
                    <strong>{file.name}</strong>
                    <span>{duration !== null ? formatDuration(duration) : '读取时长…'} · {Math.round(file.size / 1024)} KB</span>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="移除音频"
                    onClick={(event) => {
                      event.stopPropagation()
                      acceptFile(null)
                    }}
                  >
                    <XIcon />
                  </button>
                </div>
              ) : (
                <div className="dropzone-empty">
                  <span className="upload-icon"><UploadIcon /></span>
                  <strong>拖入音频，或点击选择</strong>
                  <span>建议 4 秒以上；检测会按 4 秒窗口分析</span>
                </div>
              )}
            </div>
            {previewUrl && <audio className="reference-audio" src={previewUrl} controls preload="metadata" />}
          </div>

          <div className="field">
            <div className="field-head">
              <label>检测模型</label>
              <span className="hint">你可以自己选</span>
            </div>
            <div className="model-grid">
              <label className={`model-choice ${model === 'auto' ? 'selected' : ''}`}>
                <input type="radio" name="detect-model" value="auto" checked={model === 'auto'} onChange={() => setModel('auto')} />
                <div>
                  <strong>自动选择</strong>
                  <span>由服务端按优先级选择可用模型</span>
                </div>
              </label>
              {models.map((item) => (
                <label key={item.modelId} className={`model-choice ${model === item.modelId ? 'selected' : ''}`}>
                  <input type="radio" name="detect-model" value={item.modelId} checked={model === item.modelId} onChange={() => setModel(item.modelId)} />
                  <div>
                    <strong>{item.displayName}</strong>
                    <span>{item.description || '音频反欺骗检测模型'}</span>
                    <em>{[item.languages, item.speed].filter(Boolean).join(' · ')}</em>
                  </div>
                </label>
              ))}
            </div>
            {modelsError && (
              <div className="warning-box" style={{ marginTop: 10 }}>
                <AlertIcon size={15} />
                <div>
                  <strong>{modelsError.code}</strong>
                  <p>{modelsError.hint ?? modelsError.message}</p>
                </div>
              </div>
            )}
            {!models.length && !modelsError && <p className="form-note">正在读取远端检测模型…</p>}
          </div>

          <label className="consent" style={{ marginTop: 18 }}>
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>我确认有权分析这段音频，并理解检测结果不是司法鉴定结论。</span>
          </label>

          {error && (
            <div className="error-box" role="alert">
              <AlertIcon />
              <div>
                <strong>{error.code}</strong>
                <p>{error.message}</p>
                {error.hint && <span>{error.hint}</span>}
              </div>
              <button type="button" className="icon-button" onClick={() => setError(null)} aria-label="关闭错误">
                <XIcon />
              </button>
            </div>
          )}

          <button className="primary" type="submit" disabled={!canSubmit}>
            {submitting ? '正在提交…' : isBusy ? '分析中…' : '开始检测'}
          </button>
          <p className="form-note">
            {!health?.ok ? '先连接 GPU 服务器。' : models.length ? '分析在远端 GPU 完成；结果会保存在本地历史。' : '没有可用检测模型。'}
          </p>
        </form>

        <section className="card result-card" aria-live="polite">
          <div className="card-head">
            <div>
              <span className="kicker">STEP 02</span>
              <h2>检测结果</h2>
            </div>
            <span className="tag muted">{report ? report.model_version : '音频反欺骗'}</span>
          </div>

          {!job && (
            <div className="result-empty">
              <div className="scan-art" aria-hidden="true">
                <i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />
              </div>
              <strong>等待一段声音</strong>
              <p>上传音频并选择检测模型，结果会显示概率、可疑时间段和模型警告。</p>
              <div className="empty-steps">
                <span>1. 上传音频</span>
                <span>2. 选择模型</span>
                <span>3. 开始检测</span>
              </div>
            </div>
          )}

          {job && (
            <div className="result-content">
              <div className="job-head">
                <span className={`job-badge ${job.status}`}>{STAGE_LABEL[job.stage] ?? STAGE_LABEL[job.status] ?? job.status}</span>
                <span className="elapsed">用时 {elapsed}s</span>
              </div>

              {isBusy && (
                <div className="progress-block">
                  <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                  <div className="progress-meta"><span>{STAGE_LABEL[job.stage] ?? '分析中'}</span><span>{Math.round(progress * 100)}%</span></div>
                </div>
              )}

              {job.warning && (
                <div className="warning-box">
                  <AlertIcon size={16} />
                  <div><strong>{job.warning.code}</strong><p>{job.warning.hint ?? job.warning.message}</p></div>
                </div>
              )}

              {report && (
                <>
                  <div className={`verdict-card ${verdictClass}`}>
                    <div>
                      <span className="verdict-kicker">模型判断</span>
                      <strong>{verdict}</strong>
                      <p>置信度 {CONFIDENCE_LABEL[report.confidence] ?? report.confidence} · 阈值 {Math.round(report.threshold * 100)}%</p>
                    </div>
                    <div className="verdict-score">
                      <strong>{Math.round(report.score * 100)}<small>%</small></strong>
                      <span>fake 概率</span>
                    </div>
                  </div>

                  <div className="score-meter" aria-label={`fake 概率 ${Math.round(report.score * 100)}%`}>
                    <div className={`score-fill ${verdictClass}`} style={{ width: `${Math.max(2, report.score * 100)}%` }} />
                    <i style={{ left: `${report.threshold * 100}%` }} title={`阈值 ${report.threshold}`} />
                  </div>

                  <div className="timeline-card">
                    <div className="timeline-head">
                      <strong>可疑时间段</strong>
                      <span>{report.processing.windows ?? 0} 个窗口 · {formatDuration(report.processing.duration_s)}</span>
                    </div>
                    <div className="timeline">
                      {report.segments.length === 0 ? (
                        <span className="timeline-empty">没有超过阈值的片段</span>
                      ) : (
                        report.segments.map((segment, index) => (
                          <span
                            key={`${segment.start_s}-${index}`}
                            className={`timeline-segment ${segment.verdict}`}
                            style={{
                              left: `${(segment.start_s / Math.max(0.1, totalDuration)) * 100}%`,
                              width: `${Math.max(1.2, ((segment.end_s - segment.start_s) / Math.max(0.1, totalDuration)) * 100)}%`,
                            }}
                            title={`${segment.start_s.toFixed(1)}–${segment.end_s.toFixed(1)}s · ${Math.round(segment.score * 100)}%`}
                          />
                        ))
                      )}
                    </div>
                    {report.segments.length > 0 && (
                      <div className="segment-list">
                        {report.segments.map((segment, index) => (
                          <div key={`${segment.start_s}-${index}`} className="segment-row">
                            <span>{segment.start_s.toFixed(1)}–{segment.end_s.toFixed(1)}s</span>
                            <span className={`segment-score ${segment.verdict}`}>{Math.round(segment.score * 100)}%</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="result-meta">
                    <div><span>检测模型</span><strong>{report.models[0]?.model_id ?? job.modelId}</strong></div>
                    <div><span>音频时长</span><strong>{formatDuration(report.processing.duration_s)}</strong></div>
                    <div><span>窗口</span><strong>{report.processing.window_s ?? 4}s / 步长 {report.processing.hop_s ?? 1}s</strong></div>
                    <div><span>分析时间</span><strong>{formatTime(report.created_at)}</strong></div>
                  </div>

                  <details className="route-detail" open>
                    <summary>模型怎么说</summary>
                    <ul className="explain-list">
                      {report.explanations.map((item, index) => <li key={index}>{item}</li>)}
                    </ul>
                  </details>

                  <div className="warning-list">
                    {report.warnings.map((item, index) => (
                      <p key={index}><AlertIcon size={13} /> {item}</p>
                    ))}
                  </div>

                  <div className="actions">
                    <button type="button" className="button secondary" onClick={reset}>
                      再检测一段
                    </button>
                    <button type="button" className="button ghost" onClick={() => { void loadModels(); refreshHealth() }}>
                      <RefreshIcon /> 刷新模型 / 连接
                    </button>
                  </div>
                </>
              )}

              {job.status === 'succeeded' && !report && (
                <div className="result-empty small">
                  <div className="spinner" />
                  <strong>分析完成，正在取回报告…</strong>
                  <p>本地服务会从 GPU 服务器刷新结果。</p>
                </div>
              )}

              {job.status === 'failed' && (
                <div className="result-failed">
                  <AlertIcon size={20} />
                  <div>
                    <strong>{job.error?.code ?? '检测失败'}</strong>
                    <p>{job.error?.message ?? '远端检测失败，请重试。'}</p>
                    {job.error?.hint && <span>{job.error.hint}</span>}
                  </div>
                  <button type="button" className="ghost small" onClick={() => { setJob(null); setError(null) }}>重新上传</button>
                </div>
              )}

              {job.status === 'canceled' && (
                <div className="result-empty small">
                  <strong>任务已取消</strong>
                  <button type="button" className="ghost small" onClick={() => setJob(null)}>返回</button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <section className="history-section">
        <div className="section-head">
          <div>
            <span className="kicker">RECENT</span>
            <h2>最近检测</h2>
          </div>
          <button type="button" className="ghost small" onClick={loadHistory}><RefreshIcon /> 刷新</button>
        </div>
        {history.length === 0 ? (
          <div className="empty-history">还没有检测记录。</div>
        ) : (
          <div className="history-list">
            {history.map((item) => (
              <button type="button" key={item.id} className="history-item" onClick={() => void openHistory(item)}>
                <span className={`history-dot ${item.report?.verdict === 'fake' ? 'failed' : item.report?.verdict === 'real' ? 'succeeded' : 'queued'}`} />
                <div className="history-copy">
                  <strong>{item.report ? `${VERDICT_LABEL[item.report.verdict] ?? item.report.verdict} · ${Math.round(item.report.score * 100)}%` : truncate(item.modelId)}</strong>
                  <span>{formatTime(item.createdAt)} · {item.report?.model_version ?? item.modelId}</span>
                </div>
                {item.report && <CheckIcon size={13} />}
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
