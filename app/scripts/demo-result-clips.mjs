import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const DIR = 'C:\\Projects\\deepfake-platform\\demo_data\\segments'
fs.mkdirSync(DIR, { recursive: true })
const browser = await chromium.launch({ executablePath: CHROME, headless: true })

async function capture(name, tab, readySelector) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, recordVideo: { dir: DIR, size: { width: 1440, height: 1000 } } })
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
  await page.waitForSelector('.status-pill.ok', { timeout: 15000 })
  await page.getByRole('tab', { name: tab }).click()
  await page.waitForTimeout(1200)
  const item = page.locator('.history-item').first()
  await item.waitFor({ state: 'visible', timeout: 15000 })
  await item.click()
  await page.waitForSelector(readySelector, { timeout: 20000 })
  await page.waitForTimeout(1000)
  await page.locator(readySelector).first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(6000)
  const video = page.video()
  await page.close()
  if (video) await video.saveAs(path.join(DIR, `${name}.webm`))
  await context.close()
}

try {
  await capture('06_faceswap_result', /视频换脸/, '.video-result')
  await capture('07_defense_result', /视频防御/, '.compare-grid')
  console.log('RESULT_CLIPS_DONE')
} finally {
  await browser.close()
}
