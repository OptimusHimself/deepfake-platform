import { chromium } from 'playwright-core'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SOURCE = 'C:\\Projects\\deepfake-platform\\demo_data\\source_jay.jpg'
const VIDEO = 'C:\\Projects\\deepfake-platform\\demo_data\\demo_clips\\real_phone.mp4'

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } })
page.on('pageerror', (err) => console.log('PAGEERROR', err.message))

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
await page.waitForSelector('.status-pill.ok', { timeout: 15000 })
await page.getByRole('tab', { name: /视频换脸/ }).click()
await page.waitForSelector('input[type=file][accept*="image"]', { state: 'attached' })
await page.locator('input[type=file][accept*="image"]').first().setInputFiles(SOURCE)
await page.locator('input[type=file][accept*="video"]').setInputFiles(VIDEO)
await page.locator('.consent input').check()
await page.waitForFunction(() => {
  const button = document.querySelector('button.primary')
  return button && !button.disabled
}, null, { timeout: 15000 })
await page.click('button.primary')
await page.waitForFunction(() => !!document.querySelector('.video-result') || !!document.querySelector('.result-failed'), null, { timeout: 120000 })
await page.waitForTimeout(1000)
console.log('RESULT', (await page.textContent('.result-content'))?.replace(/\s+/g, ' ').slice(0, 300))
await page.screenshot({ path: 'C:\\Projects\\deepfake-platform\\app\\data\\ui-video-faceswap.png', fullPage: true })
await browser.close()
