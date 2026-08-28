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

  /*
   * ข้อมูลตัวอย่างถูกสุ่มใหม่ทุกครั้งที่เปิดแอป และไม่เคยถูกบันทึกลงเครื่อง
   *
   * ก่อนหน้านี้ seed() ทำงานเฉพาะตอน localStorage ว่าง แล้วผลของมันถูกบันทึกไว้ด้วย
   * ผลคือเปิดครั้งแรกได้ชุดสุ่ม แล้วชุดนั้นค้างอยู่ตลอดไป ซึ่งไม่ต่างอะไรกับ
   * ชุดตายตัวแบบเดิมเลย นอกจากนี้ถ้าผู้ใช้แจ้งเหตุจริงไปแล้วหนึ่งจุด
   * ข้อมูลตัวอย่างจะหายหมดทันที เพราะ saved.length ไม่เป็นศูนย์แล้ว
   *
   * ตอนนี้แยกกันชัดเจน: ตัวอย่างสุ่มสดทุกครั้ง (sample) ส่วนรายงานที่ผู้ใช้
   * แจ้งเองถูกเก็บไว้ตามปกติ แล้ววางต่อท้าย — สองอย่างอยู่ด้วยกันได้
   */
  function load() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(CFG.STORAGE_KEY) || 'null');
    } catch (_) {
      saved = null;
    }
    const mine = Array.isArray(saved) ? saved.filter((r) => !r.sample && !r.demo) : [];
    state.reports = [...seed(), ...mine];
    prune();
    emit('load');
  }

  function persist() {
    try {
      /*
       * ไม่บันทึกสองอย่าง:
       *   demo   จุดของฉากสาธิต มีอายุแค่ตอนเปิดโหมดจำลองการขับ
       *   sample ข้อมูลตัวอย่าง ต้องถูกสุ่มใหม่ทุกครั้งที่เปิดแอป
       */
      localStorage.setItem(
        CFG.STORAGE_KEY,
        JSON.stringify(state.reports.filter((r) => !r.demo && !r.sample)),
      );
    } catch (_) {
      /* โหมดส่วนตัวอาจเขียนไม่ได้ — ไม่ถือเป็นข้อผิดพลาดร้ายแรง */
    }
  }

  /**
   * ใส่จุดของฉากสาธิต (โหมดจำลองการขับ) แบบชั่วคราว
   * ตั้งใจไม่บันทึกลง localStorage และล้างทิ้งทันทีที่ปิดโหมดจำลอง
   * เพื่อไม่ให้ข้อมูลสาธิตปนกับรายงานจริงของผู้ใช้
   */
  function setDemoReports(list) {
    state.reports = [...list.map((r) => ({ ...r, demo: true })), ...state.reports.filter((r) => !r.demo)];
    emit('add');
  }

  function clearDemoReports() {
    if (!state.reports.some((r) => r.demo)) return;
    state.reports = state.reports.filter((r) => !r.demo);
    emit('remove');
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

  /*
   * จุดเสี่ยงจากสถิติก็นับเป็น "ความเสี่ยงรอบตัว" ด้วย
   *
   * ถ้านับเฉพาะรายงานของผู้ใช้ คนที่อยู่นอกพื้นที่ที่มีคนแจ้งเหตุจะเห็น
   * "ปลอดภัย 100% · 0 จุดใกล้เคียง" ตลอดเวลา ซึ่งไม่จริงและไม่มีประโยชน์เลย
   * จุดเสี่ยงจากสถิติมีครบทั้งประเทศ 3,000 จุด จึงตอบได้ทุกที่
   *
   * ใช้รัศมีเดียวกับรายงาน (5 กม.) — ลองใช้ 2 กม. แล้วได้ศูนย์ทุกเมืองที่ทดสอบ
   * เพราะข้อมูลเป็นระดับโครงข่ายทางหลวง จุดจึงห่างกันหลักกิโล ไม่ใช่หลักร้อยเมตร
   * (กรุงเทพฯ จุดใกล้สุดอยู่ 2.0 กม. · ขอนแก่น 5.9 กม.)
   *
   * ถ่วงน้ำหนักต่ำกว่ารายงาน เพราะเป็น "ประวัติที่เคยเกิด"
   * ไม่ใช่ "สิ่งที่กำลังเกิดอยู่ตอนนี้"
   */
  const HOTSPOT_RADIUS = RISK_RADIUS;
  const HOTSPOT_WEIGHT = 0.55;

  // ผู้ให้ข้อมูลจุดเสี่ยงจากสถิติ — app.js เป็นคนเสียบให้ตอนบูต
  // ทำแบบนี้เพื่อไม่ให้ store.js ต้องรู้จัก Hotspots โดยตรง (ยังทดสอบแยกได้)
  let hotspotProvider = null;

  function setHotspotProvider(fn) {
    hotspotProvider = fn;
  }

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

  /*
   * ระดับความเสี่ยงจากคะแนน — เปิดให้เรียกจากข้างนอกได้
   * เพราะ ui.js ต้องหาระดับใหม่หลังเอาผลโมเดลพยากรณ์มาปรับคะแนนแล้ว
   */
  function riskLevelFor(score) {
    return RISK_LEVELS.find((l) => score >= l.min);
  }

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

    /*
     * บวกจุดเสี่ยงจากสถิติเข้าไปในกองเดียวกัน
     *
     * severity ของจุดสถิติคือ ตาย×10 + เจ็บ ซึ่งสเกลคนละแบบกับน้ำหนัก 1-3
     * ของรายงาน จึงบีบด้วยเส้นโค้งอิ่มตัวก่อน (60 คือกลุ่มหัวแถวจริง ๆ)
     * ให้จุดที่หนักมากมีเพดาน ไม่ใช่กลบทุกอย่างด้วยตัวเดียว
     */
    const hotspots = hotspotProvider ? hotspotProvider(origin, HOTSPOT_RADIUS) : [];
    for (const h of hotspots) {
      const weight = Math.min(1, h.severity / 60) * 3;
      const far = (1 - h.distance / HOTSPOT_RADIUS) ** 2;
      raw += weight * (0.15 + 0.85 * far) * HOTSPOT_WEIGHT;
    }

    const density = 100 * (1 - Math.exp(-raw / 20));
    const score = Math.round(Math.min(100, Math.max(density, immediate)));
    const dominant = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];

    return {
      score,
      level: riskLevelFor(score),
      count: nearby.length,
      high,
      nearest: nearby.length ? nearby[0] : null,
      dominantType: dominant ? dominant[0] : null,
      radius: RISK_RADIUS,
      // แยกตัวเลขจุดสถิติออกมา เพื่อให้หน้าจอบอกได้ว่าคะแนนมาจากอะไรบ้าง
      hotspotCount: hotspots.length,
      hotspotRadius: HOTSPOT_RADIUS,
      nearestHotspot: hotspots.length ? hotspots[0] : null,
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

  /*
   * ถนนจริงในกรุงเทพฯ พร้อมพิกัดคร่าว ๆ
   *
   * ต้องผูกชื่อถนนกับพิกัดไว้ด้วยกัน ไม่ใช่สุ่มแยกกัน — ไม่งั้นจะได้รายงาน
   * "ถนนสุขุมวิท" ที่ปักอยู่กลางฝั่งธนฯ ซึ่งดูออกทันทีว่าเป็นข้อมูลปลอม
   */
  const DEMO_ROADS = [
    ['ถนนพระราม 1 (แยกราชประสงค์)', 100.5389, 13.7452],
    ['ถนนพญาไท', 100.5238, 13.7563],
    ['ถนนสุขุมวิท ซ.24', 100.5605, 13.7392],
    ['ถนนสาทรใต้', 100.5150, 13.7290],
    ['ถนนเพชรบุรีตัดใหม่', 100.5478, 13.7621],
    ['ถนนราชวิถี', 100.5052, 13.7448],
    ['ถนนพระราม 4', 100.5701, 13.7245],
    ['ทางด่วนศรีรัช', 100.4890, 13.7702],
    ['ถนนรามคำแหง', 100.5822, 13.7551],
    ['ถนนเจริญกรุง', 100.4975, 13.7248],
    ['ถนนลาดพร้าว ซ.1', 100.5566, 13.7811],
    ['ถนนนราธิวาสราชนครินทร์', 100.5301, 13.7135],
    ['ถนนวิภาวดีรังสิต', 100.5605, 13.7935],
    ['ถนนสีลม', 100.5228, 13.7268],
    ['ถนนเจริญนคร', 100.5085, 13.7126],
    ['ถนนบรมราชชนนี', 100.4562, 13.7789],
    ['ถนนงามวงศ์วาน', 100.5382, 13.8462],
    ['ถนนอโศกมนตรี', 100.5601, 13.7375],
    ['ถนนจรัญสนิทวงศ์', 100.4757, 13.7628],
    ['ถนนพหลโยธิน (แยกลาดพร้าว)', 100.5620, 13.8163],
  ];

  /* ข้อความรายงานที่คนจริงน่าจะพิมพ์ แยกตามประเภทภัย */
  const DEMO_NOTES = {
    accident: ['รถชนท้าย 2 คัน เลนขวาปิด', 'มอเตอร์ไซค์ล้ม มีคนบาดเจ็บ', 'รถเสียจอดขวางเลนกลาง'],
    flood: ['น้ำท่วมขังสูงราว 30 ซม. รถเล็กเลี่ยง', 'น้ำขังผิวถนน ขับช้า', 'ระบายไม่ทัน รถเก๋งผ่านลำบาก'],
    construction: ['ปิดเลนซ้ายทำท่อ ถึงเที่ยงคืน', 'งานซ่อมผิวจราจรกลางคืน', 'วางกรวยปิดหนึ่งเลน'],
    pothole: ['หลุมลึกกลางเลน 2 ระวังยางแตก', 'ผิวถนนเป็นคลื่น ขับช้า ๆ', 'หลุมริมเลนซ้าย มอไซค์ระวัง'],
    obstacle: ['เศษวัสดุร่วงจากรถบรรทุก', 'กิ่งไม้หักขวางเลนซ้าย', 'ยางรถบรรทุกตกอยู่กลางถนน'],
    traffic: ['ติดยาวจากแยกหน้า', 'ชั่วโมงเร่งด่วน รถแน่นมาก', 'ไฟแดงนาน รถสะสม'],
    police: ['ด่านตรวจวัดแอลกอฮอล์', 'ด่านตรวจใบขับขี่', 'ตั้งด่านริมทาง'],
    fog: ['ฝนตกหนัก ทัศนวิสัยลดลง', 'หมอกลงจัด มองไม่ค่อยเห็น', 'ควันจากข้างทาง บังสายตา'],
    animal: ['สุนัขจรจัดวิ่งข้ามถนน', 'แมวนอนอยู่กลางเลน', 'ฝูงนกลงกินอาหารบนถนน'],
  };

  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const between = (lo, hi) => lo + Math.random() * (hi - lo);

  /*
   * ข้อมูลตัวอย่างรอบกรุงเทพฯ — สุ่มใหม่ทุกครั้ง
   *
   * ตั้งใจสุ่มแทนที่จะเขียนตายตัว เพราะชุดตายตัวชุดเดิมทำให้ดูเหมือน
   * แอปมีข้อมูลอยู่แค่ 12 จุดตลอดกาล ของจริงรายงานเข้ามาไม่ซ้ำกันทุกวัน
   *
   * ทุกรายการเป็น source 'user' ล้วน — จุดที่มาจากระบบมี ชั้น Hotspots
   * ซึ่งเป็นสถิติจริงดูแลอยู่แล้ว ไม่ต้องปลอมข้อมูลฝั่งนั้นขึ้นมาอีก
   */
  function seed() {
    const min = 60 * 1000;
    const types = Object.keys(CFG.HAZARD_TYPES);
    const roads = [...DEMO_ROADS].sort(() => Math.random() - 0.5);
    const count = 10 + Math.floor(Math.random() * 6); // 10-15 รายการ

    return roads.slice(0, count).map(([road, baseLng, baseLat]) => {
      const type = pick(types);
      const def = CFG.HAZARD_TYPES[type];

      // ขยับจากจุดอ้างอิงเล็กน้อย (~ไม่เกิน 400 ม.) ให้ไม่ซ้อนที่เดิมเป๊ะทุกครั้ง
      const lng = Number((baseLng + between(-0.0035, 0.0035)).toFixed(5));
      const lat = Number((baseLat + between(-0.0035, 0.0035)).toFixed(5));

      /*
       * ความรุนแรงอิงค่าตั้งต้นของประเภทนั้นเป็นหลัก แล้วเบี่ยงบ้าง
       * ถ้าสุ่มอิสระ จะได้ "ด่านตรวจ = อันตราย" ซึ่งไม่สมเหตุสมผล
       */
      const severity = Math.random() < 0.7
        ? def.defaultSeverity
        : pick(Object.keys(CFG.SEVERITY));

      // อายุกระจายทั้งช่วง แต่เอนไปทางเพิ่งแจ้ง เพราะรายงานเก่าจะหมดอายุไปเอง
      const ageMin = Math.round(between(2, 60) * (Math.random() < 0.35 ? 5 : 1));

      return {
        id: U.uid(),
        type,
        severity,
        lng,
        lat,
        road,
        note: pick(DEMO_NOTES[type] || ['พบสิ่งผิดปกติบนถนน']),
        source: 'user',
        // ธงบอกว่าเป็นข้อมูลตัวอย่าง จะได้ไม่ถูกบันทึก และถูกสุ่มใหม่ทุกครั้งที่เปิด
        sample: true,
        radius: def.defaultRadius,
        createdAt: Date.now() - ageMin * min,
        confirms: Math.floor(Math.random() * 12),
        denies: Math.floor(Math.random() * 3),
        mine: false,
      };
    });
  }

  /*
   * ปุ่ม "รีเซ็ตข้อมูลตัวอย่าง" — สุ่มชุดใหม่ และล้างรายงานที่ผู้ใช้แจ้งเองด้วย
   * (persist() จะเขียนทับด้วยรายการว่าง เพราะชุดใหม่ทั้งหมดเป็น sample)
   */
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
    setDemoReports,
    clearDemoReports,
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
    riskLevelFor,
    setHotspotProvider,
    pointRisk,
    toGeoJSON,
    resetToSeed,
  };
})();
