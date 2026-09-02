/* ค่าคงที่และนิยามประเภทภัยบนถนน */
window.APP_CONFIG = (function () {
  // ไอคอนเป็น SVG จาก js/icons.js (โหลดก่อนไฟล์นี้) ไม่ใช้ emoji เพราะหน้าตาเพี้ยนตามระบบ
  const ico = (name) => window.Icons.get(name);

  const HAZARD_TYPES = {
    accident: {
      label: 'อุบัติเหตุ',
      icon: ico('accident'),
      color: '#ff453a',
      defaultRadius: 400,
      defaultSeverity: 'high',
    },
    flood: {
      label: 'น้ำท่วมขัง',
      icon: ico('flood'),
      color: '#0a84ff',
      defaultRadius: 500,
      defaultSeverity: 'high',
    },
    construction: {
      label: 'ก่อสร้าง / ปิดถนน',
      icon: ico('construction'),
      color: '#ff9f0a',
      defaultRadius: 300,
      defaultSeverity: 'medium',
    },
    pothole: {
      label: 'หลุมบ่อ / ถนนชำรุด',
      icon: ico('pothole'),
      color: '#d4a017',
      defaultRadius: 150,
      defaultSeverity: 'medium',
    },
    obstacle: {
      label: 'สิ่งกีดขวาง',
      icon: ico('obstacle'),
      color: '#ffd60a',
      defaultRadius: 200,
      defaultSeverity: 'medium',
    },
    traffic: {
      label: 'รถติดหนัก',
      icon: ico('traffic'),
      color: '#bf5af2',
      defaultRadius: 600,
      defaultSeverity: 'low',
    },
    police: {
      label: 'ด่านตรวจ',
      icon: ico('police'),
      color: '#5e5ce6',
      defaultRadius: 300,
      defaultSeverity: 'low',
    },
    fog: {
      label: 'ทัศนวิสัยต่ำ',
      icon: ico('fog'),
      color: '#8e8e93',
      defaultRadius: 800,
      defaultSeverity: 'medium',
    },
    animal: {
      label: 'สัตว์บนถนน',
      icon: ico('animal'),
      color: '#ac8e68',
      defaultRadius: 250,
      defaultSeverity: 'medium',
    },
  };

  const SEVERITY = {
    low: { label: 'เฝ้าระวัง', weight: 1, color: '#30d158' },
    medium: { label: 'ระวัง', weight: 2, color: '#ff9f0a' },
    high: { label: 'อันตราย', weight: 3, color: '#ff3b30' },
  };

  return {
    HAZARD_TYPES,
    SEVERITY,

    // จุดเริ่มต้นแผนที่ (กรุงเทพฯ)
    DEFAULT_CENTER: [100.5331, 13.7465],
    DEFAULT_ZOOM: 15.2,
    DEFAULT_PITCH: 62,
    DEFAULT_BEARING: -22,

    // สไตล์แผนที่ (ไม่ต้องใช้ API key) — ใช้เมื่อผู้ใช้เปิด "แผนที่จริง"
    STYLE_VECTOR: 'https://tiles.openfreemap.org/styles/dark',
    TERRAIN_TILES:
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    SATELLITE_TILES:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',

    /*
     * ขยับเป็น v2 ตอนเปลี่ยนข้อมูลตัวอย่างจากชุดตายตัว 12 จุด มาเป็นชุดสุ่ม
     * ถ้าไม่ขยับ เครื่องที่เคยเปิดแอปแล้วจะยังเห็นชุดเดิมค้างใน localStorage ตลอดไป
     * เพราะ seed() ทำงานเฉพาะตอนยังไม่มีข้อมูลเก็บไว้
     */
    STORAGE_KEY: 'roadwarn.reports.v2',
    SETTINGS_KEY: 'roadwarn.settings.v1',

    // ระยะที่ถือว่า "รายงานหมดอายุ" (ชั่วโมง)
    EXPIRY_HOURS: 12,

    /*
     * รุ่นของโค้ดที่กำลังรันอยู่ — app.js พิมพ์ลง console ตอนเปิดแอป
     *
     * ต้องเป็นค่าเดียวกับ ?v= ใน index.html และขยับพร้อมกันทุกครั้งที่แก้ js/ หรือ css/
     * มีไว้ให้ตอบได้ทันทีว่า "ที่เห็นอยู่นี่โค้ดรุ่นไหน" เวลาผลลัพธ์ไม่ตรงกับที่แก้
     */
    BUILD: '2026-09-02b',
  };
})();
