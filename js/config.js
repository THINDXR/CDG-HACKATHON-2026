/* ค่าคงที่และนิยามประเภทภัยบนถนน */
window.APP_CONFIG = (function () {
  const HAZARD_TYPES = {
    accident: {
      label: 'อุบัติเหตุ',
      icon: '🚗',
      color: '#ff3b30',
      defaultRadius: 400,
      defaultSeverity: 'high',
    },
    flood: {
      label: 'น้ำท่วมขัง',
      icon: '🌊',
      color: '#0a84ff',
      defaultRadius: 500,
      defaultSeverity: 'high',
    },
    construction: {
      label: 'ก่อสร้าง / ปิดถนน',
      icon: '🚧',
      color: '#ff9f0a',
      defaultRadius: 300,
      defaultSeverity: 'medium',
    },
    pothole: {
      label: 'หลุมบ่อ / ถนนชำรุด',
      icon: '🕳️',
      color: '#d4a017',
      defaultRadius: 150,
      defaultSeverity: 'medium',
    },
    obstacle: {
      label: 'สิ่งกีดขวาง',
      icon: '⚠️',
      color: '#ffd60a',
      defaultRadius: 200,
      defaultSeverity: 'medium',
    },
    traffic: {
      label: 'รถติดหนัก',
      icon: '🚦',
      color: '#bf5af2',
      defaultRadius: 600,
      defaultSeverity: 'low',
    },
    police: {
      label: 'ด่านตรวจ',
      icon: '👮',
      color: '#5e5ce6',
      defaultRadius: 300,
      defaultSeverity: 'low',
    },
    fog: {
      label: 'ทัศนวิสัยต่ำ',
      icon: '🌫️',
      color: '#8e8e93',
      defaultRadius: 800,
      defaultSeverity: 'medium',
    },
    animal: {
      label: 'สัตว์บนถนน',
      icon: '🐕',
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

    // สไตล์แผนที่ (ไม่ต้องใช้ API key)
    STYLE_VECTOR: 'https://tiles.openfreemap.org/styles/liberty',
    TERRAIN_TILES:
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    SATELLITE_TILES:
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',

    STORAGE_KEY: 'roadwarn.reports.v1',
    SETTINGS_KEY: 'roadwarn.settings.v1',

    // ระยะที่ถือว่า "รายงานหมดอายุ" (ชั่วโมง)
    EXPIRY_HOURS: 12,
  };
})();
