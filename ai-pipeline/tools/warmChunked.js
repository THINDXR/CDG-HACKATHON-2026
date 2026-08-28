/*
 * ขอข้อมูลอากาศของ batch ที่ยังขาด โดยแบ่งเป็นช่วงปีแทนที่จะขอรวดเดียว
 *
 * Open-Meteo คิดโควตาตาม "ปริมาณข้อมูล" ไม่ใช่จำนวน request
 * คำขอเดิมคือ 5 จังหวัด x 1,581 วัน x 6 ตัวแปร = หนักมาก พอโควตารายชั่วโมงตึง
 * มันจะถูกปฏิเสธทั้งก้อนแม้จะเหลือโควตาอยู่บ้าง
 *
 * สคริปต์นี้ขอทีละปี (2 จังหวัด x ~365 วัน) ซึ่งเบากว่าราว 7 เท่าต่อคำขอ
 * แล้วประกอบผลกลับเป็นรูปแบบเดียวกับที่ Open-Meteo จะตอบถ้าขอรวดเดียว
 * จากนั้นเขียนลง cache ด้วย key เดียวกับที่ `src/cli.js build` จะขอ
 * (cache key ของ fetchCached คือ "METHOD URL\nbody" ล้วน ๆ)
 *
 * ผลลัพธ์ที่ได้เป็นข้อมูลชุดเดียวกันเป๊ะ ๆ ต่างแค่วิธีขอ — ไม่ใช่การเดาหรือเติมค่าเอง
 *
 *     node tools/warmChunked.js
 */
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { DIR, OPEN_METEO, OPEN_METEO_DAILY, START_DATE } from '../src/config.js'
import { sleep } from '../src/lib/http.js'
import { buildProvinces } from '../src/build/provinces.js'
import { fetchAllMot } from '../src/sources/motAccident.js'
import { makeProvinceResolver } from '../src/lib/provinceResolve.js'

const BATCH_SIZE = 5
const USER_AGENT = 'thai-road-accident-risk/1.0 (research pipeline; contact via repo owner)'
// เว้นระยะระหว่างคำขอย่อย ไม่งั้นยิงติดกัน 5 ครั้งก็โดน burst limit อยู่ดี
const GAP_MS = 20_000
const TRIES_PER_CHUNK = 4
const WAIT_ON_429_MS = 5 * 60 * 1000

const cachePath = (key, ext) => {
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)
  return path.join(DIR.raw, `${hash}${ext}`)
}

function urlFor(batch, from, to) {
  const params = new URLSearchParams({
    latitude: batch.map((p) => p.lat.toFixed(4)).join(','),
    longitude: batch.map((p) => p.lon.toFixed(4)).join(','),
    start_date: from,
    end_date: to,
    daily: OPEN_METEO_DAILY.join(','),
    timezone: 'Asia/Bangkok',
  })
  return `${OPEN_METEO}?${params}`
}

/** แบ่งช่วงวันที่เป็นท่อน ๆ ตามปีปฏิทิน */
function yearChunks(from, to) {
  const chunks = []
  let year = Number(from.slice(0, 4))
  const endYear = Number(to.slice(0, 4))
  while (year <= endYear) {
    const start = year === Number(from.slice(0, 4)) ? from : `${year}-01-01`
    const end = year === endYear ? to : `${year}-12-31`
    chunks.push([start, end])
    year++
  }
  return chunks
}

async function getJson(url, label) {
  for (let attempt = 1; attempt <= TRIES_PER_CHUNK; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
      return await res.json()
    } catch (err) {
      console.log(`    ${label} ครั้งที่ ${attempt} ไม่สำเร็จ: ${err.message}`)
      if (attempt === TRIES_PER_CHUNK) throw err
      console.log(`    รอ ${WAIT_ON_429_MS / 60000} นาที ...`)
      await sleep(WAIT_ON_429_MS)
    }
  }
}

const provinces = await buildProvinces()
const resolveProvince = makeProvinceResolver(
  provinces.map((p) => ({ geocode: p.geocode, name_th: p.name_th })),
)
const { events } = await fetchAllMot(resolveProvince)
const endDate = events.map((e) => e.date).sort().at(-1)
console.log(`ช่วงข้อมูล ${START_DATE} → ${endDate}`)

let done = 0
for (let i = 0; i < provinces.length; i += BATCH_SIZE) {
  const batch = provinces.slice(i, i + BATCH_SIZE)
  const target = urlFor(batch, START_DATE, endDate)
  const file = cachePath(`GET ${target}\n`, '.bin')
  if (fs.existsSync(file)) continue

  console.log(`\nชุดที่ ${i + 1}: ${batch.map((p) => p.name_th).join(', ')}`)
  const chunks = yearChunks(START_DATE, endDate)
  const parts = []

  for (const [from, to] of chunks) {
    console.log(`  ขอช่วง ${from} → ${to}`)
    const payload = await getJson(urlFor(batch, from, to), `${from}..${to}`)
    parts.push(Array.isArray(payload) ? payload : [payload])
    console.log(`    ได้แล้ว`)
    await sleep(GAP_MS)
  }

  /*
   * ประกอบกลับ: โครงสร้างที่ Open-Meteo ตอบคือ array ของจุด แต่ละจุดมี daily.time
   * กับ array ของแต่ละตัวแปรที่ยาวเท่ากัน ต่อท่อนปีเข้าด้วยกันตามลำดับเวลา
   * แล้วต้องได้ความยาวเท่ากับจำนวนวันทั้งช่วงพอดี ไม่งั้นแปลว่าต่อผิด
   */
  const merged = batch.map((_, k) => {
    const base = { ...parts[0][k] }
    const daily = { time: [] }
    for (const v of OPEN_METEO_DAILY) daily[v] = []

    for (const part of parts) {
      const d = part[k].daily
      daily.time.push(...d.time)
      for (const v of OPEN_METEO_DAILY) daily[v].push(...(d[v] ?? []))
    }
    base.daily = daily
    return base
  })

  const expected = Math.round(
    (new Date(`${endDate}T00:00:00Z`) - new Date(`${START_DATE}T00:00:00Z`)) / 86_400_000,
  ) + 1
  for (const [k, m] of merged.entries()) {
    if (m.daily.time.length !== expected) {
      throw new Error(
        `${batch[k].name_th}: ต่อท่อนแล้วได้ ${m.daily.time.length} วัน แต่ควรเป็น ${expected}`,
      )
    }
  }

  const buf = Buffer.from(JSON.stringify(merged), 'utf8')
  fs.writeFileSync(file, buf)
  fs.writeFileSync(
    cachePath(`GET ${target}\n`, '.meta.json'),
    JSON.stringify(
      {
        url: target,
        method: 'GET',
        body: null,
        label: `weather:${i} (ประกอบจาก ${chunks.length} ท่อนปี)`,
        bytes: buf.length,
        fetchedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  console.log(`  เขียน cache แล้ว (${expected} วัน x ${batch.length} จังหวัด)`)
  done++
}

console.log(done === 0 ? '\ncache ครบอยู่แล้ว' : `\nเติม cache สำเร็จ ${done} ชุด`)
