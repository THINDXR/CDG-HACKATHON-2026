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
      const weight =
        CFG.SEVERITY[p.report.severity].weight *
        Math.max(0.4, (p.report.confirms + 1) / (p.report.confirms + p.report.denies + 1));

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
    const totalWeight = roadList.reduce((sum, r) => sum + r.weight + r.accidents * 1.5, 0);
    const density = (totalWeight / km) * 10 * vehicle.riskFactor;
    const score = Math.round(Math.min(100, 100 * (1 - Math.exp(-density / 12))));

    const duration = route.duration * vehicle.timeFactor;

    return {
      vehicle,
      points,
      roads: roadList,
      score,
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

  return {
    VEHICLES,
    LEVELS,
    analyze,
    upcoming,
    levelFor,
    WARN_AHEAD_M,
  };
})();
