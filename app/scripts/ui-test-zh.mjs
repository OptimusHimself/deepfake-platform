import { chromium } from 'playwright-core'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const AUDIO = 'C:\\Projects\\deepfake-platform\\.ssh_tmp\\clone.wav'
const REF_TEXT = 'Okay. Yeah. I resent you. I love you. I respect you. But you know what? You blew it! And thanks to you.'
const TARGET = '大家好，这是通过本地网页上传参考音频后生成的克隆语音，用于测试中文目标文本。'

const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1300 } })
page.on('pageerror', (err) => console.log('PAGEERROR', err.message))

await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle' })
await page.waitForSelector('.status-pill.ok', { timeout: 15000 })
await page.setInputFiles('#audio-input', AUDIO)
await page.fill('#reference-text', REF_TEXT)
await page.fill('#target-text', TARGET)
await page.selectOption('#language', 'Chinese')
await page.check('.consent input')
await page.waitForFunction(() => {
  const button = document.querySelector('button.primary')
  return button && !button.disabled
}, null, { timeout: 10000 })
await page.click('button.primary')
await page.waitForFunction(() => {
  return !!document.querySelector('.player-card audio') || !!document.querySelector('.result-failed')
}, null, { timeout: 120000 })
console.log('BADGE', await page.textContent('.job-badge'))
console.log('TARGET_FIELD', await page.inputValue('#target-text'))
console.log('AUDIO_SRC', await page.getAttribute('.player-card audio', 'src'))
await page.screenshot({ path: 'C:\\Projects\\deepfake-platform\\app\\data\\ui-result-zh.png', fullPage: true })
await browser.close()
