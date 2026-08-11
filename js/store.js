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
    following: false,
    simulating: false,
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

  function select(id) {
    state.selectedId = id;
    emit('select');
  }

  function setUserPosition(coord, heading) {
    state.userPosition = coord;
    if (typeof heading === 'number' && !Number.isNaN(heading)) {
      state.userHeading = heading;
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

  function visibleReports() {
    return state.reports.filter((r) => state.activeTypes.has(r.type));
  }

  /** รายงานที่มองเห็น เรียงตามระยะห่างจากจุดอ้างอิง */
  function sortedByDistance(origin) {
    const list = visibleReports().map((r) => ({
      ...r,
      distance: origin ? U.distance(origin, [r.lng, r.lat]) : null,
    }));
    list.sort((a, b) => {
      if (a.distance == null || b.distance == null) return b.createdAt - a.createdAt;
      return a.distance - b.distance;
    });
    return list;
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
    const raw = [
      ['accident', 'high', 100.5389, 13.7452, 'ถนนพระราม 1 (แยกราชประสงค์)', 'รถชนท้าย 2 คัน เลนขวาปิด', 12],
      ['flood', 'high', 100.5238, 13.7563, 'ถนนพญาไท', 'น้ำท่วมขังสูงราว 30 ซม. รถเล็กเลี่ยง', 25],
      ['construction', 'medium', 100.5605, 13.7392, 'ถนนสุขุมวิท ซ.24', 'ปิดเลนซ้ายทำท่อ ถึงเที่ยงคืน', 180],
      ['traffic', 'low', 100.5150, 13.7290, 'ถนนสาทรใต้', 'รถติดยาวจากแยกสาทร-นราธิวาส', 8],
      ['pothole', 'medium', 100.5478, 13.7621, 'ถนนเพชรบุรีตัดใหม่', 'หลุมลึกกลางเลน 2 ระวังยางแตก', 320],
      ['police', 'low', 100.5052, 13.7448, 'ถนนราชวิถี', 'ด่านตรวจวัดแอลกอฮอล์', 45],
      ['obstacle', 'medium', 100.5701, 13.7245, 'ถนนพระราม 4', 'เศษวัสดุร่วงจากรถบรรทุก', 30],
      ['fog', 'medium', 100.4890, 13.7702, 'ทางด่วนศรีรัช', 'ฝนตกหนัก ทัศนวิสัยต่ำ', 15],
      ['animal', 'medium', 100.5822, 13.7551, 'ถนนรามคำแหง', 'สุนัขจรจัดวิ่งข้ามถนน', 70],
      ['accident', 'medium', 100.4975, 13.7248, 'ถนนเจริญกรุง', 'จักรยานยนต์ล้ม กีดขวางเลนซ้าย', 95],
      ['flood', 'medium', 100.5566, 13.7811, 'ถนนลาดพร้าว ซ.1', 'น้ำขังผิวถนน ขับช้า', 140],
      ['construction', 'low', 100.5301, 13.7135, 'ถนนนราธิวาสราชนครินทร์', 'งานซ่อมผิวจราจรกลางคืน', 210],
    ];
    return raw.map(([type, severity, lng, lat, road, note, ageMin]) => ({
      id: U.uid(),
      type,
      severity,
      lng,
      lat,
      road,
      note,
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
    select,
    setUserPosition,
    setFollowing,
    setSimulating,
    visibleReports,
    sortedByDistance,
    toGeoJSON,
    resetToSeed,
  };
})();
