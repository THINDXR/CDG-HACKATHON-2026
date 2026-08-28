/*
 * พยากรณ์โอกาสเกิดอุบัติเหตุระดับจังหวัด × วัน
 *
 * ต่างจาก Store.riskAssessment() และ RouteRisk อย่างสิ้นเชิง:
 *   Store/RouteRisk  ตอบว่า "ตรงไหนอันตราย" จากรายงานของผู้ใช้ ณ ตอนนี้
 *   ไฟล์นี้           ตอบว่า "วันไหนอันตราย" จากโมเดลที่เทรนบนสถิติ 4 ปี
 * สองอย่างนี้เสริมกัน ไม่ทับกัน จึงเอามารวมเป็นคะแนนเดียวได้ (ดู blendRouteScore)
 *
 * ที่มาของข้อมูลตอนใช้งานจริง
 *   อากาศ    Open-Meteo forecast API — เรียกสดทุกครั้ง ไม่ต้องใช้ API key
 *   วันหยุด  data/ai/holidays.json + คำนวณ feature ใน ai-holidays.js
 *   จังหวัด  data/ai/provinces.json (ลักษณะถนน ประชากร ยานพาหนะ)
 *   ประวัติ  ค่าเฉลี่ยรายจังหวัดจากปีล่าสุดใน provinces.json
 *
 * ⚠️ ข้อจำกัดที่ต้องบอกผู้ใช้ตรง ๆ
 *
 * 1. โมเดลเทรนจากอุบัติเหตุบน "ทางหลวง + ทางหลวงชนบท + ทางพิเศษ" เท่านั้น
 *    ไม่รวมถนนในเมืองและซอย จับได้ราว 15% ของการตายบนถนนทั้งประเทศ
 *
 * 2. ฟีเจอร์กลุ่มประวัติ (acc_roll7_prev, acc_roll28_prev, acc_same_dow_mean_prev)
 *    มีน้ำหนักถึง ~44% ของการทำนาย แต่ของจริงต้องรู้จำนวนอุบัติเหตุเมื่อวาน
 *    ซึ่งไม่มีแหล่งข้อมูลเรียลไทม์ให้ ที่นี่จึงแทนด้วยค่าเฉลี่ยรายจังหวัด
 *    แยกตามเดือนและวันในสัปดาห์ → ตัวเลขที่ได้จึงเป็น "ระดับความเสี่ยงตามฤดูกาล
 *    และปฏิทิน" มากกว่า "ความเสี่ยงที่อัปเดตตามเหตุการณ์ล่าสุด"
 *    ความแม่นจริงจะต่ำกว่า PR-AUC 0.714 ที่รายงานไว้ ซึ่งวัดบนประวัติจริง
 *
 * 3. อากาศตอนเทรนมาจาก reanalysis (ข้อมูลย้อนหลังที่ผ่านการปรับแล้ว)
 *    แต่ตอนใช้งานเป็นพยากรณ์ล่วงหน้า ยิ่งไกลวันยิ่งคลาดเคลื่อน
 *
 * 4. ตัวเลขนี้บอกความสัมพันธ์ ไม่ใช่สาเหตุ และเป็นระดับจังหวัด
 *    ไม่ได้แปลว่าถนนเส้นที่คุณจะขับมีความเสี่ยงเท่านี้
 */
window.AIForecast = (function () {
  const U = window.Utils;

  const WEATHER_API = 'https://api.open-meteo.com/v1/forecast';
  // ต้องขอชื่อตัวแปรชุดเดียวกับที่ pipeline ใช้ตอนเทรน ไม่งั้น feature จะคนละความหมาย
  const DAILY_VARS = [
    'precipitation_sum',
    'rain_sum',
    'precipitation_hours',
    'temperature_2m_max',
    'temperature_2m_min',
    'windspeed_10m_max',
  ];

  // เกณฑ์ฝน ตรงกับ RAIN_MM_THRESHOLD / HEAVY_RAIN_MM_THRESHOLD ใน pipeline
  const RAIN_MM = 1.0;
  const HEAVY_RAIN_MM = 35.0;

  // วันแรกของชุดข้อมูลที่เทรน ใช้คำนวณ days_since_start ให้ตรงกับตอนเทรน
  const START_DATE = '2022-01-01';

  // พยากรณ์อากาศไม่ได้เปลี่ยนทุกนาที เก็บไว้ครึ่งชั่วโมงพอ
  const WEATHER_TTL_MS = 30 * 60 * 1000;
  const WEATHER_CACHE_KEY = 'roadwarn.ai.weather.v1';

  let provinces = null;
  let ready = null;
  let lastError = null;

  const weatherCache = new Map(); // geocode -> { at, byDate }

  const iso = (d) => d.toISOString().slice(0, 10);
  const today = () => iso(new Date());

  /* ---------- โหลดทรัพยากร ---------- */

  /*
   * โหลดทุกอย่างพร้อมกันครั้งเดียว ถ้าพลาดส่วนใดส่วนหนึ่งถือว่าใช้ไม่ได้ทั้งหมด
   * แล้วให้แอปทำงานต่อโดยไม่มีส่วน AI — ไม่ใช่ค้างทั้งหน้า
   */
  async function init() {
    if (ready) return ready;
    ready = Promise.all([
      window.AIModel.load(),
      window.AIHolidays.load(),
      fetch('data/ai/provinces.json').then((r) => {
        if (!r.ok) throw new Error(`โหลดข้อมูลจังหวัดไม่สำเร็จ (HTTP ${r.status})`);
        return r.json();
      }),
    ])
      .then(([, , doc]) => {
        provinces = doc.provinces;
        restoreWeatherCache();
        return true;
      })
      .catch((err) => {
        lastError = err;
        ready = null;
        throw err;
      });
    return ready;
  }

  function restoreWeatherCache() {
    try {
      const raw = localStorage.getItem(WEATHER_CACHE_KEY);
      if (!raw) return;
      const doc = JSON.parse(raw);
      if (Date.now() - doc.at > WEATHER_TTL_MS) return;
      for (const [geocode, byDate] of Object.entries(doc.data)) {
        weatherCache.set(geocode, { at: doc.at, byDate });
      }
    } catch (err) {
      // cache เสียก็แค่ไปดึงใหม่ ไม่ใช่เรื่องที่ต้องรบกวนผู้ใช้
    }
  }

  function persistWeatherCache() {
    try {
      const data = {};
      for (const [geocode, entry] of weatherCache) data[geocode] = entry.byDate;
      localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
    } catch (err) {
      // localStorage เต็มหรือถูกปิด — ข้ามไป ยังทำงานได้ด้วย cache ในหน่วยความจำ
    }
  }

  /* ---------- จังหวัด ---------- */

  /* หาจังหวัดจากพิกัด ด้วยจุดศูนย์กลางที่ใกล้ที่สุด */
  function provinceAt(lngLat) {
    if (!provinces) return null;
    let best = null;
    let bestDist = Infinity;
    for (const p of provinces) {
      if (p.lat == null || p.lon == null) continue;
      const d = U.distance(lngLat, [p.lon, p.lat]);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    // จุดศูนย์กลางเป็นค่าเฉลี่ยของพิกัดอุบัติเหตุ ไม่ใช่ศูนย์กลางเชิงเรขาคณิต
    // จังหวัดที่ยาวมากอาจคลาดได้พอสมควร จึงคืนระยะไปด้วยให้ผู้เรียกตัดสินใจเอง
    return best && { ...best, centroidDistance: bestDist };
  }

  function provinceByName(name) {
    return provinces?.find((p) => p.name === name) || null;
  }

  /* ---------- อากาศ ---------- */

  async function fetchWeather(province) {
    const cached = weatherCache.get(province.geocode);
    if (cached && Date.now() - cached.at < WEATHER_TTL_MS) return cached.byDate;

    const params = new URLSearchParams({
      latitude: province.lat.toFixed(4),
      longitude: province.lon.toFixed(4),
      daily: DAILY_VARS.join(','),
      timezone: 'Asia/Bangkok',
      // ต้องมีเมื่อวานกับวันก่อนหน้าด้วย เพราะ rain_lag1 / rain_3d_sum ต้องใช้
      past_days: '2',
      forecast_days: '7',
    });

    const res = await fetch(`${WEATHER_API}?${params}`);
    if (!res.ok) throw new Error(`Open-Meteo ตอบ HTTP ${res.status}`);
    const payload = await res.json();
    const daily = payload.daily;
    if (!daily || !Array.isArray(daily.time)) {
      throw new Error('Open-Meteo ไม่ได้คืนข้อมูลรายวันมา');
    }

    const byDate = {};
    daily.time.forEach((date, i) => {
      byDate[date] = {
        precip_mm: daily.precipitation_sum?.[i] ?? null,
        rain_mm: daily.rain_sum?.[i] ?? null,
        precip_hours: daily.precipitation_hours?.[i] ?? null,
        temp_max: daily.temperature_2m_max?.[i] ?? null,
        temp_min: daily.temperature_2m_min?.[i] ?? null,
        wind_max: daily.windspeed_10m_max?.[i] ?? null,
      };
    });

    weatherCache.set(province.geocode, { at: Date.now(), byDate });
    persistWeatherCache();
    return byDate;
  }

  /* ---------- ประกอบ feature ---------- */

  function weatherFeatures(byDate, date) {
    const w = byDate[date] || {};
    const prev = byDate[window.AIHolidays.addDays(date, -1)] || {};
    const prev2 = byDate[window.AIHolidays.addDays(date, -2)] || {};
    const precip = w.precip_mm ?? null;

    return {
      precip_mm: precip,
      rain_mm: w.rain_mm ?? null,
      precip_hours: w.precip_hours ?? null,
      temp_max: w.temp_max ?? null,
      temp_min: w.temp_min ?? null,
      wind_max: w.wind_max ?? null,
      is_rainy: precip !== null && precip > RAIN_MM ? 1 : 0,
      is_heavy_rain: precip !== null && precip > HEAVY_RAIN_MM ? 1 : 0,
      rain_lag1: prev.precip_mm ?? null,
      rain_3d_sum:
        precip !== null
          ? precip + (prev.precip_mm ?? 0) + (prev2.precip_mm ?? 0)
          : null,
    };
  }

  /*
   * ค่าแทนฟีเจอร์ประวัติ
   *
   * ของจริงคือค่าเฉลี่ยอุบัติเหตุ 7 วัน / 28 วันล่าสุด และค่าเฉลี่ยของวันเดียวกัน
   * ในสัปดาห์ก่อน ๆ ซึ่งต้องรู้ตัวเลขจริงของเมื่อวาน — ไม่มีแหล่งเรียลไทม์
   * จึงแทนด้วยค่าเฉลี่ยของจังหวัดนั้นในปีล่าสุด แยกตามเดือน (สำหรับ rolling)
   * และตามวันในสัปดาห์ (สำหรับ same-dow) ซึ่งเป็นค่าคาดหวังของฟีเจอร์เหล่านั้น
   */
  function historyFeatures(province, date) {
    const h = province.history || {};
    const month = String(Number(date.slice(5, 7)));
    const dow = String(new Date(`${date}T00:00:00Z`).getUTCDay());
    const monthly = h.by_month?.[month] ?? h.mean ?? null;
    return {
      acc_roll7_prev: monthly,
      acc_roll28_prev: monthly,
      acc_same_dow_mean_prev: h.by_dow?.[dow] ?? h.mean ?? null,
    };
  }

  let checkedCoverage = false;

  function buildFeatures(province, date, weatherByDate) {
    const features = {
      ...window.AIHolidays.featuresFor(date, START_DATE),
      ...weatherFeatures(weatherByDate, date),
      ...historyFeatures(province, date),
      ...province.static,
    };

    /*
     * feature ที่โมเดลต้องการแต่ไม่มีใครสร้าง จะถูกส่งเป็น missing เงียบ ๆ
     * แล้วผลทำนายเพี้ยนโดยไม่มีอะไรฟ้อง — เช็คครั้งเดียวตอนทำนายครั้งแรก
     * แล้วบอกใน console ให้คนที่แก้โค้ดรู้ตัว (ไม่ขวางหน้าผู้ใช้)
     */
    if (!checkedCoverage) {
      checkedCoverage = true;
      const missing = window.AIModel.missingFeatures(features);
      if (missing.length) {
        console.warn(
          `feature ที่โมเดลต้องการแต่ไม่มีค่า (${missing.length} ตัว):`,
          missing.join(', '),
          '— ดู buildFeatures() ใน js/ai-forecast.js',
        );
      }
    }

    return features;
  }

  /* ---------- ระดับความเสี่ยง ---------- */

  /*
   * ระดับความเสี่ยง เทียบกับ "วันธรรมดา" ของจังหวัดนั้นเอง
   *
   * เกณฑ์ตายตัวใช้ไม่ได้ เพราะความน่าจะเป็นดิบเทียบข้ามจังหวัดไม่ได้ —
   * กรุงเทพฯ ได้ 99% ทุกวัน (ทางหลวงในเมืองแทบไม่มีวันไหนไม่เกิดเหตุ)
   * ถ้าใช้เกณฑ์เดียวกันหมด การ์ดจะขึ้น "เสี่ยงสูง" ทุกวันจนผู้ใช้เลิกอ่าน
   * ส่วนจังหวัดเล็กจะขึ้น "ปกติ" ตลอด แม้เป็นวันสงกรานต์
   *
   * สิ่งที่คนขับอยากรู้คือ "วันนี้เสี่ยงกว่าปกติของที่นี่ไหม" จึงเทียบจำนวนครั้ง
   * ที่คาดว่าจะเกิด กับค่ากลางของจังหวัดนั้นตลอดปีล่าสุด (จาก provinces.json)
   *
   * ถ้าไม่มีค่าอ้างอิง (จังหวัดใหม่ / ไฟล์รุ่นเก่า) ถอยไปใช้ threshold แบบเดิม
   */
  function levelOf(probability, threshold, expectedCount, typical) {
    if (typical && typical.count > 0) {
      const ratio = expectedCount / typical.count;
      if (ratio >= 1.6) return { key: 'high', label: 'เสี่ยงกว่าปกติมาก', color: '#ff3b30', ratio };
      if (ratio >= 1.25) return { key: 'elevated', label: 'เสี่ยงกว่าปกติ', color: '#ff9f0a', ratio };
      if (ratio >= 1.05) return { key: 'watch', label: 'สูงกว่าปกติเล็กน้อย', color: '#ffd60a', ratio };
      if (ratio >= 0.8) return { key: 'normal', label: 'ปกติ', color: '#30d158', ratio };
      return { key: 'low', label: 'ต่ำกว่าปกติ', color: '#30d158', ratio };
    }

    const t = threshold || 0.32;
    if (probability >= t + (1 - t) * 0.55) return { key: 'high', label: 'เสี่ยงสูง', color: '#ff3b30' };
    if (probability >= t + (1 - t) * 0.2) return { key: 'elevated', label: 'ควรระวัง', color: '#ff9f0a' };
    if (probability >= t) return { key: 'watch', label: 'เฝ้าระวัง', color: '#ffd60a' };
    return { key: 'normal', label: 'ปกติ', color: '#30d158' };
  }

  /* ---------- คำอธิบายเป็นภาษาคน ---------- */

  const FEATURE_LABELS = {
    is_seven_dangerous_days: 'ช่วง 7 วันอันตราย',
    is_songkran: 'ช่วงสงกรานต์',
    is_newyear: 'ช่วงปีใหม่',
    is_public_holiday: 'วันหยุดราชการ',
    is_holiday_eve: 'วันก่อนวันหยุด',
    is_long_weekend: 'วันหยุดยาว',
    day_off_run_length: 'ความยาวช่วงวันหยุด',
    is_weekend: 'วันเสาร์อาทิตย์',
    days_to_next_holiday: 'ใกล้วันหยุดถัดไป',
    days_since_prev_holiday: 'ห่างจากวันหยุดก่อนหน้า',
    precip_mm: 'ปริมาณฝน',
    rain_mm: 'ฝน',
    precip_hours: 'จำนวนชั่วโมงที่ฝนตก',
    rain_lag1: 'ฝนเมื่อวาน',
    rain_3d_sum: 'ฝนสะสม 3 วัน',
    is_rainy: 'มีฝน',
    is_heavy_rain: 'ฝนหนัก',
    temp_max: 'อุณหภูมิสูงสุด',
    temp_min: 'อุณหภูมิต่ำสุด',
    wind_max: 'ลมแรงสุด',
    dow: 'วันในสัปดาห์',
    month: 'เดือน',
    doy_sin: 'ฤดูกาล',
    doy_cos: 'ฤดูกาล',
    days_since_start: 'แนวโน้มระยะยาว',
    acc_roll7_prev: 'สถิติอุบัติเหตุช่วงนี้',
    acc_roll28_prev: 'สถิติอุบัติเหตุรายเดือน',
    acc_same_dow_mean_prev: 'สถิติของวันเดียวกันในสัปดาห์',
    highway_km: 'ระยะทางหลวงในจังหวัด',
    vehicle_km: 'ปริมาณการเดินทาง',
    avg_lanes: 'จำนวนช่องจราจรเฉลี่ย',
    road_km_per_area: 'ความหนาแน่นถนน',
    pct_curve_prev: 'สัดส่วนทางโค้ง',
    pct_slope_prev: 'สัดส่วนทางลาดชัน',
    pct_junction_prev: 'สัดส่วนทางแยก',
    population: 'ประชากร',
    log_population: 'ประชากร',
    area_km2: 'ขนาดพื้นที่',
    motorcycle_per_capita: 'สัดส่วนมอเตอร์ไซค์ต่อประชากร',
    vehicle_density: 'ความหนาแน่นยานพาหนะ',
  };

  /*
   * เหตุผลที่โชว์ผู้ใช้ ต่างจาก explain() ของโมเดลตรงที่คัดเฉพาะเรื่องที่
   * "คนทำอะไรกับมันได้" — ฝน วันหยุด วันในสัปดาห์ — ไม่โชว์อย่าง log_population
   * ซึ่งถูกทางสถิติแต่ผู้ใช้เอาไปทำอะไรไม่ได้
   */
  const ACTIONABLE = new Set([
    'is_seven_dangerous_days', 'is_songkran', 'is_newyear', 'is_public_holiday',
    'is_holiday_eve', 'is_long_weekend', 'day_off_run_length', 'is_weekend',
    'precip_mm', 'rain_mm', 'precip_hours', 'rain_lag1', 'rain_3d_sum',
    'is_rainy', 'is_heavy_rain', 'wind_max',
    'acc_roll7_prev', 'acc_roll28_prev', 'acc_same_dow_mean_prev',
    'pct_curve_prev', 'pct_slope_prev', 'pct_junction_prev',
  ]);

  function reasonsFor(features, date) {
    const out = [];

    if (features.is_seven_dangerous_days) {
      out.push({ text: features.is_songkran ? 'ช่วง 7 วันอันตรายสงกรานต์' : 'ช่วง 7 วันอันตรายปีใหม่', weight: 3 });
    } else if (features.is_public_holiday) {
      const name = window.AIHolidays.nameOf(date);
      out.push({ text: name ? `วันหยุด: ${name}` : 'วันหยุดราชการ', weight: 2 });
    }

    // SHAP ของโมเดลชี้ว่าวันหยุดยาวเป็นจุดหักศอกที่ 4 วัน ไม่ใช่เพิ่มขึ้นทีละนิด
    if (features.day_off_run_length >= 4) {
      out.push({ text: `วันหยุดยาว ${features.day_off_run_length} วัน — ช่วงที่ความเสี่ยงพุ่งชัดเจน`, weight: 3 });
    }

    // และฝนเริ่มมีผลจริงที่ราว 4-5 มม. ต่ำกว่านั้นแทบไม่ต่างจากวันแห้ง
    const rain = features.precip_mm;
    if (rain !== null && rain >= 20) {
      out.push({ text: `ฝนหนัก ${rain.toFixed(0)} มม. — ถนนลื่น ระยะเบรกยาวขึ้น`, weight: 3 });
    } else if (rain !== null && rain >= 5) {
      out.push({ text: `ฝนตก ${rain.toFixed(1)} มม. — เกินระดับที่เริ่มเพิ่มความเสี่ยง`, weight: 2 });
    }

    if (features.wind_max !== null && features.wind_max >= 40) {
      out.push({ text: `ลมแรง ${features.wind_max.toFixed(0)} กม./ชม.`, weight: 1 });
    }

    if (out.length === 0 && features.is_weekend) {
      out.push({ text: 'วันหยุดสุดสัปดาห์ การเดินทางหนาแน่นกว่าวันธรรมดา', weight: 1 });
    }

    return out.sort((a, b) => b.weight - a.weight);
  }

  /* ---------- API หลัก ---------- */

  /*
   * ทำนายให้จุดหนึ่ง วันหนึ่ง
   * @param {[number,number]} lngLat
   * @param {string} [date] 'YYYY-MM-DD' ไม่ใส่ = วันนี้
   */
  async function forecast(lngLat, date) {
    await init();
    const province = provinceAt(lngLat);
    if (!province) throw new Error('หาจังหวัดจากพิกัดนี้ไม่ได้');
    return forecastProvince(province, date || today());
  }

  async function forecastProvince(province, dateArg) {
    await init();
    const date = dateArg || today();
    const byDate = await fetchWeather(province);
    const features = buildFeatures(province, date, byDate);
    const result = window.AIModel.predict(features);

    return {
      province: province.name,
      geocode: province.geocode,
      date,
      probability: result.probability,
      expectedCount: result.expectedCount,
      level: levelOf(result.probability, result.threshold, result.expectedCount, province.typical),
      threshold: result.threshold,
      reasons: reasonsFor(features, date),
      weather: {
        precip_mm: features.precip_mm,
        temp_max: features.temp_max,
        wind_max: features.wind_max,
      },
      holidayName: window.AIHolidays.nameOf(date),
      features,
      // มีข้อมูลอากาศจริงของวันนั้นไหม — ถ้าไม่มีแปลว่าเกินช่วงพยากรณ์ 7 วัน
      hasWeather: byDate[date] !== undefined,
    };
  }

  /* พยากรณ์ล่วงหน้าเป็นชุด ใช้กับกราฟ 7 วัน — ดึงอากาศครั้งเดียวใช้ทุกวัน */
  async function forecastWeek(lngLat, days) {
    await init();
    const province = provinceAt(lngLat);
    if (!province) throw new Error('หาจังหวัดจากพิกัดนี้ไม่ได้');

    const byDate = await fetchWeather(province);
    const out = [];
    const start = today();
    for (let i = 0; i < (days || 7); i++) {
      const date = window.AIHolidays.addDays(start, i);
      const features = buildFeatures(province, date, byDate);
      const result = window.AIModel.predict(features);
      out.push({
        date,
        province: province.name,
        probability: result.probability,
        expectedCount: result.expectedCount,
        level: levelOf(result.probability, result.threshold, result.expectedCount, province.typical),
        holidayName: window.AIHolidays.nameOf(date),
        precip_mm: features.precip_mm,
        isSevenDangerousDays: features.is_seven_dangerous_days === 1,
        hasWeather: byDate[date] !== undefined,
      });
    }
    return out;
  }

  /*
   * รวมคะแนนของโมเดลเข้ากับคะแนนความเสี่ยงเส้นทางของ RouteRisk
   *
   * RouteRisk.analyze() คืน score 0-100 แบบ "ยิ่งมากยิ่งเสี่ยง" จากรายงานผู้ใช้
   * ณ ตอนนี้ (ระดับจุดบนถนนเส้นนั้น) ส่วนโมเดลให้ความเสี่ยงระดับจังหวัด-วัน
   * ซึ่งหยาบกว่ามาก จึงถ่วงน้ำหนักไว้แค่ 30% — ให้มัน "ขยับ" คะแนนตามบริบทของวัน
   * ไม่ใช่กลบสิ่งที่เกิดขึ้นจริงบนถนนเส้นนั้น
   *
   * จุดอ้างอิงคือ threshold ที่จูนไว้ (~0.32): วันที่โมเดลให้ค่าพอดี threshold
   * คะแนนจะไม่ขยับเลย สูงกว่านั้นคะแนนเสี่ยงเพิ่ม ต่ำกว่านั้นลด
   */
  const MODEL_WEIGHT = 0.3;

  function blendRouteScore(riskScore, forecastResult) {
    if (!forecastResult) return { score: riskScore, adjusted: false, delta: 0 };

    /*
     * วัดจาก "วันนี้ต่างจากวันธรรมดาของจังหวัดนี้แค่ไหน" ไม่ใช่จากความน่าจะเป็นดิบ
     * ถ้าใช้ค่าดิบ กรุงเทพฯ จะโดนหักคะแนนเต็มเพดานทุกวัน ซึ่งไม่ได้บอกอะไรเลย
     * ratio 1.0 = วันธรรมดา ไม่ขยับคะแนน · 2.0 ขึ้นไป = ขยับเต็มเพดาน
     */
    const ratio = forecastResult.level?.ratio;
    const excess =
      ratio != null
        ? ratio - 1
        : (forecastResult.probability - (forecastResult.threshold || 0.32)) /
          (1 - (forecastResult.threshold || 0.32));
    const shift = Math.max(-1, Math.min(1, excess)) * MODEL_WEIGHT;

    // เสี่ยงกว่าปกติ → ไต่ขึ้นไปหา 100, ปลอดภัยกว่าปกติ → หดคะแนนลงตามสัดส่วน
    const raw =
      shift >= 0
        ? riskScore + (100 - riskScore) * shift
        : riskScore * (1 + shift);
    const adjusted = Math.max(0, Math.min(100, Math.round(raw)));

    return {
      score: adjusted,
      original: riskScore,
      adjusted: adjusted !== riskScore,
      delta: adjusted - riskScore,
      level: forecastResult.level,
      probability: forecastResult.probability,
    };
  }

  return {
    init,
    forecast,
    forecastProvince,
    forecastWeek,
    provinceAt,
    provinceByName,
    blendRouteScore,
    levelOf,
    FEATURE_LABELS,
    ACTIONABLE,
    isReady: () => provinces !== null,
    lastError: () => lastError,
  };
})();
