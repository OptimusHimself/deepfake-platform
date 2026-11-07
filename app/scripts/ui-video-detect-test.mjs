import { chromium } from 'playwright-core'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const VIDEO = process.env.VIDEO || 'C:\\Projects\\deepfake-platform\\.ssh_tmp\\video_models\\talking_test.mp4'
const MODEL = process.env.MODEL || 'auto'

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } })
page.on('pageerror', (err) => console.log('PAGEERROR', err.message))

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
await page.waitForSelector('.status-pill.ok', { timeout: 15000 })
await page.getByRole('tab', { name: /视频检测/ }).click()
await page.waitForSelector('input[type=file][accept*="video"]', { state: 'attached' })
await page.locator('input[type=file][accept*="video"]').setInputFiles(VIDEO)
if (MODEL !== 'auto') {
  await page.locator(`input[name="video-model"][value="${MODEL}"]`).check()
}
await page.locator('.consent input').check()
await page.waitForFunction(() => {
  const button = document.querySelector('button.primary')
  return button && !button.disabled
}, null, { timeout: 15000 })
await page.click('button.primary')
await page.waitForFunction(() => !!document.querySelector('.verdict-card') || !!document.querySelector('.result-failed'), null, { timeout: 120000 })
console.log('VERDICT', (await page.textContent('.verdict-card'))?.replace(/\s+/g, ' '))
await page.waitForTimeout(1500)
console.log('CONTACT', await page.locator('.video-contact img').count())
await page.screenshot({ path: 'C:\\Projects\\deepfake-platform\\app\\data\\ui-video-detect.png', fullPage: true })
await browser.close()
