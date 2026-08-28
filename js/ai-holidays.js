/*
 * ฟีเจอร์เทศกาล/วันหยุด สำหรับ "วันไหนก็ได้" รวมถึงวันในอนาคต
 *
 * นี่คือการพอร์ต buildHolidayFeatures() จาก ai-pipeline/src/sources/holidays.js
 * มาไว้ฝั่งเบราว์เซอร์ ต้องให้ผลตรงกันทุกช่อง ไม่งั้นโมเดลจะได้ input คนละแบบ
 * กับตอนเทรน แล้วค่าที่ทำนายออกมาจะเพี้ยนโดยไม่มีอะไรฟ้อง
 *
 * เหตุที่ไม่ส่ง feature ที่คำนวณเสร็จแล้วมาจาก pipeline: panel.csv มีแค่วันในอดีต
 * แต่แอปต้องทำนาย "วันนี้และอีก 7 วันข้างหน้า" จึงต้องคำนวณสด ๆ จากปฏิทินดิบ
 */
window.AIHolidays = (function () {
  // ช่วงเทศกาล ตรงกับ FESTIVAL_WINDOWS ใน ai-pipeline/src/config.js
  const SONGKRAN = { from: [4, 11], to: [4, 17] };
  const NEWYEAR = { from: [12, 29], to: [1, 4] };

  let table = null; // date -> { name, isPublic }
  let publicDates = []; // วันหยุดราชการ เรียงแล้ว ใช้หาวันหยุดถัดไป/ก่อนหน้า
  let loading = null;

  const iso = (d) => d.toISOString().slice(0, 10);

  function addDays(date, n) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return iso(d);
  }

  function daysBetween(a, b) {
    const da = new Date(`${a}T00:00:00Z`).getTime();
    const db = new Date(`${b}T00:00:00Z`).getTime();
    return Math.round((db - da) / 86400000);
  }

  const dayOfWeek = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
  const monthOf = (date) => Number(date.slice(5, 7));
  const dayOf = (date) => Number(date.slice(8, 10));

  function dayOfYear(date) {
    const d = new Date(`${date}T00:00:00Z`);
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    return Math.floor((d.getTime() - start) / 86400000) + 1;
  }

  /* ช่วงเทศกาลบางช่วงคร่อมปีใหม่ (29 ธ.ค. - 4 ม.ค.) จึงต้องเทียบแบบวนรอบ */
  function inWindow(date, window) {
    const cur = monthOf(date) * 100 + dayOf(date);
    const from = window.from[0] * 100 + window.from[1];
    const to = window.to[0] * 100 + window.to[1];
    return from <= to ? cur >= from && cur <= to : cur >= from || cur <= to;
  }

  const isPublicHoliday = (date) => table.get(date)?.isPublic === true;
  const isWeekendDay = (date) => [0, 6].includes(dayOfWeek(date));
  /* วันที่คนไม่ต้องไปทำงาน = วันหยุดราชการ หรือ เสาร์อาทิตย์ */
  const isDayOff = (date) => isPublicHoliday(date) || isWeekendDay(date);

  /*
   * ความยาวของช่วงวันหยุดต่อเนื่องที่วันนี้อยู่ในนั้น
   *
   * feature นี้สำคัญกว่าที่คิด — SHAP ของโมเดลชี้ว่ามันเป็นจุดหักศอกที่ 4 วัน
   * หยุด 0-3 วันแทบไม่ต่างจากวันธรรมดา แต่พอถึง 4 วันความเสี่ยงกระโดดขึ้นชัดเจน
   */
  function dayOffRunLength(date) {
    if (!isDayOff(date)) return 0;
    let length = 1;
    for (let k = 1; k <= 10; k++) {
      if (!isDayOff(addDays(date, -k))) break;
      length++;
    }
    for (let k = 1; k <= 10; k++) {
      if (!isDayOff(addDays(date, k))) break;
      length++;
    }
    return length;
  }

  function findNext(date) {
    for (const h of publicDates) if (h > date) return h;
    return null;
  }

  function findPrev(date) {
    let prev = null;
    for (const h of publicDates) {
      if (h < date) prev = h;
      else break;
    }
    return prev;
  }

  async function load(url) {
    if (table) return table;
    if (loading) return loading;
    loading = fetch(url || 'data/ai/holidays.json')
      .then((r) => {
        if (!r.ok) throw new Error(`โหลดปฏิทินวันหยุดไม่สำเร็จ (HTTP ${r.status})`);
        return r.json();
      })
      .then((doc) => {
        table = new Map();
        for (const [date, name, isPublic] of doc.holidays) {
          table.set(date, { name, isPublic: isPublic === 1 });
        }
        publicDates = doc.holidays.filter((h) => h[2] === 1).map((h) => h[0]).sort();
        return table;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
    return loading;
  }

  /* ฟีเจอร์เทศกาล + เวลา/ฤดูกาล ของวันหนึ่ง (ทั้งสองกลุ่มขึ้นกับวันที่อย่างเดียว) */
  function featuresFor(date, startDate) {
    if (!table) throw new Error('ยังไม่ได้โหลดปฏิทิน — เรียก AIHolidays.load() ก่อน');

    const info = table.get(date);
    const next = findNext(date);
    const prev = findPrev(date);
    const songkran = inWindow(date, SONGKRAN);
    const newyear = inWindow(date, NEWYEAR);
    const runLength = dayOffRunLength(date);

    return {
      is_public_holiday: isPublicHoliday(date) ? 1 : 0,
      is_observance: info && !info.isPublic ? 1 : 0,
      is_weekend: isWeekendDay(date) ? 1 : 0,
      is_holiday_eve: isPublicHoliday(addDays(date, 1)) ? 1 : 0,
      is_songkran: songkran ? 1 : 0,
      is_newyear: newyear ? 1 : 0,
      is_seven_dangerous_days: songkran || newyear ? 1 : 0,
      day_off_run_length: runLength,
      is_long_weekend: runLength >= 3 ? 1 : 0,
      days_to_next_holiday: next ? daysBetween(date, next) : null,
      days_since_prev_holiday: prev ? daysBetween(prev, date) : null,

      dow: dayOfWeek(date),
      month: monthOf(date),
      doy_sin: Math.sin((2 * Math.PI * dayOfYear(date)) / 365.25),
      doy_cos: Math.cos((2 * Math.PI * dayOfYear(date)) / 365.25),
      days_since_start: daysBetween(startDate || '2022-01-01', date),
    };
  }

  /* ชื่อวันหยุด ไว้โชว์ผู้ใช้ ไม่ได้เข้าโมเดล */
  function nameOf(date) {
    return table?.get(date)?.name || null;
  }

  return { load, featuresFor, nameOf, addDays, daysBetween, isReady: () => table !== null };
})();
