import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const OUT = 'C:\\Projects\\deepfake-platform\\demo_data\\demo-recording.webm'
const VIDEO_DIR = 'C:\\Projects\\deepfake-platform\\demo_data\\recording'
const FAKE = 'C:\\Projects\\deepfake-platform\\demo_data\\demo_clips\\fake_child_man.mp4'
const REAL = 'C:\\Projects\\deepfake-platform\\demo_data\\demo_clips\\real_phone.mp4'
const SOURCE = 'C:\\Projects\\deepfake-platform\\demo_data\\source_jay.jpg'
fs.mkdirSync(VIDEO_DIR, { recursive: true })

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 1000 } },
})
await context.addInitScript(() => {
  const install = () => {
    if (document.getElementById('__demo_cursor')) return
    const dot = document.createElement('div')
    dot.id = '__demo_cursor'
    dot.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:22px', 'height:22px',
      'border-radius:50%', 'background:rgba(122,92,245,.32)',
      'border:2px solid rgba(122,92,245,.95)', 'box-shadow:0 0 0 8px rgba(122,92,245,.12)',
      'pointer-events:none', 'z-index:2147483647', 'transform:translate(-50%,-50%)',
      'transition:transform .08s ease', 'display:none',
    ].join(';')
    document.documentElement.appendChild(dot)
    const move = (e) => {
      dot.style.display = 'block'
      dot.style.left = `${e.clientX}px`
      dot.style.top = `${e.clientY}px`
    }
    window.addEventListener('mousemove', move, true)
    window.addEventListener('mousedown', () => { dot.style.transform = 'translate(-50%,-50%) scale(.82)' }, true)
    window.addEventListener('mouseup', () => { dot.style.transform = 'translate(-50%,-50%) scale(1)' }, true)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install)
  else install()
})

const page = await context.newPage()
const hold = async (ms) => page.waitForTimeout(ms)
const moveClick = async (locator) => {
  const box = await locator.boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
  await locator.click()
}
const scrollTo = async (locator) => {
  await locator.scrollIntoViewIfNeeded()
  await hold(500)
}
const submitAndWait = async (waitSelector, timeout = 240000) => {
  const button = page.locator('button.primary').first()
  await scrollTo(button)
  await hold(400)
  await moveClick(button)
  await page.waitForFunction((sel) => !!document.querySelector(sel) || !!document.querySelector('.result-failed'), waitSelector, { timeout })
  await hold(1200)
}

try {
  await page.goto('file:///C:/Projects/deepfake-platform/demo_data/demo_cover.html', { waitUntil: 'load' })
  await hold(5000)

  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
  await page.waitForSelector('.status-pill.ok', { timeout: 15000 })
  await hold(1800)

  // 1) Dataset fake video -> detection
  await moveClick(page.getByRole('tab', { name: /视频检测/ }))
  await hold(800)
  await page.locator('input[type=file][accept*="video"]').setInputFiles(FAKE)
  await hold(1200)
  await page.locator('.consent input').check()
  await page.locator('input[name="video-model"][value="realforensics-ff"]').check()
  await hold(500)
  await submitAndWait('.verdict-card')
  await scrollTo(page.locator('.verdict-card'))
  await hold(5000)
  await scrollTo(page.locator('.video-contact img'))
  await hold(6000)

  // 2) Real phone video -> detection
  await moveClick(page.getByRole('button', { name: '再检测一段' }))
  await hold(800)
  await page.locator('input[type=file][accept*="video"]').setInputFiles(REAL)
  await hold(1000)
  await page.locator('.consent input').check()
  await page.locator('input[name="video-model"][value="realforensics-ff"]').check()
  await hold(400)
  await submitAndWait('.verdict-card')
  await scrollTo(page.locator('.verdict-card'))
  await hold(5000)

  // 3) Video face swap
  await moveClick(page.getByRole('tab', { name: /视频换脸/ }))
  await hold(1200)
  await page.locator('input[type=file][accept*="image"]').first().setInputFiles(SOURCE)
  await hold(800)
  await page.locator('input[type=file][accept*="video"]').setInputFiles(REAL)
  await hold(1000)
  await page.locator('input[name="video-swap-model"][value="hyperswap-256"]').check()
  await page.locator('.consent input').check()
  await hold(500)
  await submitAndWait('.video-result', 180000)
  await scrollTo(page.locator('.video-result'))
  await hold(5000)

  // 4) Protect the real phone video
  await moveClick(page.getByRole('tab', { name: /视频防御/ }))
  await hold(1200)
  await page.locator('input[type=file][accept*="video"]').setInputFiles(REAL)
  await hold(1000)
  await page.locator('.consent input').check()
  await hold(500)
  await submitAndWait('.compare-grid', 420000)
  await scrollTo(page.locator('.compare-grid'))
  await hold(8000)
  await scrollTo(page.locator('.video-result'))
  await hold(3000)
} finally {
  const video = page.video()
  await page.close()
  await context.close()
  await browser.close()
  if (video) await video.saveAs(OUT)
  console.log('SAVED', OUT, fs.statSync(OUT).size)
}
