import { chromium } from 'playwright-core'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SOURCE = process.env.SOURCE || 'C:\\Projects\\deepfake-platform\\.ssh_tmp\\faces\\man_0.jpeg'
const TARGET = process.env.TARGET || 'C:\\Projects\\deepfake-platform\\.ssh_tmp\\faces\\man_2.jpeg'

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })
page.on('pageerror', (err) => console.log('PAGEERROR', err.message))

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
await page.waitForSelector('.status-pill.ok', { timeout: 15000 })
await page.getByRole('tab', { name: /图片换脸/ }).click()
await page.waitForSelector('.image-drop input[type=file]', { state: 'attached' })
const inputs = page.locator('.image-drop input[type=file]')
await inputs.nth(0).setInputFiles(SOURCE)
await inputs.nth(1).setInputFiles(TARGET)
await page.locator('.consent input').check()
await page.waitForFunction(() => {
  const button = document.querySelector('button.primary')
  return button && !button.disabled
}, null, { timeout: 15000 })
await page.click('button.primary')
await page.waitForSelector('.image-result img', { timeout: 120000 })
const src = await page.locator('.image-result img').getAttribute('src')
console.log('RESULT_SRC', src)
await page.screenshot({ path: 'C:\\Projects\\deepfake-platform\\app\\data\\ui-faceswap.png', fullPage: true })
await browser.close()
