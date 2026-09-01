/*
 * จุดเสี่ยงจริงจากสถิติอุบัติเหตุ — ชั้นข้อมูลบนแผนที่
 *
 * ต่างจากหมุดรายงานของผู้ใช้อย่างสิ้นเชิง จึงต้องแยกให้ผู้ใช้เห็นชัด:
 *
 *   หมุดรายงาน  สิ่งที่เกิด "ตอนนี้" คนแจ้งเอง หมดอายุใน 12 ชม.
 *   ชั้นนี้      สิ่งที่เกิด "ซ้ำ ๆ มา 4 ปี" จากสถิติราชการ ไม่มีวันหมดอายุ
 *
 * ข้อมูลมาจาก data/ai/hotspots.json ซึ่งสร้างจากอุบัติเหตุจริง 100,056 เหตุการณ์
 * บนโครงข่ายถนนกระทรวงคมนาคม ปี 2565-2569 จัดกลุ่มด้วยกริดราว 500 ม.
 * และตัดเฉพาะจุดที่เกิดซ้ำอย่างน้อย 4 ครั้ง — จุดที่เกิดครั้งเดียวไม่ใช่ "จุดเสี่ยง"
 *
 * ตอนซูมออกวาดเป็นวงกลม เพราะ 3,000 จุดถ้าเป็นหมุดจะบังแผนที่จนอ่านอะไรไม่ได้
 * ซูมเข้าจึงเปลี่ยนเป็นหมุดไอคอน
 *
 * การอ่านแบ่งเป็นสองแกน: สีกับไอคอนบอก "ประเภทความเสี่ยง" (ทางโค้ง/ทางแยก/…)
 * ส่วนขนาดกับตัวเลขบนป้ายบอก "ความรุนแรงและความถี่"
 */
window.Hotspots = (function () {
  const U = window.Utils;

  const SOURCE = 'accident-hotspots';
  const LAYER_GLOW = 'accident-hotspot-glow';
  const LAYER_DOT = 'accident-hotspot-dot';

  let data = null;
  let visible = false;
  let loading = null;

  /*
   * เกณฑ์แบ่งระดับจาก severity_score = ตาย×10 + เจ็บ
   * ตัวเลขเลือกจากการกระจายจริงของข้อมูล ไม่ใช่เลขกลม ๆ:
   * จุดส่วนใหญ่อยู่ต่ำกว่า 20 ส่วนที่เกิน 60 คือกลุ่มหัวแถวจริง ๆ
   */
  function levelOf(severity) {
    if (severity >= 60) return { key: 'critical', label: 'ระวังให้มาก', color: '#ff3b30' };
    if (severity >= 25) return { key: 'high', label: 'เสี่ยงสูง', color: '#ff9f0a' };
    return { key: 'medium', label: 'ต้องระวัง', color: '#d4a017' };
  }

  /* ---------- ประเภทความเสี่ยง ---------- */

  /*
   * แบ่งจุดเสี่ยงตาม "ทำไมตรงนี้ถึงอันตราย" ไม่ใช่แค่ "อันตรายแค่ไหน"
   *
   * ข้อมูล MOT บันทึกทั้งลักษณะทาง (ทางโค้ง/ทางแยก/ลาดชัน) และสาเหตุ
   * (ขับเร็ว/หลับใน/ตัดหน้า) ของทุกเหตุการณ์ เราสรุปเป็นค่าที่พบบ่อยที่สุด
   * ของแต่ละจุดไว้แล้วตอน export
   *
   * ให้ลักษณะทางมาก่อนสาเหตุ เพราะมันคือคุณสมบัติของ "สถานที่"
   * ซึ่งเป็นสิ่งที่คนขับเตรียมตัวรับมือได้ล่วงหน้า ส่วนสาเหตุอย่าง "ขับเร็ว"
   * พบใน 86% ของทุกจุด ถ้าใช้เป็นเกณฑ์หลักจะได้ก้อนเดียวใหญ่ ๆ แบ่งอะไรไม่ได้
   *
   * สีกับไอคอนสื่อ "ประเภท" ส่วนขนาดหมุดกับตัวเลขบนป้ายสื่อ "ความรุนแรง/ความถี่"
   * แยกสองแกนกันชัด ๆ จะได้อ่านพร้อมกันได้โดยไม่สับสน
   *
   * ค่า icon ตรงนี้เป็น "ชื่อไอคอน" ต้องส่งผ่าน Icons.get() ก่อนใช้
   * (ต่างจาก HAZARD_TYPES ใน config.js ที่เก็บมาร์กอัป SVG ไว้เลย)
   *
   * สีทุกตัวหยิบมาจากชุดสีประเภทภัยใน config.js ไม่ได้คิดสีใหม่
   * แผนที่จะได้มีโทนเดียวกันทั้งใบ ผู้ใช้ไม่ต้องเรียนรู้ระบบสีที่สอง
   *
   *   แดง #ff453a  ทางโค้ง · ทางแยก · ทางลาดชัน · ทางตรงใช้ความเร็ว
   *                ทั้งสี่แบบคือ "ชนแล้วเจ็บ" เหมือนกัน แยกกันด้วยไอคอน
   *   เทา #8e8e93  ทัศนวิสัย (สีเดียวกับประเภท "ทัศนวิสัยต่ำ" ของแอป)
   */
  const CATEGORIES = {
    /*
     * cause = ปัจจัยของ "ตรงนี้" ที่ทำให้เกิดเหตุ
     *
     * ประเภทพวกนี้ถูกจัดจากลักษณะทางหรือช่วงเวลาที่เกิดเหตุ ไม่ใช่จากสาเหตุ
     * ส่วนสาเหตุดิบที่ต้นทางบันทึกส่วนใหญ่เป็น "ขับเร็วเกินกำหนด" ซึ่งพบใน 86%
     * ของทุกจุด บอกไปก็ไม่ได้ช่วยให้รู้ว่าตรงนี้ต่างจากที่อื่นยังไง
     *
     * ที่ไม่มี cause (ทางตรงใช้ความเร็ว) จะใช้สาเหตุจริงจากข้อมูลแทน
     */
    curve: { key: 'curve', label: 'ทางโค้ง', action: 'ลดความเร็วก่อนเข้าโค้ง', color: '#ff453a', icon: 'turnRight',
      cause: 'สภาพถนนอันตราย',
      hint: 'เข้าโค้งเร็วเกินจนเสียการควบคุม — เบรกให้เสร็จก่อนถึงโค้ง ไม่ใช่ระหว่างโค้ง' },
    junction: { key: 'junction', label: 'ทางแยก', action: 'ระวังรถตัดหน้า', color: '#ff453a', icon: 'roundabout',
      cause: 'การตัดหน้ากระชั้นชิด',
      hint: 'ชนกันตรงจุดตัด — ชะลอก่อนถึงแยกและมองรถที่มาจากทางขวางเสมอ' },
    slope: { key: 'slope', label: 'ทางลาดชัน', action: 'ลงเนิน ใช้เกียร์ต่ำช่วยเบรก', color: '#ff453a', icon: 'trendDown',
      cause: 'ความลาดชันสูงเกินมาตรฐาน',
      hint: 'เหยียบเบรกยาวตอนลงเนินจนเบรกไหม้ — ใช้เกียร์ต่ำหน่วงแทน' },
    night: { key: 'night', label: 'ทัศนวิสัย', action: 'ทัศนวิสัยต่ำ ชะลอความเร็ว', color: '#8e8e93', icon: 'fog',
      cause: 'คุณภาพการมองเห็นต่ำ',
      hint: 'เกิดตอนมืดเป็นส่วนใหญ่ — ลดความเร็วให้หยุดได้ในระยะที่ไฟหน้าส่องถึง' },
    speed: { key: 'speed', label: 'ทางตรง ใช้ความเร็ว', action: 'ลดความเร็ว', color: '#ff453a', icon: 'speed',
      hint: 'ทางโล่งทำให้เร่งเกินตัว ชนแล้วรุนแรงกว่าปกติ — คุมความเร็วตามป้าย' },
  };

  const CATEGORY_ORDER = ['curve', 'junction', 'slope', 'night', 'speed'];

  // เกินสัดส่วนนี้ถือว่าจุดนี้เป็นปัญหา "ตอนมืด" ไม่ใช่ปัญหาตลอดวัน
  // 60% สูงกว่าสัดส่วนชั่วโมงมืดในหนึ่งวัน (12/24) พอสมควร จึงไม่ใช่แค่ความบังเอิญ
  const NIGHT_SHARE = 0.6;

  /*
   * ข้อความสาเหตุจากต้นทางเป็นภาษาราชการและซ้ำซ้อนกันเอง
   *
   * ในข้อมูลจริงมี 31 แบบ แต่หลายคู่คือเรื่องเดียวกันแค่พิมพ์ต่างกัน เช่น
   * "ขับรถเร็วเกินอัตรากำหนด" (2,322 จุด) กับ "ขับรถเร็วเกินอัตราที่กำหนด" (253 จุด)
   * ถ้าโชว์ดิบ ๆ ผู้ใช้จะเห็นสองอันนี้เป็นคนละสาเหตุ ทั้งที่เป็นอันเดียวกัน
   *
   * ตารางนี้รวมคู่ซ้ำและตัดคำเยิ่นเย้อออก ให้เหลือสั้นพอที่จะอ่านจบในแวบเดียว
   * เรียงจากรูปแบบเฉพาะไปหากว้าง เพราะเทียบแบบ "มีคำนี้อยู่ในข้อความ"
   */
  const CAUSE_TEXT = [
    ['ขับรถเร็วเกินอัตรา', 'ขับเร็วเกินกำหนด'],
    ['ตัดหน้ากระชั้นชิด', 'ถูกตัดหน้ากระชั้นชิด'],
    ['ตัดหน้าระยะกระชั้นชิด', 'ถูกตัดหน้ากระชั้นชิด'],
    ['กระชั้นชิด', 'ขับตามคันหน้ากระชั้นชิด'],
    ['หลับใน', 'หลับใน'],
    ['เมื่อยล้า', 'ขับขณะอ่อนล้า'],
    ['ละสายตา', 'ละสายตาจากถนน'],
    ['ป้ายหยุด', 'ฝ่าฝืนป้ายหยุดตรงทางแยก'],
    ['สัญญาณไฟ', 'ฝ่าฝืนสัญญาณไฟ'],
    ['มีสิทธิ์ไปก่อน', 'ไม่ให้ทางรถที่มีสิทธิ์ก่อน'],
    ['ยาง', 'ยางแตกหรือยางเสื่อม'],
    ['ห้ามล้อ', 'เบรกขัดข้อง'],
    ['เบรค', 'เบรกขัดข้อง'],
    ['อุปกรณ์ยานพาหนะ', 'อุปกรณ์รถบกพร่อง'],
    ['ถนนลื่น', 'ถนนลื่น'],
    ['สูญเสียการควบคุม', 'เสียการควบคุมรถ'],
    ['ไม่ชำนาญ', 'ขับไม่ชำนาญ หรือไม่คุ้นเส้นทาง'],
    ['เมาสุรา', 'เมาแล้วขับ'],
    ['ย้อนศร', 'ขับย้อนศร'],
    ['แซง', 'แซงในที่ห้ามแซง'],
    ['ทางโค้งอันตราย', 'เข้าโค้งเร็วเกินไป'],
    ['แสงสว่างไม่เพียงพอ', 'แสงสว่างไม่พอตอนกลางคืน'],
    ['ทัศนวิสัยกลางคืน', 'แสงสว่างไม่พอตอนกลางคืน'],
    ['สัญญาณเข้าจอด', 'ไม่ให้สัญญาณตอนเข้า-ออกที่จอด'],
    ['บรรทุกเกิน', 'บรรทุกเกินพิกัด'],
  ];

  function cleanCause(raw) {
    if (!raw) return null;
    for (const [needle, text] of CAUSE_TEXT) {
      if (raw.includes(needle)) return text;
    }
    return raw;
  }

  function classify(h) {
    const geo = h.geometry || '';
    const cause = h.cause || '';

    if (geo.includes('ทางโค้ง')) return CATEGORIES.curve;
    if (geo.includes('ทางแยก') || geo.includes('สี่แยก') || geo.includes('ทางเชื่อม')) {
      return CATEGORIES.junction;
    }
    /*
     * ต้องเทียบ "ที่ลาดชัน" / "ช่วงลาดชัน" ไม่ใช่แค่ "ลาดชัน"
     * เพราะค่าที่พบบ่อยที่สุดในข้อมูลคือ "ทางตรง+ไม่มีความลาดชัน" (2,137 จุด)
     * ซึ่งมีคำว่า "ลาดชัน" อยู่ในนั้นด้วย — เทียบหลวม ๆ แล้วจะจัดผิดเป็น 72% ของทั้งหมด
     */
    if (geo.includes('ที่ลาดชัน') || geo.includes('ช่วงลาดชัน')) return CATEGORIES.slope;

    // สาเหตุที่ระบุเรื่องแสง/ทัศนวิสัยตรง ๆ เชื่อได้กว่าการเดาจากสัดส่วนเวลากลางคืน
    if (cause.includes('แสงสว่างไม่เพียงพอ') || cause.includes('ทัศนวิสัย')) {
      return CATEGORIES.night;
    }
    if (h.nightShare >= NIGHT_SHARE) return CATEGORIES.night;

    return CATEGORIES.speed;
  }

  async function load() {
    if (data) return data;
    if (loading) return loading;
    loading = fetch('data/ai/hotspots.json')
      .then((r) => {
        if (!r.ok) throw new Error(`โหลดจุดเสี่ยงไม่สำเร็จ (HTTP ${r.status})`);
        return r.json();
      })
      .then((doc) => {
        data = doc;
        return doc;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
    return loading;
  }

  function toGeoJson(doc) {
    const features = [];
    doc.hotspots.forEach((h, i) => {
      // ตอนนำทางจะเหลือเฉพาะจุดบนเส้นทาง จุดอื่นไม่ต้องส่งเข้าแผนที่เลย
      if (!allowed(i)) return;
      features.push({
        type: 'Feature',
        id: i,
        geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
        properties: {
          ...h,
          color: classify(h).color,
          category: classify(h).key,
          // เก็บดัชนีไว้หา record เต็มตอนคลิก จะได้ไม่ต้องยัดทุกฟิลด์เข้า properties
          idx: i,
        },
      });
    });
    return { type: 'FeatureCollection', features };
  }

  function addLayers(map, geojson) {
    if (!map.getSource(SOURCE)) {
      map.addSource(SOURCE, { type: 'geojson', data: geojson });
    } else {
      map.getSource(SOURCE).setData(geojson);
    }

    /*
     * วงเรืองข้างใต้ — ทำให้จุดที่รุนแรงกว่า "เด้ง" ออกมาตั้งแต่ซูมออก
     * รัศมีผูกกับทั้งซูมและความรุนแรง ไม่งั้นตอนซูมออกทั้งประเทศจะกลายเป็นแผ่นสีเดียว
     */
    if (!map.getLayer(LAYER_GLOW)) {
      map.addLayer({
        id: LAYER_GLOW,
        type: 'circle',
        source: SOURCE,
        paint: {
          'circle-color': ['get', 'color'],
          'circle-blur': 1,
          'circle-opacity': [
            'interpolate', ['linear'], ['zoom'],
            5, 0.18,
            10, 0.3,
            16, 0.22,
          ],
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            5, ['interpolate', ['linear'], ['get', 'severity'], 10, 2, 100, 6],
            11, ['interpolate', ['linear'], ['get', 'severity'], 10, 6, 100, 18],
            16, ['interpolate', ['linear'], ['get', 'severity'], 10, 16, 100, 44],
          ],
        },
      });
    }

    if (!map.getLayer(LAYER_DOT)) {
      map.addLayer({
        id: LAYER_DOT,
        type: 'circle',
        source: SOURCE,
        paint: {
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.9,
          'circle-stroke-width': 1,
          'circle-stroke-color': 'rgba(0,0,0,0.5)',
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            5, 1.6,
            11, ['interpolate', ['linear'], ['get', 'severity'], 10, 2.5, 100, 6],
            16, ['interpolate', ['linear'], ['get', 'severity'], 10, 6, 100, 14],
          ],
        },
      });
    }
  }

  /* ---------- หมุดไอคอน (ตอนซูมเข้า) ---------- */

  /*
   * ซูมใกล้กว่านี้จึงเปลี่ยนจากวงกลมเป็นหมุดไอคอนแบบเดียวกับหมุดรายงาน
   *
   * ทำเป็นหมุดทั้ง 3,000 จุดพร้อมกันไม่ได้ — maplibre ใช้ DOM element ต่อหนึ่งหมุด
   * สามพันตัวทำให้แผนที่หนืดจนลากไม่ไหว จึงสร้างเฉพาะจุดที่อยู่ในกรอบจอตอนนั้น
   * และจำกัดจำนวนไว้ เรียงตามความรุนแรงเพื่อให้จุดที่หนักที่สุดได้ที่เสมอ
   *
   * ตอนซูมออกยังเป็นวงกลมเหมือนเดิม เพราะที่ระดับนั้นสิ่งที่ต้องการคือ
   * "เห็นภาพรวมว่ากระจุกตรงไหน" ไม่ใช่อ่านรายจุด
   */
  const PIN_ZOOM = 12.5;
  const MAX_PINS = 140;

  const pins = new Map(); // index -> maplibregl.Marker
  let pinsBound = false;

  function buildPin(h, idx) {
    const cat = classify(h);
    const wrap = U.el('div', 'hazard-marker');
    wrap.style.setProperty('--pin-color', cat.color);
    // ใช้ค่าเดียวกับหมุดที่ระบบคาดการณ์ จะได้ขอบประเหมือนกัน
    // ผู้ใช้แยกออกทันทีว่าไม่ใช่รายงานที่คนแจ้งเข้ามา
    wrap.dataset.source = 'stat';

    const pin = U.el('div', 'hazard-marker__pin');
    const icon = U.el('span', 'hazard-marker__icon');
    icon.innerHTML = window.Icons.get(cat.icon);
    pin.appendChild(icon);

    /*
     * ป้ายบนขวา = ที่มา
     * ใช้ไอคอน spark สีฟ้าชุดเดียวกับที่ธีมใช้บอก "ระบบคาดการณ์" อยู่แล้ว
     * ผู้ใช้จึงเรียนรู้ครั้งเดียวว่าฟ้า+spark แปลว่ามาจากระบบ ไม่ใช่คนแจ้ง
     */
    const source = U.el('span', 'hazard-marker__badge');
    source.innerHTML = window.Icons.get('spark');
    pin.appendChild(source);

    // ป้ายล่างขวา = จำนวนครั้งที่เกิดจริง เหตุผลที่จุดนี้ถูกเลือกมาแสดง
    const count = U.el('span', 'hazard-marker__badge hazard-marker__badge--count');
    count.textContent = h.accidents > 99 ? '99+' : String(h.accidents);
    pin.appendChild(count);

    wrap.append(pin, U.el('div', 'hazard-marker__shadow'));
    wrap.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onSelect) onSelect(data.hotspots[idx]);
    });
    return wrap;
  }

  function syncPins() {
    const map = window.MapView.instance;
    if (!map || !data) return;

    const active = visible && map.getZoom() >= PIN_ZOOM;
    if (!active) {
      for (const m of pins.values()) m.remove();
      pins.clear();
      if (map.getLayer(LAYER_DOT)) {
        map.setLayoutProperty(LAYER_DOT, 'visibility', visible ? 'visible' : 'none');
      }
      return;
    }

    // จุดกลมกับหมุดซ้อนกันจะรกและอ่านยาก — โชว์ทีละแบบ
    if (map.getLayer(LAYER_DOT)) map.setLayoutProperty(LAYER_DOT, 'visibility', 'none');

    /*
     * คัดด้วยพิกัดบนจอ ไม่ใช่แค่กรอบพิกัดภูมิศาสตร์
     *
     * แผนที่นี้เอียงกล้อง getBounds() จึงคืนกรอบที่กว้างกว่าที่ตาเห็นมาก
     * ถ้าใช้กรอบนั้นอย่างเดียวจะสร้างหมุดให้จุดที่อยู่นอกจอเป็นร้อย
     * แล้วโควตา MAX_PINS จะถูกใช้ไปกับจุดที่ผู้ใช้มองไม่เห็น
     */
    const canvas = map.getCanvas();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const margin = 80;
    const b = map.getBounds();

    const inView = [];
    for (let i = 0; i < data.hotspots.length; i++) {
      if (!allowed(i)) continue;
      const spot = data.hotspots[i];
      if (spot.lon < b.getWest() || spot.lon > b.getEast()) continue;
      if (spot.lat < b.getSouth() || spot.lat > b.getNorth()) continue;
      const pt = map.project([spot.lon, spot.lat]);
      if (pt.x < -margin || pt.x > w + margin) continue;
      if (pt.y < -margin || pt.y > h + margin) continue;
      inView.push(i);
    }
    inView.sort((a, c) => data.hotspots[c].severity - data.hotspots[a].severity);
    const keep = new Set(inView.slice(0, MAX_PINS));

    // ใช้สูตรเดียวกับหมุดรายงานใน map.js เพื่อให้ขนาดเท่ากันทุกระดับซูม
    const scale = Math.max(0.55, Math.min(1.45, 0.55 + (map.getZoom() - 10) * 0.13));

    for (const [idx, marker] of pins) {
      if (!keep.has(idx)) {
        marker.remove();
        pins.delete(idx);
      }
    }
    for (const idx of keep) {
      if (!pins.has(idx)) {
        const spot = data.hotspots[idx];
        const marker = new maplibregl.Marker({ element: buildPin(spot, idx), anchor: 'bottom' })
          .setLngLat([spot.lon, spot.lat])
          .addTo(map);
        pins.set(idx, marker);
      }
      pins.get(idx).getElement().style.setProperty('--marker-scale', scale.toFixed(2));
    }
  }

  function bindPinUpdates(map) {
    if (pinsBound) return;
    pinsBound = true;
    // moveend ครอบคลุมทั้งลากและซูม ไม่ต้องผูก zoomend ซ้ำ
    map.on('moveend', syncPins);
  }

  function setVisible(on) {
    const map = window.MapView.instance;
    if (!map) return;
    visible = on;
    if (map.getLayer(LAYER_GLOW)) {
      map.setLayoutProperty(LAYER_GLOW, 'visibility', on ? 'visible' : 'none');
    }
    syncPins();
  }

  /* เปิดชั้นข้อมูล — โหลดครั้งแรกแล้ว cache ไว้ในหน่วยความจำ */
  async function enable() {
    const map = window.MapView.instance;
    if (!map) return;

    if (!data) {
      const doc = await load();
      addLayers(map, toGeoJson(doc));
      bindClicks(map);
      bindPinUpdates(map);
    }
    setVisible(true);
  }

  async function toggle() {
    if (visible) {
      setVisible(false);
      return false;
    }
    await enable();
    return true;
  }

  /* ---------- คลิกดูรายละเอียด ---------- */

  let onSelect = null;
  let bound = false;

  function bindClicks(map) {
    if (bound) return;
    bound = true;

    map.on('click', LAYER_DOT, (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const h = data.hotspots[f.properties.idx];
      if (onSelect) onSelect(h);
    });

    // เคอร์เซอร์ต้องบอกว่ากดได้ ไม่งั้นผู้ใช้ไม่รู้ว่าจุดพวกนี้แตะได้
    map.on('mouseenter', LAYER_DOT, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', LAYER_DOT, () => {
      map.getCanvas().style.cursor = '';
    });
  }

  /* ---------- กรองให้เหลือเฉพาะที่อยู่บนเส้นทาง ---------- */

  /*
   * ระหว่างนำทาง จุดเสี่ยงทั้งเมืองไม่เกี่ยวกับการขับตอนนี้ มีแต่จะรกและดึงสายตา
   * จึงเหลือเฉพาะจุดที่อยู่ริมเส้นทางที่กำลังจะวิ่งผ่านจริง ๆ
   *
   * ใช้ระยะเดียวกับ RouteRisk.CORRIDOR_M (120 ม.) จะได้ตรงกับชุดจุดที่เอาไป
   * คิดคะแนนความปลอดภัยของเส้นทาง — สิ่งที่เห็นบนแผนที่กับตัวเลขที่โชว์
   * จึงเป็นชุดเดียวกัน ไม่ใช่คนละอย่างที่บังเอิญอยู่ด้วยกัน
   */
  const CORRIDOR_M = 120;

  let routeIndexes = null; // null = ไม่ได้กรอง (โหมดปกติ)

  /*
   * จุดสถิติบนเส้นทาง พร้อมระยะ "along" = วิ่งมากี่เมตรถึงจะถึงจุดนั้น
   *
   * ต้องมีค่านี้ถึงจะเตือนล่วงหน้าได้ เพราะการเทียบระยะตรงจากตัวผู้ใช้อย่างเดียว
   * แยกไม่ออกว่าจุดนั้นอยู่ "ข้างหน้า" หรือ "ผ่านไปแล้ว" — ถ้าเตือนจุดที่ผ่านไปแล้ว
   * ผู้ใช้จะเลิกเชื่อคำเตือนทั้งหมดอย่างรวดเร็ว
   */
  let routeSpots = [];

  /*
   * เส้นทางมีพิกัดเป็นพันจุด ถ้าเทียบทุกจุดกับ hotspot ทั้ง 3,000 จุดตรง ๆ
   * จะเป็นการคำนวณหลักล้านครั้งทุกครั้งที่คำนวณเส้นทางใหม่
   * จึงคัดหยาบด้วยกรอบสี่เหลี่ยมของเส้นทางก่อน แล้วค่อยวัดระยะจริง
   */
  /*
   * หาจุดสถิติที่อยู่ริมเส้นทาง — ฟังก์ชันบริสุทธิ์ ไม่แตะสถานะใด ๆ
   *
   * แยกออกมาเพราะมีสองคนใช้: setRouteFilter() ที่เอาไปกรองสิ่งที่แสดง
   * และโหมดจำลองที่ต้องเทียบหลายเส้นทางก่อนเลือก — ถ้าเทียบด้วยฟังก์ชัน
   * ที่เปลี่ยนสถานะไปด้วย การเทียบเส้นที่สองจะไปลบผลของเส้นแรกทิ้ง
   */
  function matchRoute(coordinates) {
    const out = [];
    if (!coordinates || !coordinates.length || !data) return out;

    const cumulative = [0];
    for (let i = 1; i < coordinates.length; i++) {
      cumulative[i] = cumulative[i - 1] + U.distance(coordinates[i - 1], coordinates[i]);
    }

    let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (const [lng, lat] of coordinates) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
    // เผื่อขอบเท่ากับความกว้างของทางเดิน (องศาโดยประมาณ ~111 กม. ต่อ 1 องศา)
    const pad = CORRIDOR_M / 111000;

    for (let i = 0; i < data.hotspots.length; i++) {
      const h = data.hotspots[i];
      if (h.lon < west - pad || h.lon > east + pad) continue;
      if (h.lat < south - pad || h.lat > north + pad) continue;

      // หาพิกัดบนเส้นทางที่ใกล้จุดนี้ที่สุด เพื่อรู้ว่าอยู่ตรงไหนของเส้น
      let bestDist = Infinity;
      let bestAt = 0;
      for (let k = 0; k < coordinates.length; k++) {
        const d = U.distance([h.lon, h.lat], coordinates[k]);
        if (d < bestDist) {
          bestDist = d;
          bestAt = k;
        }
      }
      if (bestDist > CORRIDOR_M) continue;

      out.push({ idx: i, at: bestAt, along: cumulative[bestAt], offset: bestDist });
    }

    out.sort((a, b) => a.along - b.along);
    return out;
  }

  /*
   * น้ำหนักความเสี่ยงของทั้งเส้นทางตามที่โมเดลชี้ — ไม่ใช่แค่ "กี่จุด"
   *
   * นับจำนวนอย่างเดียวทำให้เส้นที่ผ่านจุดเล็ก ๆ สิบจุด ดูเสี่ยงกว่าเส้นที่ผ่าน
   * จุดที่ตายทุกปีจุดเดียว ซึ่งไม่ตรงกับความจริง จึงถ่วงด้วย severity_score
   * (ตาย×10 + เจ็บ) ที่เป็นเกณฑ์เดียวกับที่ใช้แบ่งระดับสีบนแผนที่
   */
  function riskAlongRoute(coordinates) {
    const hits = matchRoute(coordinates);
    const spots = [];
    let weight = 0;
    let worst = 0;
    for (const s of hits) {
      const h = data.hotspots[s.idx];
      spots.push(h);
      weight += h.severity;
      if (h.severity > worst) worst = h.severity;
    }
    // คืนตัวจุดมาด้วย เพราะผู้เรียกที่คิดคะแนนต้องถ่วงน้ำหนักรายจุดเอง
    return { count: hits.length, weight, worst, spots, first: hits[0] || null };
  }

  /* ---------- ต้นทาง-ปลายทางสาธิตที่สร้างจากข้อมูลของโมเดล ---------- */

  /* ระยะจากจุดหนึ่งถึงเส้นตรง a→b (เมตร) — ฉายเป็นระนาบก่อน ระยะสั้นพอที่ความโค้งโลกไม่มีผล */
  function distanceToSegment(p, a, b) {
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos((a[1] * Math.PI) / 180);
    const px = (p[0] - a[0]) * mPerDegLng;
    const py = (p[1] - a[1]) * mPerDegLat;
    const bx = (b[0] - a[0]) * mPerDegLng;
    const by = (b[1] - a[1]) * mPerDegLat;
    const len2 = bx * bx + by * by;
    if (!len2) return Math.hypot(px, py);
    const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
    return Math.hypot(px - bx * t, py - by * t);
  }

  /*
   * เลือกช่วงถนนที่โมเดลชี้ว่าเสี่ยงที่สุดในย่านหนึ่ง แล้วคืนเป็นทริปสาธิต
   *
   * มีไว้ให้โหมดจำลองการขับ "การันตี" ว่าจะได้วิ่งผ่านจุดที่โมเดลทำนายไว้จริง
   * ถ้าใช้ต้นทาง-ปลายทางที่จดไว้ตายตัว วันไหน OSRM เลือกเส้นอื่นก็อาจไม่เจอ
   * จุดเสี่ยงเลยสักจุด แล้วก็ทดสอบระบบเตือนไม่ได้
   *
   * วิธีเลือก: เอาจุดที่รุนแรงที่สุดในย่านนั้นมาจับคู่กัน แล้ววัดว่าเส้นตรง
   * ระหว่างคู่ไหน "ผ่าน" จุดเสี่ยงอื่นรวมน้ำหนักมากที่สุด — ถนนจริงไม่ตรงเป๊ะ
   * แต่ใกล้พอให้ OSRM ลากเส้นทางผ่านกลุ่มจุดนั้น แล้วยืดหัวท้ายออกไปอีกฝั่งละ
   * ประมาณหนึ่งกิโล เพื่อให้มีทางวิ่งเข้าและออกจากกลุ่ม ไม่ใช่เริ่มทับจุดแรกพอดี
   */
  function riskiestTrip(center, opts = {}) {
    if (!data) return null;

    const areaM = opts.areaM || 45000;   // รัศมีย่านที่จะมองหา
    const minM = opts.minM || 3000;      // สั้นกว่านี้ขับไม่ทันเห็นอะไร
    const maxM = opts.maxM || 14000;     // ยาวกว่านี้เดโมนานเกินไป
    const padM = opts.padM || 1200;      // ยืดหัวท้ายให้มีทางวิ่งเข้า-ออก

    const local = [];
    for (const h of data.hotspots) {
      if (U.distance(center, [h.lon, h.lat]) <= areaM) local.push(h);
    }
    if (local.length < 2) return null;

    const anchors = [...local].sort((a, b) => b.severity - a.severity).slice(0, 30);

    let best = null;
    for (let i = 0; i < anchors.length; i++) {
      for (let j = i + 1; j < anchors.length; j++) {
        const a = [anchors[i].lon, anchors[i].lat];
        const b = [anchors[j].lon, anchors[j].lat];
        const span = U.distance(a, b);
        if (span < minM || span > maxM) continue;

        let weight = 0;
        let count = 0;
        for (const h of local) {
          if (distanceToSegment([h.lon, h.lat], a, b) > CORRIDOR_M * 2) continue;
          weight += h.severity;
          count++;
        }
        if (!best || weight > best.weight) best = { a, b, span, weight, count };
      }
    }
    if (!best) return null;

    const brg = U.bearing(best.a, best.b);
    return {
      from: U.destination(best.a, (brg + 180) % 360, padM),
      to: U.destination(best.b, brg, padM),
      count: best.count,
      weight: best.weight,
    };
  }

  function setRouteFilter(coordinates) {
    routeSpots = matchRoute(coordinates);
    routeIndexes = coordinates && coordinates.length && data
      ? new Set(routeSpots.map((s) => s.idx))
      : null;

    const map = window.MapView.instance;
    if (map && map.getSource(SOURCE)) {
      map.getSource(SOURCE).setData(toGeoJson(data));
    }
    syncPins();
  }

  /* จุดที่อนุญาตให้แสดงตอนนี้ — ทั้งหมด หรือเฉพาะที่อยู่บนเส้นทาง */
  function allowed(i) {
    return routeIndexes === null || routeIndexes.has(i);
  }

  /* จำนวนจุดสถิติที่อยู่บนเส้นทาง (0 เมื่อไม่ได้นำทาง) */
  function routeCount() {
    return routeIndexes === null ? 0 : routeIndexes.size;
  }

  /*
   * จุดสถิติบนเส้นทาง เรียงตามลำดับที่จะวิ่งผ่าน พร้อมระยะ along
   *
   * ต่างจาก riskAlongRoute() ที่รับพิกัดเส้นไหนก็ได้มาคิดคะแนน — อันนี้อ่านจาก
   * ตัวกรองของเส้นทางที่กำลังนำทางอยู่ และเรียงตามเส้นทาง เพราะคนขับอ่านรายการ
   * เป็นลำดับ "จุดถัดไปคืออะไร" ไม่ใช่ "จุดไหนหนักสุด"
   */
  function routeSpotsOrdered() {
    if (!data) return [];
    return routeSpots.map((s) => ({ spot: data.hotspots[s.idx], along: s.along, idx: s.idx }));
  }

  /*
   * จุดสถิติที่กำลังจะถึงบนเส้นทาง — เทียบกับระยะที่วิ่งมาแล้ว
   *
   * ใช้ตรรกะเดียวกับ RouteRisk.upcoming() ทุกอย่าง รวมทั้งการยอมให้เลย
   * จุดนั้นไปแล้ว 60 ม. ยังนับว่า "กำลังผ่าน" เพราะ GPS มีความคลาดเคลื่อน
   * ถ้าตัดที่ 0 พอดี การ์ดเตือนจะกะพริบหายตอนขับผ่านจุดนั้นพอดี
   */
  function upcomingOnRoute(travelled, warnAhead) {
    if (!data || !routeSpots.length) return null;
    for (const s of routeSpots) {
      const ahead = s.along - travelled;
      if (ahead < -60) continue;
      if (ahead > warnAhead) break;
      return { spot: data.hotspots[s.idx], ahead: Math.max(0, ahead), idx: s.idx };
    }
    return null;
  }

  /* ---------- คำอธิบายสี ---------- */

  /*
   * ถ้าแบ่งสีแล้วไม่บอกว่าสีไหนคืออะไร ผู้ใช้ก็เดาไม่ออกอยู่ดี
   * legend จึงนับจำนวนจุดจริงของแต่ละประเภทมาแสดงด้วย — บอกทั้งความหมายของสี
   * และสัดส่วนของปัญหาในคราวเดียว
   */
  /*
   * legend อยู่ที่หน้าแดชบอร์ด ไม่ใช่แผ่นรายการ
   *
   * แผ่นรายการมีไว้ตอบ "รอบตัวฉันตอนนี้เป็นยังไง" ซึ่งต้องอ่านเร็วระหว่างขับ
   * ส่วนคำอธิบายสัญลักษณ์เป็นเรื่องที่อ่านครั้งเดียวแล้วจำได้ จึงเหมาะกับ
   * หน้าที่เปิดดูตอนจอด ไม่ใช่มาเบียดพื้นที่ของข้อมูลที่ต้องดูตอนขับ
   *
   * โหลดข้อมูลจุดเสี่ยงยังไม่เสร็จก็แค่ยังไม่โชว์ panel — เปิดแดชบอร์ดซ้ำได้เรื่อย ๆ
   */
  function renderLegend() {
    const box = document.getElementById('hotspotLegend');
    const wrap = document.getElementById('hotspotLegendPanel');
    if (!box || !data) return;
    if (wrap) wrap.hidden = false;

    const counts = new Map(CATEGORY_ORDER.map((k) => [k, 0]));
    for (const h of data.hotspots) {
      const k = classify(h).key;
      counts.set(k, (counts.get(k) || 0) + 1);
    }

    const rows = CATEGORY_ORDER.map((k) => {
      const c = CATEGORIES[k];
      const n = counts.get(k) || 0;
      if (!n) return '';
      return `
        <li class="legend__row" style="--legend-color:${c.color}" title="${U.escapeHtml(c.hint)}">
          <span class="legend__icon">${window.Icons.get(c.icon)}</span>
          <span class="legend__label">${U.escapeHtml(c.label)}</span>
          <span class="legend__count">${n.toLocaleString('th-TH')}</span>
        </li>`;
    }).join('');

    box.hidden = false;
    box.innerHTML = `
      <h4 class="legend__head">จุดเสี่ยงจากสถิติ แบ่งตามประเภท</h4>
      <ul class="legend__list">${rows}</ul>
      <p class="legend__note">
        สีและไอคอนบอก<strong>ประเภท</strong> · ขนาดหมุดกับตัวเลขบนป้ายบอก<strong>ความรุนแรงและจำนวนครั้ง</strong>
      </p>`;
  }

  function hideLegend() {
    const wrap = document.getElementById('hotspotLegendPanel');
    if (wrap) wrap.hidden = true;
  }

  /* ---------- ใช้กับส่วนอื่น ---------- */

  /* จุดเสี่ยงจริงที่อยู่ใกล้พิกัดหนึ่ง เรียงจากใกล้ไปไกล */
  function near(lngLat, radiusM, limit) {
    if (!data) return [];
    const out = [];
    for (const h of data.hotspots) {
      const d = U.distance(lngLat, [h.lon, h.lat]);
      if (d <= (radiusM || 3000)) out.push({ ...h, distance: d });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out.slice(0, limit || 20);
  }

  return {
    load,
    enable,
    toggle,
    setVisible,
    near,
    setRouteFilter,
    routeCount,
    routeSpotsOrdered,
    upcomingOnRoute,
    riskAlongRoute,
    riskiestTrip,
    levelOf,
    classify,
    cleanCause,
    CATEGORIES,
    renderLegend,
    isVisible: () => visible,
    meta: () => data && {
      count: data.hotspots.length,
      total: data.total_groups,
      events: data.events_used,
      range: data.range,
      source: data.source,
    },
    set onSelect(fn) { onSelect = fn; },
  };
})();
