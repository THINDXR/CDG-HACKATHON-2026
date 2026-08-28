/* โหมดนำทาง: เก็บเส้นทางที่กำลังใช้ ติดตามความคืบหน้า และสั่งพูดเตือนก่อนถึงทางเลี้ยว */
window.Navigate = (function () {
  const U = window.Utils;

  // ระยะที่ถือว่าหลุดออกนอกเส้นทางแล้วต้องคำนวณใหม่ (เมตร)
  const OFF_ROUTE_M = 70;
  // เว้นอย่างน้อยเท่านี้ก่อนคำนวณเส้นทางใหม่ กันการยิงรัว ๆ ตอนสัญญาณ GPS แกว่ง
  const RECALC_COOLDOWN_MS = 8000;

  let route = null;
  let destination = null;   // { lng, lat, label }
  let progress = null;
  let vehicle = 'car';      // 'car' | 'motorbike'
  let analysis = null;      // ผลจาก RouteRisk.analyze() ของเส้นทางที่กำลังใช้
  let lastIndex = 0;
  let lastRecalcAt = 0;
  let spokenFor = null;     // จำว่าพูดเตือนทางเลี้ยวไหนไปแล้ว
  let warnedHazards = new Set(); // จุดเสี่ยงบนเส้นทางที่เตือนไปแล้ว
  let recalculating = false;

  let onChange = () => {};
  let onFinish = () => {};
  let onHazard = () => {};

  /** วิเคราะห์ความเสี่ยงของเส้นทางปัจจุบันใหม่ (เรียกทุกครั้งที่เส้นทางเปลี่ยน) */
  function reanalyze() {
    analysis = route ? window.RouteRisk.analyze(route, vehicle) : null;
  }

  /**
   * เริ่มนำทางไปยังจุดหมาย
   * @param {object} opts.preRoute เส้นทางที่คำนวณไว้แล้ว (จากแผ่นสรุปการเดินทาง)
   *   ส่งมาเพื่อไม่ต้องยิง OSRM ซ้ำรอบสอง
   */
  async function start(from, dest, opts = {}) {
    destination = dest;
    vehicle = opts.vehicle || 'car';
    route = opts.preRoute || (await window.Route.getRoute(from, [dest.lng, dest.lat]));
    lastIndex = 0;
    spokenFor = null;
    warnedHazards = new Set();
    lastRecalcAt = Date.now();
    reanalyze();
    progress = window.Route.progress(route, from, 0);
    onChange();
    return route;
  }

  function stop() {
    route = null;
    destination = null;
    progress = null;
    analysis = null;
    lastIndex = 0;
    spokenFor = null;
    warnedHazards = new Set();
    onChange();
  }

  /** เปลี่ยนพาหนะระหว่างทาง — เส้นทางเดิม แต่เวลาและความเสี่ยงคิดใหม่ */
  function setVehicle(key) {
    vehicle = key;
    reanalyze();
    onChange();
  }

  /** อัปเดตความคืบหน้าจากตำแหน่งล่าสุด — เรียกทุกครั้งที่ GPS ขยับ */
  function update(position) {
    if (!route || !position) return;

    progress = window.Route.progress(route, position, lastIndex);
    lastIndex = progress.index;

    if (progress.arrived) {
      speak('ถึงจุดหมายแล้ว');
      const reached = destination;
      stop();
      onFinish(reached);
      return;
    }

    if (progress.offRoute > OFF_ROUTE_M) {
      recalculate(position);
      return;
    }

    announce();
    warnHazardAhead();
    onChange();
  }

  /**
   * เตือนจุดเสี่ยงที่อยู่ "บนเส้นทาง" ข้างหน้า
   *
   * ต่างจาก Alerts.check() ตรงที่อันนั้นดูรัศมีรอบตัวกับทิศที่หันไป จึงเตือนภัย
   * บนถนนคู่ขนานได้ ส่วนอันนี้เอาเฉพาะจุดที่ RouteRisk จับคู่เข้ากับเส้นทางแล้ว
   * จึงมั่นใจได้ว่าเป็นจุดที่เราจะวิ่งผ่านจริง ๆ
   */
  /*
   * เตือนสองชนิดด้วยตรรกะเดียวกัน
   *
   *   รายงานผู้ใช้  สิ่งที่มีคนแจ้งว่าเกิดอยู่ตอนนี้
   *   จุดสถิติ      ที่ที่เคยเกิดอุบัติเหตุซ้ำ ๆ มา 4 ปี (จากโมเดลของเรา)
   *
   * อันไหนอยู่ใกล้กว่าได้ขึ้นก่อน เพราะการ์ดเตือนมีที่เดียวและคนขับอ่านได้ทีละอัน
   * ถ้าโชว์พร้อมกันสองใบจะแย่งความสนใจกันเองในจังหวะที่ต้องมองถนน
   */
  function warnHazardAhead() {
    if (!analysis) return;

    const report = window.RouteRisk.upcoming(analysis, progress.travelled);
    const stat = window.Hotspots?.upcomingOnRoute(
      progress.travelled,
      window.RouteRisk.WARN_AHEAD_M,
    );

    // เลือกอันที่ถึงก่อน
    const useStat = stat && (!report || stat.ahead < report.ahead);
    const next = useStat ? statAsHazard(stat) : report;

    if (!next) {
      onHazard(null);
      return;
    }
    onHazard(next);

    if (warnedHazards.has(next.report.id)) return;
    warnedHazards.add(next.report.id);

    window.Alerts?.notify(next.report.severity);

    if (useStat) {
      speak(next.speech);
    } else {
      const def = window.APP_CONFIG.HAZARD_TYPES[next.report.type];
      speak(`ระวัง ${def.label} ข้างหน้า ${U.formatDistance(next.ahead)} บน${next.road}`);
    }
  }

  /*
   * แปลงจุดสถิติให้อยู่ในรูปเดียวกับรายงาน เพื่อให้การ์ดเตือนวาดได้โดยไม่ต้องแก้
   *
   * ความรุนแรงอิงจำนวนผู้เสียชีวิต ไม่ใช่จำนวนครั้ง — จุดที่เกิดบ่อยแต่เจ็บเล็กน้อย
   * ไม่ควรเตือนแรงเท่าจุดที่ชนทีไรถึงตาย
   */
  function statAsHazard(hit) {
    const h = hit.spot;
    const cat = window.Hotspots.classify(h);
    const severity = h.dead >= 3 ? 'high' : h.dead > 0 ? 'medium' : 'low';

    return {
      ahead: hit.ahead,
      road: h.road || h.province,
      isStat: true,
      category: cat,
      spot: h,
      report: {
        id: `stat:${hit.idx}`,
        type: 'accident',
        severity,
        road: h.road || h.province,
      },
      /*
       * พูดสิ่งที่ต้องทำก่อน แล้วค่อยบอกเหตุผล — คนขับได้ยินคำสั่งตั้งแต่คำแรก
       * ไม่ต้องรอฟังจนจบประโยคถึงจะรู้ว่าควรทำอะไร
       */
      speech:
        `${cat.action || 'ระวัง'} ข้างหน้า ${U.formatDistance(hit.ahead)} ` +
        `จุดนี้เคยเกิดอุบัติเหตุ ${h.accidents} ครั้ง`,
    };
  }

  /** พูดเตือนล่วงหน้าก่อนถึงทางเลี้ยว — พูดครั้งเดียวต่อหนึ่งทางเลี้ยว */
  function announce() {
    const step = progress.step;
    if (!step) return;

    const d = progress.distanceToManeuver;
    // ใกล้เกิน 250 ม. ค่อยพูด ไม่งั้นจะพูดตั้งแต่ยังอีกไกล
    if (d > 250) {
      if (spokenFor === step.startIndex) spokenFor = null;
      return;
    }
    if (spokenFor === step.startIndex) return;

    spokenFor = step.startIndex;
    speak(`อีก ${U.formatDistance(d)} ${step.instruction}`);
  }

  function speak(text) {
    if (window.Alerts?.settings.voice) window.Alerts.speak(text);
  }

  /** หลุดเส้นทาง — ขอเส้นทางใหม่จากตำแหน่งปัจจุบัน */
  async function recalculate(position) {
    const now = Date.now();
    if (recalculating || now - lastRecalcAt < RECALC_COOLDOWN_MS) return;

    recalculating = true;
    lastRecalcAt = now;
    try {
      route = await window.Route.getRoute(position, [destination.lng, destination.lat]);
      lastIndex = 0;
      spokenFor = null;
      warnedHazards = new Set();
      reanalyze();
      progress = window.Route.progress(route, position, 0);
      speak('กำลังคำนวณเส้นทางใหม่');
      onChange();
    } catch (_) {
      /* ต่อเน็ตไม่ได้ — ใช้เส้นทางเดิมต่อไปก่อน ดีกว่าตัดการนำทางทิ้ง */
    } finally {
      recalculating = false;
    }
  }

  return {
    start,
    stop,
    update,
    setVehicle,
    get isActive() { return !!route; },
    get route() { return route; },
    get destination() { return destination; },
    get progress() { return progress; },
    get vehicle() { return vehicle; },
    get analysis() { return analysis; },
    set onChange(fn) { onChange = fn; },
    set onFinish(fn) { onFinish = fn; },
    set onHazard(fn) { onHazard = fn; },
  };
})();
