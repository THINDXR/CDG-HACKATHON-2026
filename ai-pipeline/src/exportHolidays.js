/*
 * ส่งออกวันหยุดดิบให้เว็บ RoadWarn ใช้
 *
 * ส่งเฉพาะ "ข้อมูลดิบ" (วันที่ + ชื่อ + เป็นวันหยุดราชการหรือไม่) ไม่ส่ง feature ที่คำนวณแล้ว
 * เพราะฝั่งเว็บต้องคำนวณ feature ของ "วันในอนาคต" ซึ่ง panel.csv ไม่มี
 * ตรรกะการคำนวณถูกพอร์ตไปไว้ที่ js/ai-holidays.js ของเว็บ ให้ตรงกับ
 * buildHolidayFeatures() ใน src/sources/holidays.js
 *
 *     node src/exportHolidays.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchHolidays } from './sources/holidays.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// ai-pipeline อยู่ใต้ repo ของเว็บ โฟลเดอร์แม่จึงเป็น root ของเว็บอยู่แล้ว
const OUT_DIR = path.join(path.dirname(ROOT), 'data', 'ai')

const holidays = await fetchHolidays()

const entries = [...holidays.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([date, info]) => [date, info.name, info.isPublic ? 1 : 0])

fs.mkdirSync(OUT_DIR, { recursive: true })
const file = path.join(OUT_DIR, 'holidays.json')
fs.writeFileSync(
  file,
  JSON.stringify({ generated_at: new Date().toISOString(), holidays: entries }),
  'utf8',
)

const publicCount = entries.filter((e) => e[2] === 1).length
const years = [...new Set(entries.map((e) => e[0].slice(0, 4)))].sort()
console.log(`เขียน ${file}`)
console.log(`  ${entries.length} รายการ (วันหยุดราชการ ${publicCount}) ปี ${years[0]}–${years[years.length - 1]}`)
