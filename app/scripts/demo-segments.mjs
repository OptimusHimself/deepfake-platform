import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const ROOT = 'C:\\Projects\\deepfake-platform'
const DIR = path.join(ROOT, 'demo_data', 'segments')
const FAKE = path.join(ROOT, 'demo_data', 'demo_clips', 'fake_child_man.mp4')
const REAL = path.join(ROOT, 'demo_data', 'demo_clips', 'real_phone.mp4')
const SOURCE = path.join(ROOT, 'demo_data', 'source_jay.jpg')
fs.mkdirSync(DIR, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const hold = (page, ms) => page.waitForTimeout(ms)

async function newPage() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: { dir: DIR, size: { width: 1440, height: 1000 } },
  })
  await context.addInitScript(() => {
    const install = () => {
      if (document.getElementById('__demo_cursor')) return
      const dot = document.createElement('div')
      dot.id = '__demo_cursor'
      dot.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;border-radius:50%;background:rgba(122,92,245,.32);border:2px solid rgba(122,92,245,.95);box-shadow:0 0 0 8px rgba(122,92,245,.12);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);transition:transform .08s ease;display:none'
      document.documentElement.appendChild(dot)
      window.addEventListener('mousemove', (e) => {
        dot.style.display = 'block'
        dot.style.left = `${e.clientX}px`
        dot.style.top = `${e.clientY}px`
      }, true)
      window.addEventListener('mousedown', () => { dot.style.transform = 'translate(-50%,-50%) scale(.82)' }, true)
      window.addEventListener('mouseup', () => { dot.style.transform = 'translate(-50%,-50%) scale(1)' }, true)
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install)
    else install()
  })
  const page = await context.newPage()
  return { context, page }
}

async function moveClick(page, locator) {
  const box = await locator.boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
  await locator.click()
}

async function scrollTo(page, locator) {
  await locator.scrollIntoViewIfNeeded()
  await hold(page, 500)
}

async function saveVideo(page, context, name) {
  const video = page.video()
  await page.close()
  if (video) await video.saveAs(path.join(DIR, `${name}.webm`))
  await context.close()
}

async function cover() {
  const { context, page } = await newPage()
  await page.goto('file:///C:/Projects/deepfake-platform/demo_data/demo_cover.html', { waitUntil: 'load' })
  await hold(page, 5000)
  await saveVideo(page, context, '01_cover')
}

async function detection(name, file) {
  const { context, page } = await newPage()
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
  await page.waitForSelector('.status-pill.ok', { timeout: 15000 })
  await hold(page, 1200)
  await moveClick(page, page.getByRole('tab', { name: /视频检测/ }))
  await hold(page, 800)
  await page.locator('input[type=file][accept*="video"]').setInputFiles(file)
  await hold(page, 800)
  await page.locator('.consent input').check()
  await page.locator('input[name="video-model"][value="realforensics-ff"]').check()
  await hold(page, 500)
  await moveClick(page, page.locator('button.primary').first())
  await page.waitForFunction(() => !!document.querySelector('.verdict-card') || !!document.querySelector('.result-failed'), null, { timeout: 120000 })
  await hold(page, 1200)
  await scrollTo(page, page.locator('.verdict-card'))
  await hold(page, 5000)
  await saveVideo(page, context, name)
}

async function videoSwap() {
  const { context, page } = await newPage()
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
  await page.waitForSelector('.status-pill.ok', { timeout: 15000 })
  await hold(page, 1200)
  await moveClick(page, page.getByRole('tab', { name: /视频换脸/ }))
  await hold(page, 900)
  await page.locator('input[type=file][accept*="image"]').first().setInputFiles(SOURCE)
  await hold(page, 700)
  await page.locator('input[type=file][accept*="video"]').setInputFiles(REAL)
  await hold(page, 900)
  await page.locator('.consent input').check()
  await page.waitForFunction(() => {
    const b = document.querySelector('button.primary')
    return b && !b.disabled
  }, null, { timeout: 15000 })
  await hold(page, 500)
  await moveClick(page, page.locator('button.primary').first())
  await page.waitForFunction(() => !!document.querySelector('.video-result') || !!document.querySelector('.result-failed'), null, { timeout: 120000 })
  await hold(page, 1200)
  await scrollTo(page, page.locator('.video-result'))
  await hold(page, 5000)
  await saveVideo(page, context, '04_video_faceswap')
}

async function videoDefense() {
  const { context, page } = await newPage()
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
  await page.waitForSelector('.status-pill.ok', { timeout: 15000 })
  await hold(page, 1200)
  await moveClick(page, page.getByRole('tab', { name: /视频防御/ }))
  await hold(page, 900)
  await page.locator('input[type=file][accept*="video"]').setInputFiles(REAL)
  await hold(page, 800)
  await page.locator('.consent input').check()
  await hold(page, 500)
  await moveClick(page, page.locator('button.primary').first())
  await page.waitForFunction(() => !!document.querySelector('.compare-grid') || !!document.querySelector('.result-failed'), null, { timeout: 420000 })
  await hold(page, 1200)
  await scrollTo(page, page.locator('.compare-grid'))
  await hold(page, 6000)
  await saveVideo(page, context, '05_video_defense')
}

try {
  await cover()
  await detection('02_fake_detection', FAKE)
  await detection('03_real_detection', REAL)
  await videoSwap()
  await videoDefense()
  console.log('SEGMENTS_DONE')
} finally {
  await browser.close()
}
