/*
 * ส่งออก "จุดเสี่ยงจริง" พร้อมพิกัด ให้ RoadWarn เอาไปปักบนแผนที่
 *
 * ต่างจาก src/build/hotspots.js ตรงที่ไฟล์นั้นส่งออกเป็น CSV สำหรับคนอ่าน
 * จึงมีแค่ "สายทาง + ช่วงกิโลเมตร" ไม่มีพิกัด ปักหมุดไม่ได้
 * ที่นี่จึงจัดกลุ่มใหม่พร้อมเก็บพิกัดเฉลี่ยของแต่ละกลุ่มไปด้วย
 *
 * ขั้นนี้ **ไม่ต้องใช้ข้อมูลอากาศ** จึงรันได้เลยแม้ panel.csv จะยังสร้างไม่ได้
 * — ใช้แค่ CSV อุบัติเหตุของ MOT ที่ cache ไว้แล้ว
 *
 *     node tools/exportHotspots.js
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProvinces } from '../src/build/provinces.js'
import { makeProvinceResolver } from '../src/lib/provinceResolve.js'
import { fetchAllMot } from '../src/sources/motAccident.js'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// ai-pipeline อยู่ใต้ repo ของเว็บ โฟลเดอร์แม่จึงเป็น root ของเว็บอยู่แล้ว
const OUT_DIR = path.join(path.dirname(ROOT), 'data', 'ai')

// จัดกลุ่มด้วยกริดละเอียดประมาณ 500 เมตร (0.005 องศา ≈ 550 ม. ที่ละติจูดไทย)
// ถ้าหยาบกว่านี้จุดคนละแยกจะถูกยุบรวมกัน ถ้าละเอียดกว่านี้จุดเดียวกันจะแตกเป็นหลายหมุด
const GRID = 0.005
// ต้องเกิดซ้ำอย่างน้อยเท่านี้ถึงเรียกว่า "จุดเสี่ยง" ไม่ใช่เหตุบังเอิญครั้งเดียว
const MIN_ACCIDENTS = 4
const TOP_N = 3000

const provinces = await buildProvinces()
const resolveProvince = makeProvinceResolver(
  provinces.map((p) => ({ geocode: p.geocode, name_th: p.name_th })),
)
const nameByGeocode = new Map(provinces.map((p) => [p.geocode, p.name_th]))

const { events } = await fetchAllMot(resolveProvince)
const withCoord = events.filter((e) => e.lat !== null && e.lon !== null)
console.log(`เหตุการณ์ทั้งหมด ${events.length} · มีพิกัด ${withCoord.length}`)

/** ค่าที่พบบ่อยที่สุด (ข้ามค่าว่าง) */
function mode(values) {
  const counts = new Map()
  for (const v of values) {
    if (!v) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best = null
  let bestCount = 0
  for (const [v, n] of counts) {
    if (n > bestCount) {
      bestCount = n
      best = v
    }
  }
  return best
}

const groups = new Map()
for (const e of withCoord) {
  const key = `${Math.round(e.lat / GRID)}|${Math.round(e.lon / GRID)}`
  if (!groups.has(key)) {
    groups.set(key, {
      lats: [], lons: [], geocodes: [], routes: [], geometries: [], causes: [],
      accidents: 0, dead: 0, injured: 0, rain: 0, night: 0,
      years: new Set(), latest: '',
    })
  }
  const g = groups.get(key)
  g.accidents++
  g.dead += e.dead
  g.injured += e.injuredTotal
  g.lats.push(e.lat)
  g.lons.push(e.lon)
  g.geocodes.push(e.geocode)
  g.routes.push(e.routeName || e.routeId)
  g.geometries.push(e.roadGeometryLabel)
  g.causes.push(e.cause)
  g.years.add(e.date.slice(0, 4))
  if (e.weatherReported === 'rain') g.rain++
  // ชั่วโมงมืด: ก่อน 6 โมงเช้า หรือหลัง 6 โมงเย็น
  const hour = e.time ? Number(e.time.slice(0, 2)) : null
  if (hour !== null && !Number.isNaN(hour) && (hour < 6 || hour >= 18)) g.night++
  if (e.date > g.latest) g.latest = e.date
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length

const rows = []
for (const g of groups.values()) {
  if (g.accidents < MIN_ACCIDENTS) continue
  const geocode = mode(g.geocodes)
  rows.push({
    lat: Number(mean(g.lats).toFixed(5)),
    lon: Number(mean(g.lons).toFixed(5)),
    // ถ่วงน้ำหนักเสียชีวิต 10 เท่าของบาดเจ็บ เพื่อไม่ให้จุดที่เกิดบ่อยแต่เบา
    // บดบังจุดที่เกิดไม่บ่อยแต่ถึงตาย (เกณฑ์เดียวกับ src/build/hotspots.js)
    severity: g.dead * 10 + g.injured,
    accidents: g.accidents,
    dead: g.dead,
    injured: g.injured,
    perYear: Number((g.accidents / g.years.size).toFixed(1)),
    province: nameByGeocode.get(geocode) ?? '',
    road: mode(g.routes) ?? '',
    geometry: mode(g.geometries) ?? '',
    cause: mode(g.causes) ?? '',
    rainShare: Number((g.rain / g.accidents).toFixed(2)),
    nightShare: Number((g.night / g.accidents).toFixed(2)),
    latest: g.latest,
  })
}

rows.sort((a, b) => b.severity - a.severity || b.accidents - a.accidents)
const top = rows.slice(0, TOP_N)

fs.mkdirSync(OUT_DIR, { recursive: true })
const file = path.join(OUT_DIR, 'hotspots.json')
fs.writeFileSync(
  file,
  JSON.stringify({
    generated_at: new Date().toISOString(),
    source: 'อุบัติเหตุบนโครงข่ายถนน กระทรวงคมนาคม (ทางหลวง + ทางหลวงชนบท + ทางพิเศษ)',
    range: {
      from: withCoord.map((e) => e.date).sort()[0],
      to: withCoord.map((e) => e.date).sort().at(-1),
    },
    events_used: withCoord.length,
    grid_degrees: GRID,
    min_accidents: MIN_ACCIDENTS,
    total_groups: rows.length,
    hotspots: top,
  }),
  'utf8',
)

const kb = (fs.statSync(file).size / 1024).toFixed(0)
console.log(`\nเขียน ${file} (${top.length} จุด จากทั้งหมด ${rows.length} จุดที่เข้าเกณฑ์, ${kb} KB)`)
console.log('\n10 อันดับแรก:')
for (const r of top.slice(0, 10)) {
  console.log(
    `  ${r.province.padEnd(14)} ${String(r.accidents).padStart(3)} ครั้ง ` +
      `ตาย ${String(r.dead).padStart(2)} เจ็บ ${String(r.injured).padStart(3)} — ${r.road} (${r.geometry})`,
  )
}
