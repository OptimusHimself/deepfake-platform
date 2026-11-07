import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } })
page.on('console', m => console.log('CONSOLE', m.text()))
page.on('requestfailed', r => console.log('FAILED', r.url(), r.failure()?.errorText))
await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
await page.getByRole('tab', { name: / ”∆µºÏ≤‚/ }).click()
await page.waitForTimeout(1500)
console.log('history', await page.locator('.history-item').count())
if (await page.locator('.history-item').count()) {
  await page.locator('.history-item').first().click()
  await page.waitForTimeout(2000)
}
console.log('imgs', await page.locator('.video-contact img').count())
if (await page.locator('.video-contact img').count()) console.log('src', await page.locator('.video-contact img').first().getAttribute('src'))
await browser.close()
