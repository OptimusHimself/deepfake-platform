import { chromium } from 'playwright-core'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const AUDIO = process.env.AUDIO || 'C:\\Projects\\deepfake-platform\\.ssh_tmp\\api_result_zh.wav'
const MODEL = process.env.MODEL || 'auto'

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1300 } })
page.on('pageerror', (err) => console.log('PAGEERROR', err.message))

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
await page.waitForSelector('.status-pill.ok', { timeout: 15000 })
await page.getByRole('tab', { name: /音频检测/ }).click()
await page.waitForSelector('#detect-audio-input', { state: 'attached', timeout: 5000 })
await page.setInputFiles('#detect-audio-input', AUDIO)
if (MODEL !== 'auto') {
  await page.locator(`input[name="detect-model"][value="${MODEL}"]`).check()
}
await page.locator('.consent input').check()
await page.waitForFunction(() => {
  const button = document.querySelector('button.primary')
  return button && !button.disabled
}, null, { timeout: 15000 })
await page.click('button.primary')
await page.waitForFunction(() => {
  return !!document.querySelector('.verdict-card') || !!document.querySelector('.result-failed')
}, null, { timeout: 120000 })
console.log('VERDICT', await page.textContent('.verdict-card'))
console.log('PAGE_HAS_TIMELINE', await page.locator('.timeline-card').count())
await page.screenshot({ path: 'C:\\Projects\\deepfake-platform\\app\\data\\ui-detect.png', fullPage: true })
await browser.close()
