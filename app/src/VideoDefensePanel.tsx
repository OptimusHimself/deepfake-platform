import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getJob, getJobs, submitVideoDefense, toApiError } from './api'
import type { ApiError, Health, Job } from './types'

const STAGE_LABEL: Record<string, string> = {
  queued: '排队中',
  protecting: '逐帧扰动 / 嵌入水印',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const STRENGTHS = [
  { id: 'low', label: '低', note: '逐帧 8 步 · 推荐先用' },
  { id: 'medium', label: '中', note: '逐帧 16 步 · 更慢' },
]

function done(job: Job) {
  return job.status === 'failed' || job.status === 'canceled' || (job.status === 'succeeded' && Boolean(job.resultUrl))
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

function RefreshIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 6.3" />
      <path d="M20 5v6h-6" />
    </svg>
  )
}

function ShieldIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}

type Props = {
  health: Health | null
  refreshHealth: () => void
}

export default function VideoDefensePanel({ health, refreshHealth }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [strength, setStrength] = useState('low')
  const [consent, setConsent] = useState(false)
  const [job, setJob] = useState<Job | null>(null)
  const [history, setHistory] = useState<Job[]>([])
  const [error, setError] = useState<ApiError | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [now, setNow] = useState(Date.now())
  const inputRef = useRef<HTMLInputElement | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const data = await getJobs()
      setHistory((data.items || []).filter((item) => item.task === 'defend.video').slice(0, 6))
    } catch {
      // non-critical
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

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
    const id = window.setInterval(tick, 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [job?.id, job?.status, job?.resultUrl])

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
    form.append('strength', strength)
    form.append('consent', 'true')
    try {
      const created = await submitVideoDefense(form)
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
  const metrics = report?.metrics
  const isBusy = busy(job)
  const canSubmit = Boolean(file && consent && health?.ok && !submitting && !isBusy)
  const elapsed = job ? Math.max(0, Math.round(((done(job) ? new Date(job.updatedAt).getTime() : now) - new Date(job.createdAt).getTime()) / 1000)) : 0
  const progress = job ? Math.max(0.03, Math.min(1, job.progress || 0)) : 0
  const protectedSrc = job?.resultUrl ? `${job.resultUrl}?v=${encodeURIComponent(job.updatedAt)}` : null

  return (
    <>
      <div className="workspace">
        <form className="card input-card" onSubmit={submit}>
          <div className="card-head">
            <div>
              <span className="kicker">STEP 01</span>
              <h2>保护你的视频</h2>
            </div>
            <span className="tag muted">defend.video</span>
          </div>

          <div className="field">
            <div className="field-head">
              <label>原始视频</label>
              <span className="hint">本人 / 授权素材 · ≤100MB</span>
            </div>
            <div
              className={`image-drop video-drop ${previewUrl ? 'has-image' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click()
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
                  <span className="image-name">{file?.name}</span>
                </>
              ) : (
                <div className="image-empty">
                  <span className="upload-icon"><ShieldIcon /></span>
                  <strong>拖入视频或点击选择</strong>
                  <span>正脸、单人、光线均匀效果最好</span>
                </div>
              )}
            </div>
          </div>

          <div className="field">
            <div className="field-head">
              <label>保护强度</label>
              <span className="hint">低强度更适合视频</span>
            </div>
            <div className="strength-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
              {STRENGTHS.map((item) => (
                <label key={item.id} className={`strength-card ${strength === item.id ? 'selected' : ''}`}>
                  <input type="radio" name="video-strength" value={item.id} checked={strength === item.id} onChange={() => setStrength(item.id)} />
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.note}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <label className="consent" style={{ marginTop: 18 }}>
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
            <span>我确认这是本人/授权视频，并理解视频防御不能保证阻止所有换脸或重绘。</span>
          </label>

          {error && (
            <div className="error-box" role="alert">
              <AlertIcon />
              <div>
                <strong>{error.code}</strong>
                <p>{error.message}</p>
                {error.hint && <span>{error.hint}</span>}
              </div>
            </div>
          )}

          <button className="primary" type="submit" disabled={!canSubmit}>
            {submitting ? '正在提交…' : isBusy ? '逐帧处理中…' : '生成保护视频'}
          </button>
          <p className="form-note">
            {!health?.ok ? '先连接 GPU 服务器。' : '逐帧 CLIP PGD + 水印，重建 MP4；最多 250 帧。'}
          </p>
        </form>

        <section className="card result-card" aria-live="polite">
          <div className="card-head">
            <div>
              <span className="kicker">STEP 02</span>
              <h2>保护结果</h2>
            </div>
            <span className="tag muted">{report ? report.model_version : '视频防御'}</span>
          </div>

          {!job && (
            <div className="result-empty">
              <div className="scan-art" aria-hidden="true">
                <i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i />
              </div>
              <strong>等待一段视频</strong>
              <p>保护后会在右侧显示前后检测分数和片段变化。</p>
              <div className="empty-steps">
                <span>1. 上传视频</span>
                <span>2. 逐帧扰动</span>
                <span>3. 前后对比</span>
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
                  <div className="progress-meta"><span>{STAGE_LABEL[job.stage] ?? '处理中'}</span><span>{Math.round(progress * 100)}%</span></div>
                </div>
              )}

              {report && (
                <>
                  <div className="verdict-card real">
                    <div>
                      <span className="verdict-kicker">保护完成</span>
                      <strong>已生成保护视频</strong>
                      <p>逐帧扰动 + 水印 · {metrics?.frames ?? 0} 帧</p>
                    </div>
                    <div className="verdict-score">
                      <strong>{metrics?.psnr_db ?? '—'}<small>dB</small></strong>
                      <span>PSNR</span>
                    </div>
                  </div>

                  <div className="result-meta">
                    <div><span>PSNR</span><strong>{metrics?.psnr_db ?? '—'} dB</strong></div>
                    <div><span>SSIM</span><strong>{metrics?.ssim ?? '—'}</strong></div>
                    <div><span>水印匹配</span><strong>{Math.round((metrics?.watermark_match_rate ?? 0) * 100)}%</strong></div>
                    <div><span>帧数</span><strong>{metrics?.frames ?? 0}</strong></div>
                  </div>

                  {protectedSrc && <video className="video-result" src={protectedSrc} controls muted playsInline />}

                  {report.before && report.after && (
                    <div className="timeline-card">
                      <div className="timeline-head"><strong>检测前后对比</strong><span>RealForensics</span></div>
                      <div className="compare-grid">
                        <div><span>保护前</span><strong>{report.before.verdict} · {Math.round((report.before.score || 0) * 100)}%</strong></div>
                        <div><span>保护后</span><strong>{report.after.verdict} · {Math.round((report.after.score || 0) * 100)}%</strong></div>
                      </div>
                      <p className="form-note">这是检测器分数变化，不等于换脸/重绘失败；真正的防御效果要用 HyperSwap/inswapper 攻击后再算身份相似度。</p>
                      <div className="timeline">
                        {(report.after.segments || []).map((segment: any, index: number) => {
                          const duration = Math.max(...(report.after.segments || []).map((item: any) => item.end_s || item.start_s + 1), 1)
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
                    </div>
                  )}

                  <div className="warning-list">
                    {(report.warnings || []).map((item: string, index: number) => (
                      <p key={index}><AlertIcon size={13} /> {item}</p>
                    ))}
                  </div>

                  <div className="actions">
                    {job.resultUrl && <a className="button secondary" href={`${job.resultUrl}?download=1`}>下载保护视频</a>}
                    {job.certUrl && <a className="button ghost" href={job.certUrl}>下载证书</a>}
                    <button type="button" className="button ghost" onClick={reset}>再保护一段</button>
                  </div>
                </>
              )}

              {job.status === 'failed' && (
                <div className="result-failed">
                  <AlertIcon size={20} />
                  <div>
                    <strong>{job.error?.code ?? '保护失败'}</strong>
                    <p>{job.error?.message ?? '远端视频防御失败，请重试。'}</p>
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
            <h2>最近视频防御</h2>
          </div>
          <button type="button" className="ghost small" onClick={() => { void loadHistory(); refreshHealth() }}><RefreshIcon /> 刷新</button>
        </div>
        {history.length === 0 ? (
          <div className="empty-history">还没有视频防御记录。</div>
        ) : (
          <div className="history-list">
            {history.map((item) => (
              <button type="button" key={item.id} className="history-item" onClick={() => { setJob(item); setError(null) }}>
                <span className={`history-dot ${item.status === 'succeeded' ? 'succeeded' : item.status === 'failed' ? 'failed' : 'queued'}`} />
                <div className="history-copy">
                  <strong>{item.sourceImageName || item.modelId}</strong>
                  <span>{formatTime(item.createdAt)} · {item.modelId}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
