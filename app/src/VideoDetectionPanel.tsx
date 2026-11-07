import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getJob, getJobs, getVideoModels, submitVideoDetection, toApiError } from './api'
import type { ApiError, Health, Job, VideoDetectionModel } from './types'

const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  loading_detector: '加载视频模型',
  analyzing: '抽帧 / 人脸检测',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const VERDICT_LABEL: Record<string, string> = {
  fake: '偏假',
  real: '偏真',
  uncertain: '不确定',
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

function VideoIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="6" width="12" height="12" rx="2" />
      <path d="m15 10 5-3v10l-5-3" />
    </svg>
  )
}

type Props = {
  health: Health | null
  refreshHealth: () => void
}

export default function VideoDetectionPanel({ health, refreshHealth }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [models, setModels] = useState<VideoDetectionModel[]>([])
  const [model, setModel] = useState('auto')
  const [modelsError, setModelsError] = useState<ApiError | null>(null)
  const [consent, setConsent] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [history, setHistory] = useState<Job[]>([])
  const [error, setError] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [now, setNow] = useState(Date.now())
  const inputRef = useRef<HTMLInputElement | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const data = await getJobs()
      setHistory((data.items || []).filter((item) => item.task === 'detect.video').slice(0, 6))
    } catch {
      // non-critical
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    let cancelled = false
    getVideoModels()
      .then((data) => {
        if (cancelled) return
        setModels(data.models || [])
        setModelsError(data.error ?? null)
      })
      .catch((err) => {
        if (!cancelled) {
          setModels([])
          setModelsError(toApiError(err))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

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
    if (job?.status === 'succeeded' || job?.status === 'failed') void loadHistory()
  }, [job?.status, loadHistory])

  const accept = (next: File | null) => {
    setError(null)
    if (!next) {
      setFile(null)
      setPreviewUrl(null)
      return
    }
    if (!next.type.startsWith('video/')) {
      setError({ code: 'UNSUPPORTED_MIME', message: '请选择视频', hint: 'MP4 / MOV / WEBM', retryable: false })
      return
    }
    if (next.size > 100 * 1024 * 1024) {
      setError({ code: 'PAYLOAD_TOO_LARGE', message: '视频超过 100MB', hint: '截短/压缩后再试', retryable: false })
      return
    }
    setFile(next)
    setPreviewUrl(URL.createObjectURL(next))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!file || !consent || !health?.ok || submitting || busy(job)) return
    setSubmitting(true)
    setError(null)
    setJob(null)
    const form = new FormData()
    form.append('file', file, file.name)
    form.append('model', model)
    form.append('consent', 'true')
    try {
      const created = await submitVideoDetection(form)
      setJob(created)
      setNow(Date.now())
    } catch (err) {
      setError(toApiError(err))
    } finally {
      setSubmitting(false)
    }
  }

  const reset = () => {
    setJob(null)
    setError(null)
  }

  const report = job?.report
  const isBusy = busy(job)
  const canSubmit = Boolean(file && consent && health?.ok && !submitting && !isBusy)
  const elapsed = job ? Math.max(0, Math.round(((done(job) ? new Date(job.updatedAt).getTime() : now) - new Date(job.createdAt).getTime()) / 1000)) : 0
  const progress = job ? Math.max(0.04, Math.min(1, job.progress || 0)) : 0
  const verdict = report ? (VERDICT_LABEL[report.verdict] ?? report.verdict) : ''
  const verdictClass = report?.verdict ?? 'uncertain'

  return (
    <>
      <div className="workspace">
        <form className="card input-card" onSubmit={submit}>
          <div className="card-head">
            <div>
              <span className="kicker">STEP 01</span>
              <h2>上传正脸说话视频</h2>
            </div>
            <span className="tag muted">detect.video</span>
          </div>

          <div className="field">
            <div className="field-head">
              <label>视频文件</label>
              <span className="hint">MP4 / MOV / WEBM · ≤100MB</span>
            </div>
            <div
              className={`image-drop video-drop ${dragging ? 'dragging' : ''} ${previewUrl ? 'has-image' : ''}`}
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
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                accept(event.dataTransfer.files?.[0] ?? null)
              }}
            >
              <input
                ref={inputRef}
                type="file"
                accept="video/*,.mp4,.mov,.webm"
                hidden
                onChange={(event) => {
                  accept(event.target.files?.[0] ?? null)
                  event.target.value = ''
                }}
              />
              {previewUrl ? (
                <>
                  <video src={previewUrl} controls muted playsInline />
                  <button type="button" className="image-remove" aria-label="移除视频" onClick={(event) => { event.stopPropagation(); accept(null) }}>
                    <XIcon />
                  </button>
                  <span className="image-name">{file?.name}</span>
                </>
              ) : (
                <div className="image-empty">
                  <span className="upload-icon"><VideoIcon /></span>
                  <strong>拖入视频或点击选择</strong>
                  <span>正脸、单人、光线均匀效果最好</span>
                </div>
              )}
            </div>
          </div>

          <div className="field">
            <div className="field-head">
              <label>视频检测模型</label>
              <span className="hint">按视频/音频能力选择</span>
            </div>
            <div className="model-grid">
              <label className={`model-choice ${model === 'auto' ? 'selected' : ''}`}>
                <input type="radio" name="video-model" value="auto" checked={model === 'auto'} onChange={() => setModel('auto')} />
                <div><strong>自动选择</strong><span>优先 RealForensics 视觉基线</span></div>
              </label>
              {models.map((item) => (
                <label key={item.modelId} className={`model-choice ${model === item.modelId ? 'selected' : ''} ${item.status !== 'ready' ? 'disabled' : ''}`}>
                  <input type="radio" name="video-model" value={item.modelId} checked={model === item.modelId} disabled={item.status !== 'ready'} onChange={() => setModel(item.modelId)} />
                  <div>
                    <strong>{item.displayName}</strong>
                    <span>{[item.year ? `${item.year} 年` : null, item.license].filter(Boolean).join(' · ')}</span>
                    <em>{item.typicalSeconds ? `约 ${item.typicalSeconds}s/条` : ''}</em>
                    <span>{item.description}</span>
                  </div>
                </label>
              ))}
            </div>
            {modelsError && (
              <div className="warning-box" style={{ marginTop: 10 }}>
                <AlertIcon size={15} />
                <div><strong>{modelsError.code}</strong><p>{modelsError.hint ?? modelsError.message}</p></div>
              </div>
            )}
          </div>

          <div className="model-note">
            <span className="tag muted">模型说明</span>
            <p>RealForensics：CVPR 2022，CSN-r101，视觉单模态，25 帧，MIT。AVFF：CVPR 2024 非官方实现，视频+音频，16 帧，许可证未明确。两者都对 Seedance 2.5 可能漏检。</p>
          </div>

          <label className="consent" style={{ marginTop: 18 }}>
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>我确认有权分析这段视频，并理解检测结果不是司法鉴定结论。</span>
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
            {!health?.ok ? '先连接 GPU 服务器。' : '检测在远端 GPU 完成；结果保存到本地历史。'}
          </p>
        </form>

        <section className="card result-card" aria-live="polite">
          <div className="card-head">
            <div>
              <span className="kicker">STEP 02</span>
              <h2>视频检测结果</h2>
            </div>
            <span className="tag muted">{report ? report.model_version : '视频时序检测'}</span>
          </div>

          {!job && (
            <div className="result-empty">
              <div className="scan-art" aria-hidden="true">
                <i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />
              </div>
              <strong>等待一段说话视频</strong>
              <p>模型抽取 25 帧人脸，判断整段视频更像真实还是合成。</p>
              <div className="empty-steps">
                <span>1. 上传视频</span>
                <span>2. 抽帧检测</span>
                <span>3. 视频级结论</span>
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

              {report && (
                <>
                  <div className={`verdict-card ${verdictClass}`}>
                    <div>
                      <span className="verdict-kicker">视频级判断</span>
                      <strong>{verdict}</strong>
                      <p>置信度 {report.confidence} · 阈值 {Math.round(report.threshold * 100)}%</p>
                    </div>
                    <div className="verdict-score">
                      <strong>{Math.round(report.score * 100)}<small>%</small></strong>
                      <span>fake 概率</span>
                    </div>
                  </div>

                  <div className="score-meter">
                    <div className={`score-fill ${verdictClass}`} style={{ width: `${Math.max(2, report.score * 100)}%` }} />
                    <i style={{ left: `${report.threshold * 100}%` }} />
                  </div>

                  {previewUrl && <video className="video-result" src={previewUrl} controls muted playsInline />}

                  {(report.segments || []).length > 0 && (
                    <div className="timeline-card">
                      <div className="timeline-head">
                        <strong>时间轴 / 可疑片段</strong>
                        <span>{report.processing?.clips ?? report.segments.length} 个 1s 片段</span>
                      </div>
                      {report.model_version === 'avff-stage3' && (
                        <p className="form-note" style={{ margin: '0 0 8px' }}>AVFF 只输出视频级分数，不做片段定位；要定位可疑片段请选 RealForensics。</p>
                      )}
                      <div className="timeline">
                        {report.segments.map((segment: any, index: number) => {
                          const duration = Math.max(...report.segments.map((item: any) => item.end_s || item.start_s + 1), 1)
                          return (
                            <span
                              key={index}
                              className={`timeline-segment ${segment.verdict}`}
                              style={{
                                left: `${(segment.start_s / duration) * 100}%`,
                                width: `${Math.max(1, ((segment.end_s - segment.start_s) / duration) * 100)}%`,
                              }}
                              title={`${segment.start_s.toFixed(1)}–${segment.end_s.toFixed(1)}s · ${Math.round(segment.score * 100)}%`}
                            />
                          )
                        })}
                      </div>
                      <div className="segment-list">
                        {(report.frames || []).slice(0, 4).map((frame: any, index: number) => (
                          <span key={index} className={`segment-row ${frame.score >= 0.5 ? 'fake' : 'real'}`}>
                            {frame.time_s}s · {Math.round(frame.score * 100)}%
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {job.overlayUrl && (
                    <div className="image-result video-contact">
                      <img src={`${job.overlayUrl}&v=${encodeURIComponent(job.updatedAt)}`} alt="关键帧与可疑片段" />
                    </div>
                  )}

                  <div className="result-meta">
                    <div><span>模型</span><strong>{report.model_version}</strong></div>
                    <div><span>片段</span><strong>{report.processing?.clips ?? report.processing?.frames ?? 25}</strong></div>
                    <div><span>人脸帧</span><strong>{report.processing?.face_frames ?? '—'}</strong></div>
                    <div><span>分析时间</span><strong>{formatTime(report.created_at)}</strong></div>
                  </div>

                  <div className="actions">
                    <a className="button secondary" href={`/api/jobs/${job.id}/report`}>下载分析报告</a>
                  </div>

                  <details className="route-detail" open>
                    <summary>模型怎么说</summary>
                    <ul className="explain-list">
                      {report.explanations.map((item: string, index: number) => <li key={index}>{item}</li>)}
                    </ul>
                  </details>

                  <div className="warning-list">
                    {report.warnings.map((item: string, index: number) => (
                      <p key={index}><AlertIcon size={13} /> {item}</p>
                    ))}
                  </div>

                  <div className="actions">
                    <button type="button" className="button secondary" onClick={reset}>再检测一段</button>
                    <button type="button" className="button ghost" onClick={() => { void loadHistory(); refreshHealth() }}><RefreshIcon /> 刷新</button>
                  </div>
                </>
              )}

              {job.status === 'succeeded' && !report && (
                <div className="result-empty small">
                  <div className="spinner" />
                  <strong>分析完成，正在取回报告…</strong>
                </div>
              )}

              {job.status === 'failed' && (
                <div className="result-failed">
                  <AlertIcon size={20} />
                  <div>
                    <strong>{job.error?.code ?? '检测失败'}</strong>
                    <p>{job.error?.message ?? '远端视频检测失败，请重试。'}</p>
                    {job.error?.hint && <span>{job.error.hint}</span>}
                  </div>
                  <button type="button" className="ghost small" onClick={reset}>重新上传</button>
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
            <h2>最近视频检测</h2>
          </div>
          <button type="button" className="ghost small" onClick={loadHistory}><RefreshIcon /> 刷新</button>
        </div>
        {history.length === 0 ? (
          <div className="empty-history">还没有视频检测记录。</div>
        ) : (
          <div className="history-list">
            {history.map((item) => (
              <button type="button" key={item.id} className="history-item" onClick={() => { setJob(item); setError(null) }}>
                <span className={`history-dot ${item.report?.verdict === 'fake' ? 'failed' : item.report?.verdict === 'real' ? 'succeeded' : 'queued'}`} />
                <div className="history-copy">
                  <strong>{item.report ? `${VERDICT_LABEL[item.report.verdict] ?? item.report.verdict} · ${Math.round(item.report.score * 100)}%` : item.modelId}</strong>
                  <span>{formatTime(item.createdAt)} · {item.modelId}</span>
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
