/*
 * อุ่น cache สภาพอากาศเฉพาะ batch ที่ยังขาด
 *
 * `node src/cli.js build` ล้มทั้งรอบถ้ามี batch เดียวโดน 429 แล้วต้องเริ่มใหม่
 * ซึ่งเสียเวลาไปกับ delay 15 วิของ batch ที่ cache ไว้แล้ว 15 ชุด
 * สคริปต์นี้ข้าม batch ที่มีใน cache แล้วไปเลย เหลือแต่ตัวที่ยังไม่มี
 * แล้วรอแบบใจเย็น (Open-Meteo คิดโควตาตามปริมาณข้อมูล ไม่ใช่จำนวน request
 * โควตาชั่วโมงจึงต้องรอให้คลายจริง ๆ ไม่ใช่แค่หน่วงสองสามวินาที)
 *
 * cache key ของ fetchCached คือ "METHOD URL" ล้วน ๆ สคริปต์นี้จึงต้องสร้าง URL
 * ให้เหมือน fetchWeather() ทุกตัวอักษร ไม่งั้นจะได้ cache คนละก้อนแล้ว build ยังล้มเหมือนเดิม
 *
 *     node tools/warmWeather.js
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { DIR, OPEN_METEO, OPEN_METEO_DAILY, START_DATE } from '../src/config.js'
import { fetchJson, sleep } from '../src/lib/http.js'
import { buildProvinces } from '../src/build/provinces.js'
import { fetchAllMot } from '../src/sources/motAccident.js'
import { makeProvinceResolver } from '../src/lib/provinceResolve.js'

// ตรงกับ BATCH_SIZE ใน src/sources/weather.js
const BATCH_SIZE = 5
// รอนานกว่า retry ปกติมาก เพราะโควตารายชั่วโมงไม่คลายใน 2 นาที
const WAIT_BETWEEN_TRIES_MS = 10 * 60 * 1000
const MAX_TRIES = 8

const cached = (url) => {
  const hash = crypto.createHash('sha1').update(`GET ${url}\n`).digest('hex').slice(0, 16)
  return fs.existsSync(path.join(DIR.raw, `${hash}.bin`))
}

const provinces = await buildProvinces()
const resolveProvince = makeProvinceResolver(
  provinces.map((p) => ({ geocode: p.geocode, name_th: p.name_th })),
)

// วันสุดท้ายต้องคำนวณแบบเดียวกับ buildPanel ไม่งั้น URL ไม่ตรงกับที่ build จะขอ
const { events } = await fetchAllMot(resolveProvince)
const endDate = events.map((e) => e.date).sort().at(-1)
console.log(`ช่วงข้อมูล ${START_DATE} → ${endDate}`)

const urls = []
for (let i = 0; i < provinces.length; i += BATCH_SIZE) {
  const batch = provinces.slice(i, i + BATCH_SIZE)
  const params = new URLSearchParams({
    latitude: batch.map((p) => p.lat.toFixed(4)).join(','),
    longitude: batch.map((p) => p.lon.toFixed(4)).join(','),
    start_date: START_DATE,
    end_date: endDate,
    daily: OPEN_METEO_DAILY.join(','),
    timezone: 'Asia/Bangkok',
  })
  urls.push({ index: i, url: `${OPEN_METEO}?${params}`, names: batch.map((p) => p.name_th) })
}

const missing = urls.filter((u) => !cached(u.url))
console.log(`ทั้งหมด ${urls.length} ชุด · มีใน cache แล้ว ${urls.length - missing.length} · ยังขาด ${missing.length}`)

if (missing.length === 0) {
  console.log('cache ครบแล้ว รัน `node src/cli.js build` ต่อได้เลย')
  process.exit(0)
}

for (const item of missing) {
  console.log(`\nชุดที่ ${item.index + 1}: ${item.names.join(', ')}`)
  let ok = false

  for (let attempt = 1; attempt <= MAX_TRIES && !ok; attempt++) {
    try {
      // retries: 0 เพราะเราคุมจังหวะรอเองด้านนอก ไม่ให้ backoff สองชั้นซ้อนกัน
      await fetchJson(item.url, { label: `warm:${item.index}`, retries: 0, timeoutMs: 240_000 })
      console.log(`  สำเร็จ (ครั้งที่ ${attempt})`)
      ok = true
    } catch (err) {
      const last = attempt === MAX_TRIES
      console.log(`  ครั้งที่ ${attempt} ไม่สำเร็จ: ${err.message}`)
      if (last) {
        console.error('\nโควตายังไม่คลาย — ลองรันสคริปต์นี้ใหม่อีกครั้งภายหลัง')
        process.exit(1)
      }
      console.log(`  รอ ${WAIT_BETWEEN_TRIES_MS / 60000} นาทีแล้วลองใหม่ ...`)
      await sleep(WAIT_BETWEEN_TRIES_MS)
    }
  }
}

console.log('\ncache ครบแล้ว รัน `node src/cli.js build` ต่อได้เลย')
