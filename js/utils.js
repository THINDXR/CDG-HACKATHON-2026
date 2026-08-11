/* ฟังก์ชันช่วยทั่วไป: ระยะทาง, เวลา, DOM */
window.Utils = (function () {
  const R = 6371000; // รัศมีโลก (เมตร)
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  /** ระยะทางระหว่างสองพิกัด (เมตร) */
  function distance(a, b) {
    const dLat = toRad(b[1] - a[1]);
    const dLng = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** ทิศจาก a ไป b เป็นองศา 0-360 (0 = เหนือ) */
  function bearing(a, b) {
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const dLng = toRad(b[0] - a[0]);
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x =
      Math.cos(lat1) * Math.sin(lat2) -
      Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  /** เลื่อนพิกัดไปตามทิศและระยะทาง (เมตร) */
  function destination(from, bearingDeg, meters) {
    const d = meters / R;
    const br = toRad(bearingDeg);
    const lat1 = toRad(from[1]);
    const lng1 = toRad(from[0]);
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br)
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(br) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
      );
    return [toDeg(lng2), toDeg(lat2)];
  }

  /** วงกลม GeoJSON รอบจุดหนึ่ง (ใช้วาดรัศมีเตือน) */
  function circlePolygon(center, radiusMeters, steps = 64) {
    const coords = [];
    for (let i = 0; i <= steps; i++) {
      coords.push(destination(center, (i / steps) * 360, radiusMeters));
    }
    return { type: 'Polygon', coordinates: [coords] };
  }

  function formatDistance(m) {
    if (m < 1000) return `${Math.round(m / 10) * 10} ม.`;
    return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} กม.`;
  }

  function formatAgo(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'เมื่อสักครู่';
    if (s < 3600) return `${Math.floor(s / 60)} นาทีที่แล้ว`;
    if (s < 86400) return `${Math.floor(s / 3600)} ชม.ที่แล้ว`;
    return `${Math.floor(s / 86400)} วันที่แล้ว`;
  }

  /** ชื่อทิศแบบไทยจากองศา */
  function compassLabel(deg) {
    const names = [
      'เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้',
      'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ',
    ];
    return names[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
  }

  function uid() {
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function $$(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  return {
    distance, bearing, destination, circlePolygon,
    formatDistance, formatAgo, compassLabel,
    uid, el, $, $$, escapeHtml,
  };
})();
