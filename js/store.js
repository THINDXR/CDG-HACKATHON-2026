/* คลังข้อมูลรายงานภัย + สถานะแอป (pub/sub อย่างง่าย) */
window.Store = (function () {
  const CFG = window.APP_CONFIG;
  const U = window.Utils;

  const listeners = new Set();

  const state = {
    reports: [],
    activeTypes: new Set(Object.keys(CFG.HAZARD_TYPES)),
    selectedId: null,
    userPosition: null, // [lng, lat]
    userHeading: null,  // องศา
    userSpeed: null,    // เมตร/วินาที (null = ยังไม่รู้)
    following: false,
    simulating: false,
    search: '',
  };

  function emit(reason) {
    listeners.forEach((fn) => fn(state, reason));
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /* ---------- persistence ---------- */

  function load() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(CFG.STORAGE_KEY) || 'null');
    } catch (_) {
      saved = null;
    }
    state.reports = Array.isArray(saved) && saved.length ? saved : seed();
    prune();
    emit('load');
  }

  function persist() {
    try {
      localStorage.setItem(CFG.STORAGE_KEY, JSON.stringify(state.reports));
    } catch (_) {
      /* โหมดส่วนตัวอาจเขียนไม่ได้ — ไม่ถือเป็นข้อผิดพลาดร้ายแรง */
    }
  }

  /** ลบรายงานที่หมดอายุออก */
  function prune() {
    const cutoff = Date.now() - CFG.EXPIRY_HOURS * 3600 * 1000;
    const before = state.reports.length;
    state.reports = state.reports.filter((r) => r.createdAt > cutoff);
    if (state.reports.length !== before) persist();
  }

  /* ---------- mutations ---------- */

  function addReport(input) {
    const type = CFG.HAZARD_TYPES[input.type] ? input.type : 'obstacle';
    const def = CFG.HAZARD_TYPES[type];
    const report = {
      id: U.uid(),
      type,
      severity: input.severity || def.defaultSeverity,
      lng: input.lng,
      lat: input.lat,
      note: (input.note || '').slice(0, 240),
      road: input.road || 'ไม่ระบุถนน',
      radius: input.radius || def.defaultRadius,
      createdAt: Date.now(),
      confirms: 0,
      denies: 0,
      mine: true,
      source: 'user', // ผู้ใช้แจ้งเอง ไม่ใช่จุดที่ระบบคาดการณ์
    };
    state.reports.unshift(report);
    persist();
    emit('add');
    return report;
  }

  function removeReport(id) {
    state.reports = state.reports.filter((r) => r.id !== id);
    if (state.selectedId === id) state.selectedId = null;
    persist();
    emit('remove');
  }

  function vote(id, kind) {
    const r = state.reports.find((x) => x.id === id);
    if (!r) return;
    if (kind === 'up') r.confirms += 1;
    else r.denies += 1;
    persist();
    emit('vote');
  }

  function toggleType(type) {
    if (state.activeTypes.has(type)) state.activeTypes.delete(type);
    else state.activeTypes.add(type);
    emit('filter');
  }

  function setAllTypes(on) {
    state.activeTypes = on ? new Set(Object.keys(CFG.HAZARD_TYPES)) : new Set();
    emit('filter');
  }

  /** แสดงเฉพาะประเภทเดียว — ใช้กับแถบชิปที่กดเลือกทีละอัน */
  function setOnlyType(type) {
    state.activeTypes = new Set([type]);
    emit('filter');
  }

  /** จำนวนรายงานของแต่ละประเภท (ไม่สนตัวกรอง) ใช้ติดตัวเลขบนชิป */
  function countsByType() {
    const out = {};
    for (const r of state.reports) out[r.type] = (out[r.type] || 0) + 1;
    return out;
  }

  function select(id) {
    state.selectedId = id;
    emit('select');
  }

  function setUserPosition(coord, heading, speed) {
    state.userPosition = coord;
    if (typeof heading === 'number' && !Number.isNaN(heading)) {
      state.userHeading = heading;
    }
    // ความเร็วไม่ได้มีมาทุกครั้ง (GPS ตอนอยู่นิ่งมักคืน null) จึงเก็บเฉพาะค่าที่ใช้ได้
    if (typeof speed === 'number' && Number.isFinite(speed) && speed >= 0) {
      state.userSpeed = speed;
    }
    emit('position');
  }

  function setFollowing(on) {
    state.following = on;
    emit('following');
  }

  function setSimulating(on) {
    state.simulating = on;
    emit('simulating');
  }

  /* ---------- selectors ---------- */

  /*
   * ระหว่างนำทาง เก็บ id ของจุดเสี่ยงที่อยู่บนเส้นทางไว้ที่นี่
   * เพื่อให้แผนที่โชว์เฉพาะจุดที่จะวิ่งผ่านจริง ไม่ใช่จุดทั้งเมืองที่ไม่เกี่ยวกับเส้นทาง
   * null = ไม่จำกัด (นอกโหมดนำทาง)
   */
  let routeOnly = null;

  function setRouteFilter(ids) {
    routeOnly = ids ? new Set(ids) : null;
    emit('filter');
  }

  /** รายงานที่ผ่านทั้งตัวกรองประเภทและคำค้น (ใช้ทั้งรายการและหมุดบนแผนที่) */
  function visibleReports() {
    const q = state.search.trim().toLowerCase();
    return state.reports.filter((r) => {
      if (routeOnly && !routeOnly.has(r.id)) return false;
      if (!state.activeTypes.has(r.type)) return false;
      if (!q) return true;
      const label = CFG.HAZARD_TYPES[r.type].label;
      return (
        r.road.toLowerCase().includes(q) ||
        r.note.toLowerCase().includes(q) ||
        label.toLowerCase().includes(q)
      );
    });
  }

  function setSearch(text) {
    state.search = text || '';
    emit('search');
  }

  /** รายงานที่ผ่านตัวกรองประเภท (ไม่สนคำค้น) — ใช้ประเมินความเสี่ยง */
  function typeFilteredReports() {
    return state.reports.filter((r) => state.activeTypes.has(r.type));
  }

  function withDistance(list, origin) {
    const out = list.map((r) => ({
      ...r,
      distance: origin ? U.distance(origin, [r.lng, r.lat]) : null,
    }));
    out.sort((a, b) => {
      if (a.distance == null || b.distance == null) return b.createdAt - a.createdAt;
      return a.distance - b.distance;
    });
    return out;
  }

  /** รายงานที่มองเห็น เรียงตามระยะห่างจากจุดอ้างอิง */
  function sortedByDistance(origin) {
    return withDistance(visibleReports(), origin);
  }

  /* ---------- ประเมินความเสี่ยงของพื้นที่รอบตัว ---------- */

  // รัศมีที่นำมาคิดคะแนน (เมตร) — ไกลกว่านี้ถือว่าไม่กระทบการขับตอนนี้
  const RISK_RADIUS = 5000;

  // เรียงจากรุนแรงมากไปน้อย เพื่อให้ find() คืนระดับแรกที่ถึงเกณฑ์
  const RISK_LEVELS = [
    {
      min: 70, key: 'critical', label: 'อันตรายมาก', color: '#ff3b30',
      advice: 'เสี่ยงสูงมาก แนะนำเลี่ยงเส้นทางนี้ถ้าทำได้',
    },
    {
      min: 45, key: 'high', label: 'เสี่ยงสูง', color: '#ff9f0a',
      advice: 'ลดความเร็วและเว้นระยะห่างให้มากกว่าปกติ',
    },
    {
      min: 20, key: 'medium', label: 'เฝ้าระวัง', color: '#d4a017',
      advice: 'มีจุดต้องระวังใกล้เคียง เผื่อเวลาเดินทางไว้',
    },
    {
      min: 0, key: 'low', label: 'ปลอดภัย', color: '#30d158',
      advice: 'เส้นทางรอบตัวโล่ง ขับขี่ตามปกติอย่างมีสติ',
    },
  ];

  // ระยะที่ถือว่าภัย "ประชิดตัว" — ใช้คิดคะแนนภัยเร่งด่วน (เมตร)
  const RISK_IMMEDIATE = 1500;

  /**
   * คะแนนความเสี่ยง 0-100 จากภัยที่มองเห็นในรัศมี RISK_RADIUS
   *
   * ใช้ค่าที่สูงกว่าระหว่างสองมุมมอง:
   *  - density  = ภาพรวมความหนาแน่นของภัยรอบตัว ใช้เส้นโค้งอิ่มตัว
   *               ไม่ให้เมืองที่มีรายงานเยอะชนเพดาน 100 ตลอดเวลา
   *  - immediate = ภัยรุนแรงที่อยู่ประชิดตัวจุดเดียวก็ทำให้เสี่ยงสูงได้
   */
  function riskAssessment(origin) {
    // ตั้งใจไม่ใช้คำค้น: พิมพ์ชื่อสถานที่ในช่องค้นหาไม่ควรทำให้ความเสี่ยงกลายเป็น "ปลอดภัย"
    const nearby = withDistance(typeFilteredReports(), origin).filter(
      (r) => r.distance == null || r.distance <= RISK_RADIUS
    );

    let raw = 0;
    let immediate = 0;
    let high = 0;
    const byType = {};

    for (const r of nearby) {
      const severity = CFG.SEVERITY[r.severity].weight; // 1-3
      // ยิ่งไกลยิ่งลดเร็ว (กำลังสอง) ภัยที่ 4 กม. แทบไม่มีผล
      const far = r.distance == null ? 0.5 : (1 - r.distance / RISK_RADIUS) ** 2;
      // รายงานที่ถูกปฏิเสธมากกว่ายืนยัน ให้ลดน้ำหนักลง (ต่ำสุด 0.4)
      const trust = Math.max(0.4, (r.confirms + 1) / (r.confirms + r.denies + 1));

      raw += severity * (0.15 + 0.85 * far) * trust;

      if (r.distance != null) {
        const closeness = Math.max(0, 1 - r.distance / RISK_IMMEDIATE);
        immediate = Math.max(immediate, (severity / 3) * closeness * trust * 100);
      }

      if (r.severity === 'high') high += 1;
      byType[r.type] = (byType[r.type] || 0) + 1;
    }

    const density = 100 * (1 - Math.exp(-raw / 20));
    const score = Math.round(Math.min(100, Math.max(density, immediate)));
    const dominant = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];

    return {
      score,
      level: RISK_LEVELS.find((l) => score >= l.min),
      count: nearby.length,
      high,
      nearest: nearby.length ? nearby[0] : null,
      dominantType: dominant ? dominant[0] : null,
      radius: RISK_RADIUS,
    };
  }

  /**
   * ความเสี่ยงของ "จุดเดียว" เป็น 0-100 — ใช้ติดป้าย % บนรายการจุดใกล้เคียง
   * เพื่อให้เทียบความน่ากลัวของแต่ละจุดได้ในสายตาเดียว
   * คิดจาก ความรุนแรง × ความใกล้ × ความน่าเชื่อถือของรายงาน
   */
  function pointRisk(report, distance) {
    const severity = CFG.SEVERITY[report.severity].weight / 3;
    const trust = Math.max(0.4, (report.confirms + 1) / (report.confirms + report.denies + 1));
    // อยู่ในรัศมีเตือนของจุดนั้น = ใกล้เต็มร้อย แล้วค่อย ๆ ลดจนหมดที่ RISK_IMMEDIATE
    const near =
      distance == null
        ? 0.6
        : distance <= report.radius
          ? 1
          : Math.max(0, 1 - (distance - report.radius) / RISK_IMMEDIATE);

    return Math.round(Math.min(100, severity * (0.25 + 0.75 * near) * trust * 100));
  }

  function toGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: visibleReports().map((r) => ({
        type: 'Feature',
        id: r.id,
        properties: {
          id: r.id,
          type: r.type,
          severity: r.severity,
          color: CFG.HAZARD_TYPES[r.type].color,
          radius: r.radius,
        },
        geometry: { type: 'Point', coordinates: [r.lng, r.lat] },
      })),
    };
  }

  /* ---------- ข้อมูลตัวอย่างรอบกรุงเทพฯ ---------- */

  function seed() {
    const min = 60 * 1000;
    // คอลัมน์สุดท้ายคือที่มา: user = มีคนแจ้งเข้ามา, predicted = ระบบคาดการณ์เอง
    const raw = [
      ['accident', 'high', 100.5389, 13.7452, 'ถนนพระราม 1 (แยกราชประสงค์)', 'รถชนท้าย 2 คัน เลนขวาปิด', 12, 'user'],
      ['flood', 'high', 100.5238, 13.7563, 'ถนนพญาไท', 'น้ำท่วมขังสูงราว 30 ซม. รถเล็กเลี่ยง', 25, 'user'],
      ['construction', 'medium', 100.5605, 13.7392, 'ถนนสุขุมวิท ซ.24', 'ปิดเลนซ้ายทำท่อ ถึงเที่ยงคืน', 180, 'user'],
      ['traffic', 'low', 100.5150, 13.7290, 'ถนนสาทรใต้', 'ชั่วโมงเร่งด่วน มักติดสะสมจากแยกสาทร', 8, 'predicted'],
      ['pothole', 'medium', 100.5478, 13.7621, 'ถนนเพชรบุรีตัดใหม่', 'หลุมลึกกลางเลน 2 ระวังยางแตก', 320, 'user'],
      ['police', 'low', 100.5052, 13.7448, 'ถนนราชวิถี', 'ด่านตรวจวัดแอลกอฮอล์', 45, 'user'],
      ['obstacle', 'medium', 100.5701, 13.7245, 'ถนนพระราม 4', 'เศษวัสดุร่วงจากรถบรรทุก', 30, 'user'],
      ['fog', 'medium', 100.4890, 13.7702, 'ทางด่วนศรีรัช', 'ช่วงนี้ฝนตกบ่อย ทัศนวิสัยมักลดลง', 15, 'predicted'],
      ['animal', 'medium', 100.5822, 13.7551, 'ถนนรามคำแหง', 'สุนัขจรจัดวิ่งข้ามถนน', 70, 'user'],
      ['accident', 'medium', 100.4975, 13.7248, 'ถนนเจริญกรุง', 'จุดเกิดเหตุซ้ำบ่อยในช่วงเย็น', 95, 'predicted'],
      ['flood', 'medium', 100.5566, 13.7811, 'ถนนลาดพร้าว ซ.1', 'น้ำขังผิวถนน ขับช้า', 140, 'user'],
      ['construction', 'low', 100.5301, 13.7135, 'ถนนนราธิวาสราชนครินทร์', 'งานซ่อมผิวจราจรกลางคืน', 210, 'user'],
    ];
    return raw.map(([type, severity, lng, lat, road, note, ageMin, source]) => ({
      id: U.uid(),
      type,
      severity,
      lng,
      lat,
      road,
      note,
      source,
      radius: CFG.HAZARD_TYPES[type].defaultRadius,
      createdAt: Date.now() - ageMin * min,
      confirms: Math.floor(Math.random() * 12),
      denies: Math.floor(Math.random() * 3),
      mine: false,
    }));
  }

  function resetToSeed() {
    state.reports = seed();
    persist();
    emit('reset');
  }

  return {
    state,
    subscribe,
    load,
    prune,
    addReport,
    removeReport,
    vote,
    toggleType,
    setAllTypes,
    setOnlyType,
    setRouteFilter,
    countsByType,
    setSearch,
    select,
    setUserPosition,
    setFollowing,
    setSimulating,
    visibleReports,
    sortedByDistance,
    riskAssessment,
    pointRisk,
    toGeoJSON,
    resetToSeed,
  };
})();
