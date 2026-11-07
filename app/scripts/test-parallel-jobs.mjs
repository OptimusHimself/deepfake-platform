// Integration test: uses existing successful remote jobs as authorized fixtures.
// Run from app/: node scripts/test-parallel-jobs.mjs
import 'dotenv/config'
import assert from 'node:assert/strict'

const base = process.env.REMOTE_BASE_URL || 'http://127.0.0.1:18000'
const token = process.env.GATEWAY_TOKEN?.trim()
assert(token, 'GATEWAY_TOKEN is required')
async function api(route, body) {
  const response = await fetch(base + route, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  assert(response.ok, `API ${route}: HTTP ${response.status}`)
  return response.json()
}

const health = await api('/v1/health')
assert(health.queue.max_concurrency >= 2, 'Parallel workers are disabled')
assert.equal(health.queue.running + health.queue.queued, 0, 'Run with an idle queue')
const capabilities = await api('/v1/capabilities')
assert(capabilities.scheduling.max_concurrency >= 2)
const history = (await api('/v1/jobs?limit=100')).items
const tasks = ['audio.clone', 'detect.video']
const fixtures = tasks.map(task => {
  const fixture = history.find(job => job.task === task && job.status === 'succeeded')
  assert(fixture, `No successful fixture for ${task}`)
  return fixture
})
const jobs = await Promise.all(fixtures.map(async fixture => {
  const task = fixture.task
  return (await api('/v1/jobs', {
    task, model: fixture.model_id || 'auto', inputs: fixture.inputs,
    text: fixture.text, options: fixture.options,
    consent: { subject: 'self', purpose: 'parallel integration test with existing demo fixtures', agreed: true },
  })).job
}))
console.log('Submitted', jobs.map(job => ({ id: job.id, task: job.task })))
let overlap = false
let results
const deadline = Date.now() + 300000
while (Date.now() < deadline) {
  results = await Promise.all(jobs.map(job => api(`/v1/jobs/${job.id}`).then(r => r.job)))
  const active = results.filter(job => ['running', 'prepared', 'postprocessing'].includes(job.status))
  if (active.length === 2) overlap = true
  if (results.every(job => ['succeeded', 'failed', 'canceled'].includes(job.status))) break
  await new Promise(resolve => setTimeout(resolve, 250))
}
console.log(JSON.stringify({ overlap, jobs: results.map(job => ({
  id: job.id, task: job.task, status: job.status, started_at: job.started_at,
  finished_at: job.finished_at, outputs: job.outputs?.length, error: job.error,
})) }, null, 2))
assert(overlap, 'Did not observe both jobs running together')
for (const job of results) {
  assert.equal(job.status, 'succeeded', `${job.task} did not succeed`)
}
