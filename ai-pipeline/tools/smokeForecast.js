/*
 * ทดสอบสายพยากรณ์ทั้งเส้นแบบไม่ต้องเปิดเบราว์เซอร์
 *
 * verifyWebModel.js ตรวจแค่ว่า "เดินต้นไม้ถูก" แต่ยังไม่ได้ตอบว่า
 * ฝั่งแอปประกอบ feature ครบหรือเปล่า — ถ้าลืมสร้าง feature สักตัว
 * โมเดลจะรับเป็น missing แล้วทำนายออกมาได้ปกติ ไม่มีอะไรฟ้อง
 *
 * สคริปต์นี้จึงรัน ai-holidays.js + ai-forecast.js ของจริง โดยปลอมแค่
 * window / fetch / localStorage แล้วเช็คสามข้อ:
 *   1. feature ที่โมเดลต้องการ ต้องมีค่าครบทุกตัว
 *   2. ผลทำนายต้องอยู่ในช่วงที่เป็นไปได้
 *   3. ฟีเจอร์วันหยุดต้องตรงกับที่ pipeline คำนวณ (เทียบกับ panel.csv จริง)
 *
 *     node tools/smokeForecast.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// ai-pipeline อยู่ใต้ repo ของเว็บ โฟลเดอร์แม่จึงเป็น root ของเว็บ
const WEB = path.dirname(ROOT)

const read = (p) => JSON.parse(fs.readFileSync(path.join(WEB, 'data', 'ai', p), 'utf8'))
const model = read('model.json')
const holidays = read('holidays.json')
const provincesDoc = read('provinces.json')

/* ---------- ปลอมสภาพแวดล้อมเบราว์เซอร์เท่าที่โค้ดใช้จริง ---------- */

globalThis.window = {}
globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.get(k) ?? null },
  setItem(k, v) { this.store.set(k, v) },
}

/*
 * อากาศ: ปลอมค่าคงที่แทนการยิง Open-Meteo จริง
 * เพราะการทดสอบต้องได้ผลเดิมทุกครั้ง ไม่ขึ้นกับพยากรณ์ของวันนั้น
 * (และไม่กินโควตา API ซึ่งเป็นคอขวดของโปรเจกต์นี้อยู่แล้ว)
 */
const RAIN_MM = 12.4
function fakeWeather() {
  const daily = {
    time: [], precipitation_sum: [], rain_sum: [], precipitation_hours: [],
    temperature_2m_max: [], temperature_2m_min: [], windspeed_10m_max: [],
  }
  const start = new Date()
  start.setUTCDate(start.getUTCDate() - 2)
  for (let i = 0; i < 10; i++) {
    const d = new Date(start)
    d.setUTCDate(d.getUTCDate() + i)
    daily.time.push(d.toISOString().slice(0, 10))
    daily.precipitation_sum.push(RAIN_MM)
    daily.rain_sum.push(RAIN_MM)
    daily.precipitation_hours.push(6)
    daily.temperature_2m_max.push(34.2)
    daily.temperature_2m_min.push(25.1)
    daily.windspeed_10m_max.push(18.5)
  }
  return { daily }
}

globalThis.fetch = async (url) => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body })
  if (url.includes('model.json')) return ok(model)
  if (url.includes('holidays.json')) return ok(holidays)
  if (url.includes('provinces.json')) return ok(provincesDoc)
  if (url.includes('open-meteo')) return ok(fakeWeather())
  throw new Error(`ไม่รู้จัก URL: ${url}`)
}

const load = (f) => import(pathToFileURL(path.join(WEB, 'js', f)).href)
await load('utils.js')
await load('ai-model.js')
await load('ai-holidays.js')
await load('ai-forecast.js')

const { AIModel, AIHolidays, AIForecast } = globalThis.window

let failures = 0
const fail = (msg) => { console.error(`  ✗ ${msg}`); failures++ }
const pass = (msg) => console.log(`  ✓ ${msg}`)

/* ---------- 1. feature ครบหรือไม่ ---------- */

console.log('\n1) feature ที่โมเดลต้องการ')
await AIForecast.init()
const bangkok = AIForecast.provinceAt([100.5331, 13.7465])
if (!bangkok) fail('หาจังหวัดจากพิกัดกรุงเทพฯ ไม่ได้')
else pass(`หาจังหวัดจากพิกัดได้: ${bangkok.name}`)

const result = await AIForecast.forecastProvince(bangkok)
const missing = AIModel.missingFeatures(result.features)
if (missing.length) fail(`feature ขาด ${missing.length} ตัว: ${missing.join(', ')}`)
else pass(`ครบทั้ง ${model.features.length} ตัว ไม่มีตัวไหนตกเป็น missing`)

/* ---------- 2. ผลทำนายสมเหตุสมผลหรือไม่ ---------- */

console.log('\n2) ผลทำนาย')
console.log(`  ${result.province} ${result.date} — ${(result.probability * 100).toFixed(1)}% ` +
  `(${result.level.label}) คาดว่า ${result.expectedCount.toFixed(2)} ครั้ง`)
for (const r of result.reasons) console.log(`    · ${r.text}`)

if (!(result.probability > 0 && result.probability < 1)) fail('ความน่าจะเป็นหลุดช่วง 0-1')
else pass('ความน่าจะเป็นอยู่ในช่วง 0-1')
if (!(result.expectedCount >= 0 && result.expectedCount < 100)) fail('จำนวนครั้งที่คาดไม่สมเหตุสมผล')
else pass('จำนวนครั้งที่คาดอยู่ในช่วงที่เป็นไปได้')
// ปลอมให้ฝนตก 12.4 มม. ซึ่งเกินเกณฑ์ 5 มม. ที่ SHAP ชี้ว่าเริ่มมีผล
if (!result.reasons.some((r) => r.text.includes('ฝน'))) fail('ฝน 12.4 มม. แต่ไม่ขึ้นเป็นเหตุผล')
else pass('ฝนเกินเกณฑ์ถูกยกมาเป็นเหตุผล')

// ระดับต้องเทียบกับวันธรรมดาของจังหวัด ไม่ใช่เกณฑ์ตายตัว
// (กรุงเทพฯ ได้ 99% ทุกวัน ถ้าใช้เกณฑ์ตายตัวจะขึ้น "เสี่ยงสูง" ตลอดจนไร้ความหมาย)
if (result.level.ratio == null) fail('ไม่ได้ใช้ค่าอ้างอิงรายจังหวัด — level.ratio หายไป')
else pass(`ระดับเทียบกับวันธรรมดาของจังหวัด (ratio ${result.level.ratio.toFixed(2)})`)

const week = await AIForecast.forecastWeek([100.5331, 13.7465], 7)
if (week.length !== 7) fail(`พยากรณ์ 7 วันได้มา ${week.length} วัน`)
else pass('พยากรณ์ล่วงหน้าได้ครบ 7 วัน')
if (new Set(week.map((d) => d.date)).size !== 7) fail('วันที่ซ้ำกันในชุด 7 วัน')
else pass('วันที่ไม่ซ้ำกัน')

/*
 * แถบ 7 วันต้องแยกวันออกจากกันได้จริง
 *
 * อากาศในเทสต์นี้ปลอมให้เท่ากันทุกวัน ความต่างที่เหลือจึงมาจากปฏิทินล้วน ๆ
 * (วันในสัปดาห์ วันหยุด ฤดูกาล) ถ้าทุกวันออกมาเท่ากันเป๊ะ แปลว่าฟีเจอร์กลุ่มนั้น
 * ไม่ได้ถูกส่งเข้าโมเดลจริง — แถบจะเรียบเท่ากันหมดและไม่มีประโยชน์
 */
const counts = week.map((d) => d.expectedCount)
const spread = (Math.max(...counts) - Math.min(...counts)) / Math.max(...counts)
console.log('  7 วัน: ' + week.map((d) => `${d.date.slice(5)} ${d.expectedCount.toFixed(1)}`).join(' · '))
if (spread < 0.02) fail(`ทุกวันได้ค่าเกือบเท่ากัน (ต่างกัน ${(spread * 100).toFixed(1)}%) — ปฏิทินอาจไม่ถูกส่งเข้าโมเดล`)
else pass(`แต่ละวันต่างกันจริง (ช่วงกว้าง ${(spread * 100).toFixed(0)}% ของวันที่สูงสุด)`)

/* ---------- 3. ฟีเจอร์วันหยุดตรงกับ pipeline หรือไม่ ---------- */

console.log('\n3) ฟีเจอร์วันหยุดเทียบกับ panel.csv ที่ pipeline สร้าง')
const panel = path.join(ROOT, 'data', 'processed', 'panel.csv')
if (!fs.existsSync(panel)) {
  console.log('  (ข้าม — ยังไม่มี panel.csv)')
} else {
  const lines = fs.readFileSync(panel, 'utf8').split('\n')
  const header = lines[0].split(',')
  const cols = [
    'is_public_holiday', 'is_observance', 'is_weekend', 'is_holiday_eve',
    'is_songkran', 'is_newyear', 'is_seven_dangerous_days',
    'day_off_run_length', 'is_long_weekend',
    'days_to_next_holiday', 'days_since_prev_holiday',
    'dow', 'month', 'days_since_start',
  ]
  const idx = Object.fromEntries(cols.map((c) => [c, header.indexOf(c)]))
  const dateIdx = header.indexOf('date')

  // สุ่มตรวจ 400 แถวกระจายทั้งไฟล์ ครอบคลุมทุกฤดูและทุกเทศกาล
  const step = Math.floor((lines.length - 2) / 400)
  let checked = 0
  let mismatched = 0
  for (let i = 1; i < lines.length - 1; i += step) {
    const cells = lines[i].split(',')
    const date = cells[dateIdx]
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const js = AIHolidays.featuresFor(date, '2022-01-01')
    checked++
    for (const c of cols) {
      const expected = cells[idx[c]]
      const got = js[c]
      const same = expected === '' ? got === null : Number(expected) === Number(got)
      if (!same) {
        if (mismatched < 5) console.error(`  ✗ ${date} ${c}: panel=${expected} js=${got}`)
        mismatched++
      }
    }
  }
  if (mismatched) fail(`ไม่ตรง ${mismatched} ช่อง จาก ${checked} วันที่ตรวจ`)
  else pass(`ตรงทุกช่อง จาก ${checked} วันที่สุ่มตรวจ (${cols.length} ฟีเจอร์)`)
}

console.log(failures === 0 ? '\nผ่านทั้งหมด' : `\nไม่ผ่าน ${failures} ข้อ`)
process.exit(failures === 0 ? 0 : 1)
