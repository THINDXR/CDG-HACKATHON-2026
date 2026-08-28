/*
 * วิเคราะห์ความเสี่ยง "เฉพาะเส้นทางที่จะวิ่งผ่าน"
 *
 * ต่างจาก Store.riskAssessment() ที่มองเป็นวงกลมรอบตัว — ไฟล์นี้มองเป็นแนวยาว
 * ตามเส้นทาง คือเอาเฉพาะจุดเสี่ยงที่อยู่ริมเส้นทางจริง ๆ แล้วสรุปเป็นรายถนน
 * เพื่อตอบคำถามว่า "ถนนที่เราจะวิ่งผ่านเส้นไหนอันตราย"
 */
window.RouteRisk = (function () {
  const CFG = window.APP_CONFIG;
  const U = window.Utils;

  /* ---------- ประเภทยานพาหนะ ---------- */

  /*
   * OSRM คำนวณเวลาให้ "รถยนต์" เป็นค่าตั้งต้น ค่าที่ใส่ไว้จึงเป็นตัวคูณจากค่านั้น
   *
   * timeFactor  — มอเตอร์ไซค์แทรกช่องจราจรได้ ในเมืองจึงถึงเร็วกว่ารถยนต์ราว 15%
   * riskFactor  — สถิติในไทยชี้ว่าผู้ใช้รถจักรยานยนต์เสี่ยงบาดเจ็บสาหัส/เสียชีวิต
   *               ต่อระยะทางเท่ากันสูงกว่ารถยนต์หลายเท่า ค่าที่ใช้เป็นค่าประมาณ
   *               แบบอนุรักษ์นิยมเพื่อ "เตือน" ไม่ใช่ตัวเลขทางสถิติที่อ้างอิงได้
   */
  const VEHICLES = {
    car: {
      key: 'car',
      label: 'รถยนต์',
      icon: 'car',
      timeFactor: 1,
      riskFactor: 1,
      note: 'เวลาเดินทางอ้างอิงความเร็วรถยนต์ตามสภาพถนน',
    },
    motorbike: {
      key: 'motorbike',
      label: 'มอเตอร์ไซค์',
      icon: 'motorbike',
      timeFactor: 0.85,
      riskFactor: 1.8,
      note: 'ถึงเร็วกว่าแต่เสี่ยงบาดเจ็บสูงกว่า สวมหมวกนิรภัยทุกครั้ง',
    },
  };

  // ห่างจากเส้นทางเกินนี้ถือว่า "คนละถนน" ไม่เอามาคิด (เมตร)
  const CORRIDOR_M = 120;
  // ระยะที่เริ่มเตือนล่วงหน้าก่อนถึงจุดเสี่ยงบนเส้นทาง (เมตร)
  const WARN_AHEAD_M = 500;

  /*
   * ประเภทที่ "ไม่เอามาคิดตอนหาเส้นทางเลี่ยง"
   *
   * ด่านตรวจไม่ใช่อันตรายบนถนน และการช่วยให้คนขับเลี่ยงด่านตรวจวัดแอลกอฮอล์
   * ขัดกับเป้าหมายลดอุบัติเหตุของแอปโดยตรง จึงยังแสดงให้เห็นและยังเตือนตอนใกล้ถึง
   * แต่ไม่นำมาเป็นเหตุผลในการเสนอให้เปลี่ยนเส้นทาง
   */
  const NOT_AVOIDABLE = new Set(['police']);

  /*
   * ความสดของรายงาน — อุบัติเหตุที่เพิ่งเกิด 20 นาทีที่แล้ว สำคัญกว่าที่แจ้งไว้ 11 ชั่วโมง
   * ตอนแค่ "เตือน" ยังพอปล่อยได้ แต่ถ้าจะเอาไปสั่งให้คนขับอ้อมไปอีกหลายกิโล
   * น้ำหนักต้องลดตามอายุ ไม่งั้นรายงานเก่าค้างจะทำให้เส้นทางเพี้ยนทั้งวัน
   *
   * สดใหม่ = 1.0 · 3 ชม. ≈ 0.55 · ครบ 12 ชม. (หมดอายุพอดี) ≈ 0.31
   */
  function freshness(report) {
    const hours = Math.max(0, (Date.now() - report.createdAt) / 3600000);
    return 0.3 + 0.7 * Math.exp(-hours / 3);
  }

  /** น้ำหนักของรายงานหนึ่งจุด = ความรุนแรง × ความน่าเชื่อถือ × ความสด */
  function reportWeight(report) {
    const trust = Math.max(0.4, (report.confirms + 1) / (report.confirms + report.denies + 1));
    return CFG.SEVERITY[report.severity].weight * trust * freshness(report);
  }

  const LEVELS = [
    { min: 70, key: 'critical', label: 'อันตรายมาก', color: '#ff3b30' },
    { min: 45, key: 'high', label: 'เสี่ยงสูง', color: '#ff9f0a' },
    { min: 20, key: 'medium', label: 'ต้องระวัง', color: '#d4a017' },
    { min: 0, key: 'low', label: 'ปลอดภัย', color: '#30d158' },
  ];

  const levelFor = (score) => LEVELS.find((l) => score >= l.min);

  /* ---------- จับคู่จุดเสี่ยงเข้ากับเส้นทาง ---------- */

  /**
   * หาจุดบนเส้นทางที่ใกล้พิกัดหนึ่งที่สุด
   *
   * เดินทีละ vertex ก็พอ เพราะ OSRM คืน geometry ที่ละเอียดอยู่แล้ว
   * (จุดห่างกันหลักสิบเมตร) ไม่ต้องคำนวณระยะถึงเส้นตรงแต่ละช่วง
   */
  function nearestOnRoute(route, coord) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < route.coordinates.length; i++) {
      const d = U.distance(coord, route.coordinates[i]);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return { index: best, offset: bestDist, along: route.cumulative[best] || 0 };
  }

  /** ชื่อถนนของ step ที่ครอบ vertex นี้อยู่ */
  function roadAt(route, index) {
    let name = '';
    for (const step of route.steps) {
      if (step.startIndex <= index) name = step.roadName || name;
      else break;
    }
    return name;
  }

  /**
   * วิเคราะห์เส้นทางหนึ่งเส้น
   * @param {object} route เส้นทางจาก Route.getRoute()
   * @param {string} vehicleKey 'car' | 'motorbike'
   */
  function analyze(route, vehicleKey = 'car') {
    const vehicle = VEHICLES[vehicleKey] || VEHICLES.car;
    const reports = window.Store.state.reports;

    const points = [];
    for (const r of reports) {
      const hit = nearestOnRoute(route, [r.lng, r.lat]);
      if (hit.offset > CORRIDOR_M) continue;
      points.push({
        report: r,
        along: hit.along,
        index: hit.index,
        offset: hit.offset,
        road: roadAt(route, hit.index) || r.road || 'ไม่ระบุถนน',
      });
    }
    points.sort((a, b) => a.along - b.along);

    /*
     * คะแนนรายถนน: รวมน้ำหนักความรุนแรง × ความน่าเชื่อถือของรายงาน
     * แล้วหารด้วยระยะทางที่วิ่งบนถนนนั้น เพื่อไม่ให้ถนนสายยาวเสียเปรียบ
     */
    const roads = new Map();
    for (const p of points) {
      const weight = reportWeight(p.report);

      const entry = roads.get(p.road) || { road: p.road, count: 0, weight: 0, accidents: 0, points: [] };
      entry.count += 1;
      entry.weight += weight;
      if (p.report.type === 'accident') entry.accidents += 1;
      entry.points.push(p);
      roads.set(p.road, entry);
    }

    const roadList = [...roads.values()].map((entry) => {
      // อุบัติเหตุถ่วงน้ำหนักเป็นพิเศษ เพราะคำถามคือ "เสี่ยงเกิดอุบัติเหตุแค่ไหน"
      const raw = (entry.weight + entry.accidents * 1.5) * vehicle.riskFactor;
      const score = Math.round(Math.min(100, 100 * (1 - Math.exp(-raw / 4))));
      return { ...entry, score, level: levelFor(score) };
    });
    roadList.sort((a, b) => b.score - a.score);

    // คะแนนรวมของเส้นทาง = ความหนาแน่นของจุดเสี่ยงต่อ 10 กม.
    const km = Math.max(0.3, route.distance / 1000);
    const scoreFrom = (list) => {
      const total = list.reduce((sum, p) => sum + reportWeight(p.report) +
        (p.report.type === 'accident' ? 1.5 : 0), 0);
      const density = (total / km) * 10 * vehicle.riskFactor;
      return Math.round(Math.min(100, 100 * (1 - Math.exp(-density / 12))));
    };

    const score = scoreFrom(points);
    // คะแนนที่ใช้ตัดสินใจเลี่ยงเส้นทาง — ตัดด่านตรวจออก (ดูคำอธิบายที่ NOT_AVOIDABLE)
    const avoidable = points.filter((p) => !NOT_AVOIDABLE.has(p.report.type));
    const avoidScore = scoreFrom(avoidable);

    const duration = route.duration * vehicle.timeFactor;

    return {
      route,
      vehicle,
      points,
      roads: roadList,
      score,
      avoidScore,
      level: levelFor(score),
      distance: route.distance,
      duration,
      // ความเร็วเฉลี่ยที่ใช้ประมาณเวลา — เอาไว้อธิบายให้ผู้ใช้เห็นที่มา
      avgSpeedKmh: duration > 0 ? (route.distance / 1000) / (duration / 3600) : 0,
      accidents: points.filter((p) => p.report.type === 'accident').length,
      corridor: CORRIDOR_M,
    };
  }

  /* ---------- เตือนจุดเสี่ยงระหว่างนำทาง ---------- */

  /**
   * จุดเสี่ยงถัดไปที่อยู่ "ข้างหน้า" บนเส้นทาง ภายในระยะเตือน
   * @param {object} analysis ผลจาก analyze()
   * @param {number} travelled ระยะที่วิ่งมาแล้วบนเส้นทาง (เมตร)
   */
  function upcoming(analysis, travelled) {
    if (!analysis) return null;
    for (const p of analysis.points) {
      const ahead = p.along - travelled;
      if (ahead < -60) continue;          // ผ่านไปแล้ว
      if (ahead > WARN_AHEAD_M) break;    // ยังอีกไกล (เรียงตามระยะอยู่แล้ว)
      return { ...p, ahead: Math.max(0, ahead) };
    }
    return null;
  }

  /* ---------- เปรียบเทียบเส้นทางเพื่อเสนอทางเลี่ยง ---------- */

  // ต้องปลอดภัยกว่าเดิมอย่างน้อยเท่านี้ ถึงจะคุ้มให้ผู้ใช้เปลี่ยนเส้นทาง (แต้ม)
  const MIN_GAIN = 15;
  // และต้องไม่ช้ากว่าเส้นที่เร็วที่สุดเกินสัดส่วนนี้
  const MAX_SLOWER = 0.2;

  /**
   * เลือกเส้นทางที่ควรแนะนำจากหลายเส้น
   *
   * ตั้งใจไม่เปลี่ยนเส้นทางให้เองเงียบ ๆ — คืนแค่ "ข้อเสนอ" ให้ UI ไปถามผู้ใช้
   * เพราะคะแนนความเสี่ยงของเรายังเป็นค่าประมาณ การบังคับให้คนอ้อมไปหลายกิโล
   * ด้วยตัวเลขที่ยังไม่ได้พิสูจน์นั้นหนักเกินกว่าที่ข้อมูลจะรองรับได้
   *
   * @param {Array<object>} analyses ผลจาก analyze() ของแต่ละเส้น (ตัวแรก = เร็วที่สุด)
   * @returns {{fastest: object, safest: object, shouldSwitch: boolean, gain: number, extraSeconds: number}}
   */
  function compare(analyses) {
    const fastest = analyses[0];
    let safest = fastest;

    for (const a of analyses) {
      const slower = (a.duration - fastest.duration) / Math.max(1, fastest.duration);
      if (slower > MAX_SLOWER) continue;                 // อ้อมไกลเกินไป
      if (a.avoidScore < safest.avoidScore) safest = a;
    }

    const gain = fastest.avoidScore - safest.avoidScore;
    return {
      fastest,
      safest,
      gain,
      extraSeconds: safest.duration - fastest.duration,
      shouldSwitch: safest !== fastest && gain >= MIN_GAIN,
      minGain: MIN_GAIN,
    };
  }

  /* ---------- ระบายสีเส้นทางตามความเสี่ยงของแต่ละช่วง ---------- */

  // ช่วงถนนรอบจุดเสี่ยงที่ถือว่า "ได้รับผลกระทบ" (เมตร ก่อนและหลังจุด)
  const SEGMENT_SPREAD_M = 180;

  const LEVEL_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

  /**
   * หั่นเส้นทางเป็นช่วง ๆ พร้อมระดับความเสี่ยงของช่วงนั้น
   * เอาไปให้แผนที่ระบายสีแบบเดียวกับที่ Google Maps ระบายสีรถติด
   * ต่างกันตรงที่ของเราบอก "ช่วงนี้อันตราย" ไม่ใช่ "ช่วงนี้รถติด"
   *
   * @returns {Array<{coordinates: Array, level: string}>}
   */
  function segments(analysis) {
    const route = analysis?.route;
    if (!route?.coordinates?.length) return [];

    // ให้ระดับกับทุก vertex ตามจุดเสี่ยงที่อยู่ใกล้ในแนวเส้นทาง
    const levels = new Array(route.coordinates.length).fill('low');

    for (const p of analysis.points) {
      // จุดที่เสี่ยงน้อยและเก่ามากแล้ว ไม่ต้องย้อมสีทั้งช่วงถนน
      const w = reportWeight(p.report);
      const level = w >= 2.2 ? 'high' : w >= 1.1 ? 'medium' : 'low';
      if (level === 'low') continue;

      for (let i = 0; i < route.coordinates.length; i++) {
        if (Math.abs((route.cumulative[i] || 0) - p.along) > SEGMENT_SPREAD_M) continue;
        if (LEVEL_RANK[level] > LEVEL_RANK[levels[i]]) levels[i] = level;
      }
    }

    // รวม vertex ที่ระดับเดียวกันติดกันให้เป็นช่วงเดียว
    const out = [];
    let start = 0;
    for (let i = 1; i <= levels.length; i++) {
      if (i < levels.length && levels[i] === levels[start]) continue;
      out.push({
        level: levels[start],
        // ต่อจุดแรกของช่วงถัดไปเข้ามาด้วย เส้นจะได้ไม่ขาดตรงรอยต่อ
        coordinates: route.coordinates.slice(start, Math.min(i + 1, levels.length)),
      });
      start = i;
    }
    return out.filter((s) => s.coordinates.length > 1);
  }

  return {
    VEHICLES,
    LEVELS,
    analyze,
    compare,
    segments,
    upcoming,
    levelFor,
    reportWeight,
    WARN_AHEAD_M,
  };
})();
