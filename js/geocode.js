/* ค้นหาชื่อสถานที่/ถนนจริง ผ่าน Nominatim ของ OpenStreetMap (ไม่ต้องใช้ API key) */
window.Geocode = (function () {
  const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

  // Nominatim ขอให้ยิงไม่เกิน 1 ครั้ง/วินาที จึงจำผลเดิมไว้กันยิงซ้ำ
  const cache = new Map();

  /**
   * @param {string} query คำค้น
   * @param {[number, number]} [near] พิกัด [lng, lat] ที่ใช้ถ่วงให้ผลใกล้ตัวมาก่อน
   * @returns {Promise<Array<{name: string, detail: string, lng: number, lat: number}>>}
   */
  async function search(query, near) {
    const q = query.trim();
    if (q.length < 2) return [];

    const key = q.toLowerCase();
    if (cache.has(key)) return cache.get(key);

    const url = new URL(ENDPOINT);
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '5');
    url.searchParams.set('accept-language', 'th,en');
    if (near) {
      // กรอบกว้างราว 55 กม. รอบจุดอ้างอิง ใช้จัดลำดับ ไม่ได้ตัดผลนอกกรอบทิ้ง
      const [lng, lat] = near;
      const d = 0.5;
      url.searchParams.set('viewbox', `${lng - d},${lat + d},${lng + d},${lat - d}`);
    }

    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Nominatim ตอบกลับ ${res.status}`);

    const list = (await res.json()).map((row) => {
      const parts = String(row.display_name || '').split(',').map((s) => s.trim());
      return {
        name: parts[0] || row.name || q,
        detail: parts.slice(1, 3).join(' · '),
        lng: parseFloat(row.lon),
        lat: parseFloat(row.lat),
      };
    }).filter((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat));

    cache.set(key, list);
    return list;
  }

  /**
   * หาชื่อถนน/สถานที่จากพิกัด ใช้เติมช่อง "ถนน / สถานที่" ในฟอร์มแจ้งเหตุ
   * @returns {Promise<string>} ชื่อที่อ่านได้ หรือสตริงว่างถ้าหาไม่เจอ
   */
  async function reverse(lng, lat) {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('lon', String(lng));
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('zoom', '17'); // ระดับถนน
    url.searchParams.set('accept-language', 'th,en');

    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Nominatim ตอบกลับ ${res.status}`);

    const data = await res.json();
    const a = data.address || {};
    const road = a.road || a.pedestrian || a.footway || a.neighbourhood;
    const area = a.suburb || a.city_district || a.town || a.city;
    if (road && area) return `${road} (${area})`;
    return road || area || String(data.display_name || '').split(',')[0] || '';
  }

  return { search, reverse };
})();
