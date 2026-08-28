/*
 * ตรวจว่าตัวรันโมเดลฝั่งเบราว์เซอร์ให้ผลตรงกับ XGBoost ฝั่ง Python
 *
 * นี่คือจุดที่พังเงียบได้ง่ายที่สุดของทั้งงาน — ถ้าเดินต้นไม้ผิด หรือแปลง
 * base_score ผิด ตัวเลขที่ออกมาจะยังดู "สมเหตุสมผล" อยู่ แต่ผิดทั้งหมด
 * จึงต้องเทียบกับค่าที่ XGBoost คำนวณเองบน feature vector ชุดเดียวกัน
 *
 *     python train/export_web.py     # สร้าง model.json + web_validation.json ก่อน
 *     node tools/verifyWebModel.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// ai-pipeline อยู่ใต้ repo ของเว็บ โฟลเดอร์แม่จึงเป็น root ของเว็บ
const WEB = path.dirname(ROOT)

const modelDoc = JSON.parse(fs.readFileSync(path.join(WEB, 'data', 'ai', 'model.json'), 'utf8'))
const cases = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'train', 'artifacts', 'web_validation.json'), 'utf8'),
)

// ai-model.js เขียนไว้ให้รันในเบราว์เซอร์ — ปลอม window กับ fetch ให้มันพอทำงานได้
globalThis.window = {}
globalThis.fetch = async () => ({ ok: true, json: async () => modelDoc })

// บน Windows ต้องแปลงเป็น file:// ก่อน ไม่งั้น import() ปฏิเสธ path ที่ขึ้นต้นด้วย C:
await import(pathToFileURL(path.join(WEB, 'js', 'ai-model.js')).href)
const AIModel = globalThis.window.AIModel
await AIModel.load()

// เกณฑ์นี้หลวมกว่า float32 ของ XGBoost เล็กน้อย เพราะ JS คำนวณด้วย float64
// ต่างกันระดับนี้ไม่มีผลต่อ % ที่โชว์ผู้ใช้ แต่ถ้าเดินต้นไม้ผิดจะต่างเป็นหลักสิบเท่า
const TOLERANCE = 1e-5

let worstRaw = 0
let worstCalibrated = 0
let worstCount = 0
let failures = 0

for (const c of cases) {
  const got = AIModel.predict(c.x)
  const dRaw = Math.abs(got.rawProbability - c.raw)
  const dCal = Math.abs(got.probability - c.calibrated)
  // จำนวนครั้งเป็นค่าไม่ถูกจำกัดช่วง จึงเทียบแบบสัมพัทธ์
  const dCount = Math.abs(got.expectedCount - c.count) / Math.max(c.count, 1e-6)

  worstRaw = Math.max(worstRaw, dRaw)
  worstCalibrated = Math.max(worstCalibrated, dCal)
  worstCount = Math.max(worstCount, dCount)

  if (dRaw > TOLERANCE || dCal > TOLERANCE || dCount > 1e-4) {
    failures++
    if (failures <= 5) {
      console.error(
        `ไม่ตรง: ${c.province} ${c.date}\n` +
          `  raw        python ${c.raw.toFixed(8)}  js ${got.rawProbability.toFixed(8)}\n` +
          `  calibrated python ${c.calibrated.toFixed(8)}  js ${got.probability.toFixed(8)}\n` +
          `  count      python ${c.count.toFixed(6)}  js ${got.expectedCount.toFixed(6)}`,
      )
    }
  }
}

console.log(`ตรวจ ${cases.length} เคส`)
console.log(`  ส่วนต่างสูงสุด raw        ${worstRaw.toExponential(2)}`)
console.log(`  ส่วนต่างสูงสุด calibrated ${worstCalibrated.toExponential(2)}`)
console.log(`  ส่วนต่างสูงสุด count      ${worstCount.toExponential(2)} (สัมพัทธ์)`)

if (failures > 0) {
  console.error(`\nไม่ผ่าน ${failures}/${cases.length} เคส`)
  process.exit(1)
}
console.log('\nผ่านทั้งหมด — ฝั่งเบราว์เซอร์ให้ผลเท่ากับ XGBoost')
