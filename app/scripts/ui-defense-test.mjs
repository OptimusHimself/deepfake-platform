import { chromium } from 'playwright-core'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const IMAGE = process.env.IMAGE || 'C:\\Projects\\deepfake-platform\\.ssh_tmp\\faces\\man_2.jpeg'

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } })
page.on('pageerror', (err) => console.log('PAGEERROR', err.message))

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
await page.waitForSelector('.status-pill.ok', { timeout: 15000 })
await page.getByRole('tab', { name: /主动防御/ }).click()
await page.waitForSelector('.image-drop input[type=file]', { state: 'attached' })
await page.locator('.image-drop input[type=file]').setInputFiles(IMAGE)
await page.locator('.consent input').check()
await page.waitForFunction(() => {
  const button = document.querySelector('button.primary')
  return button && !button.disabled
}, null, { timeout: 15000 })
await page.click('button.primary')
await page.waitForSelector('.protection-grid', { timeout: 180000 })
console.log('METRICS', await page.textContent('.protection-grid'))
await page.screenshot({ path: 'C:\\Projects\\deepfake-platform\\app\\data\\ui-defense.png', fullPage: true })
await browser.close()
