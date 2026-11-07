import { chromium } from 'playwright-core'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const AUDIO = process.env.AUDIO || 'C:\\Projects\\deepfake-platform\\.ssh_tmp\\clone.wav'
const REF_TEXT = 'Okay. Yeah. I resent you. I love you. I respect you. But you know what? You blew it! And thanks to you.'
const TARGET = process.env.TARGET || 'This is a browser UI test for the local deepfake platform.'

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1300 } })
page.on('pageerror', (err) => console.log('PAGEERROR', err.message))
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('CONSOLE', msg.text())
})

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
await page.waitForSelector('.status-pill.ok', { timeout: 15000 })
console.log('STATUS', await page.textContent('.status-pill'))

await page.setInputFiles('#audio-input', AUDIO)
await page.fill('#reference-text', REF_TEXT)
await page.fill('#target-text', TARGET)
await page.check('.consent input')
await page.waitForFunction(() => {
  const button = document.querySelector('button.primary')
  return button && !button.disabled
}, null, { timeout: 10000 })
console.log('FORM_READY')

await page.click('button.primary')
await page.waitForFunction(() => {
  return !!document.querySelector('.player-card audio') || !!document.querySelector('.result-failed')
}, null, { timeout: 120000 })

const badge = await page.textContent('.job-badge')
console.log('JOB_BADGE', badge)
const audioSrc = await page.getAttribute('.player-card audio', 'src')
console.log('AUDIO_SRC', audioSrc)
await page.screenshot({ path: 'C:\\Projects\\deepfake-platform\\app\\data\\ui-result.png', fullPage: true })

if (await page.locator('button:has-text("保存到下载文件夹")').count()) {
  await page.click('button:has-text("保存到下载文件夹")')
  await page.waitForSelector('.saved-path', { timeout: 15000 })
  console.log('SAVED', await page.textContent('.saved-path'))
}

await browser.close()
