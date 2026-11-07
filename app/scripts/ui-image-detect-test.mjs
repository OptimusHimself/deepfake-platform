import { chromium } from 'playwright-core'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const IMAGE = process.env.IMAGE || 'C:\\Projects\\deepfake-platform\\.ssh_tmp\\faces\\bff_result.png'
const OUT = process.env.OUT || 'C:\\Projects\\deepfake-platform\\app\\data\\ui-image-detect.png'

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1500 } })
page.on('pageerror', (err) => console.log('PAGEERROR', err.message))

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
await page.waitForSelector('.status-pill.ok', { timeout: 15000 })
await page.getByRole('tab', { name: /图片检测/ }).click()
await page.waitForSelector('#image-detect-input', { state: 'attached' })
await page.setInputFiles('#image-detect-input', IMAGE)
await page.locator('.consent input').check()
await page.waitForFunction(() => {
  const button = document.querySelector('button.primary')
  return button && !button.disabled
}, null, { timeout: 15000 })
await page.click('button.primary')
await page.waitForFunction(() => !!document.querySelector('.verdict-card') || !!document.querySelector('.result-failed'), null, { timeout: 120000 })
console.log('VERDICT', (await page.textContent('.verdict-card'))?.replace(/\s+/g, ' '))
console.log('HAS_IMAGE', await page.locator('.detect-image-result img').count())
await page.screenshot({ path: OUT, fullPage: true })
await browser.close()
