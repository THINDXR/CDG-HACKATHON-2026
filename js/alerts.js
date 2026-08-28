/* ระบบเตือนภัย: ติดตามตำแหน่ง คำนวณภัยข้างหน้า และแจ้งเตือนด้วยเสียง/ภาพ */
window.Alerts = (function () {
  const CFG = window.APP_CONFIG;
  const U = window.Utils;

  const RE_ALERT_MS = 5 * 60 * 1000; // ไม่เตือนซ้ำภายใน 5 นาที
  const AHEAD_ANGLE = 100;           // องศาที่ถือว่า "อยู่ข้างหน้า"
  const LOOKAHEAD_M = 900;           // ระยะมองไปข้างหน้า

  const settings = loadSettings();
  const lastAlerted = new Map(); // id -> timestamp
  let watchId = null;
  let simTimer = null;
  let simIndex = 0;
  let simRoute = [];
  let audioCtx = null;
  let onAlert = () => {};
  let onNearbyChange = () => {};

  function loadSettings() {
    const fallback = { sound: true, voice: true, vibrate: true };
    try {
      return { ...fallback, ...JSON.parse(localStorage.getItem(CFG.SETTINGS_KEY) || '{}') };
    } catch (_) {
      return fallback;
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(CFG.SETTINGS_KEY, JSON.stringify(settings));
    } catch (_) { /* ไม่สำคัญพอที่จะทำให้แอปหยุด */ }
  }

  function setSetting(key, value) {
    settings[key] = value;
    saveSettings();
  }

  /* ---------- GPS จริง ---------- */

  function startTracking(onError) {
    if (!('geolocation' in navigator)) {
      onError?.('เบราว์เซอร์นี้ไม่รองรับการระบุตำแหน่ง');
      return;
    }
    stopSimulation();
    if (watchId != null) navigator.geolocation.clearWatch(watchId);

    let lastCoord = null;
    let lastAt = 0;

    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const coord = [pos.coords.longitude, pos.coords.latitude];
        let heading = Number.isFinite(pos.coords.heading) ? pos.coords.heading : undefined;

        /*
         * เบราว์เซอร์มักคืน heading เป็น null ตอนอยู่นิ่งหรือขยับช้า
         * ถ้าไม่มีค่า แผนที่ตอนนำทางจะไม่หมุนตามทิศเลย
         * จึงคำนวณเองจากตำแหน่งก่อนหน้า (ใช้เฉพาะเมื่อขยับพอสมควรกัน GPS แกว่ง)
         */
        if (heading === undefined && lastCoord && U.distance(lastCoord, coord) > 8) {
          heading = U.bearing(lastCoord, coord);
        }

        /*
         * ความเร็วสำหรับมาตรวัด km/h บนการ์ดนำทาง
         * ถ้าอุปกรณ์ไม่ให้ coords.speed มา ก็คำนวณเองจากระยะ/เวลาระหว่างสองจุด
         */
        let speed = Number.isFinite(pos.coords.speed) ? pos.coords.speed : undefined;
        if (speed === undefined && lastCoord && lastAt) {
          const dt = (pos.timestamp - lastAt) / 1000;
          if (dt > 0.4 && dt < 15) speed = U.distance(lastCoord, coord) / dt;
        }

        if (!lastCoord || U.distance(lastCoord, coord) > 8) {
          lastCoord = coord;
          lastAt = pos.timestamp;
        }

        window.Store.setUserPosition(coord, heading, speed);
      },
      (err) => {
        const msg =
          err.code === 1
            ? 'ไม่ได้รับอนุญาตให้เข้าถึงตำแหน่ง — ลองใช้โหมดจำลองการขับแทน'
            : 'หาตำแหน่งไม่สำเร็จ — ลองใช้โหมดจำลองการขับแทน';
        onError?.(msg);
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 12000 }
    );
  }

  function stopTracking() {
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId);
      watchId = null;
    }
  }

  /* ---------- โหมดจำลองการขับ (ใช้เดโมบนเดสก์ท็อป) ---------- */

  /*
   * เส้นทางของ "ฉากสาธิต" — ต้นทางฝั่งตะวันตกไปปลายทางฝั่งตะวันออกของกรุงเทพฯ
   *
   * ตั้งใจใช้แค่สองจุด (ไม่มีจุดแวะ) เพราะ OSRM จะให้เส้นทางสำรองมาเทียบ
   * เฉพาะตอนขอแบบสองจุดเท่านั้น — ฉากนี้ต้องมีเส้นทางให้เลือกอย่างน้อยสองเส้น
   * ถึงจะโชว์การเลี่ยงจุดเสี่ยงได้ และระยะต้องยาวพอที่เส้นทางจะแยกกันจริง
   */
  const SIM_TRIP = {
    from: [100.4500, 13.7200],
    to: [100.6500, 13.7800],
    label: 'ปลายทางเส้นทางสาธิต',
  };

  const SIM_WAYPOINTS = [
    [100.4985, 13.7430],
    [100.5060, 13.7452],
    [100.5152, 13.7521],
    [100.5238, 13.7563],
    [100.5305, 13.7520],
    [100.5389, 13.7452],
    [100.5462, 13.7480],
    [100.5478, 13.7621],
    [100.5560, 13.7560],
    [100.5605, 13.7392],
    [100.5701, 13.7245],
  ];

  /** แตกเส้นทางเป็นจุดย่อยห่างกันประมาณ stepMeters */
  function densify(waypoints, stepMeters = 25) {
    const out = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i];
      const b = waypoints[i + 1];
      const dist = U.distance(a, b);
      const brg = U.bearing(a, b);
      const steps = Math.max(1, Math.round(dist / stepMeters));
      for (let s = 0; s < steps; s++) {
        out.push(U.destination(a, brg, (dist * s) / steps));
      }
    }
    out.push(waypoints[waypoints.length - 1]);
    return out;
  }

  /*
   * ระยะต่อก้าวและจังหวะเดินของโหมดจำลอง
   * 8 เมตร ทุก 400 มิลลิวินาที = 20 ม./วิ ≈ 72 กม./ชม. ซึ่งเป็นความเร็วขับจริง
   * (ตัวเลขนี้สำคัญขึ้นตั้งแต่มีมาตรวัด km/h เพราะถ้าเดินเร็วเกินจริง เข็มจะโชว์ค่ามั่ว)
   */
  const SIM_STEP_M = 8;
  const SIM_TICK_MS = 400;

  /**
   * @param {Array<[number, number]>} [path] เส้นทางจริงที่ให้รถวิ่งตาม
   *
   * ถ้าส่ง path มา (เส้นทางเดียวกับที่กำลังนำทางอยู่) หัวลูกศรจะขนานกับถนนเสมอ
   * ถ้าไม่ส่ง จะวิ่งตรงระหว่าง waypoint สาธิต ซึ่งลูกศรจะเฉียงออกจากถนนจริง
   */
  function startSimulation(path) {
    stopTracking();
    if (simTimer) clearInterval(simTimer);

    const onRoute = Array.isArray(path) && path.length > 1;
    simRoute = densify(onRoute ? path : SIM_WAYPOINTS, SIM_STEP_M);
    simIndex = 0;
    lastAlerted.clear();
    // ขับตามเส้นทางนำทางอยู่แล้ว ไม่ต้องวาดเส้นสาธิตซ้อนทับอีกเส้น
    window.MapView.setSimRoute(onRoute ? null : SIM_WAYPOINTS);
    window.Store.setSimulating(true);

    simTimer = setInterval(() => {
      const coord = simRoute[simIndex];
      const next = simRoute[Math.min(simIndex + 1, simRoute.length - 1)];
      const heading = U.bearing(coord, next);
      const speed = U.distance(coord, next) / (SIM_TICK_MS / 1000);
      window.Store.setUserPosition(coord, heading, speed);
      simIndex += 1;
      // ขับตามเส้นทางนำทางจะจบเองตอนถึงปลายทาง ส่วนเส้นสาธิตล้วนให้วนซ้ำ
      if (simIndex >= simRoute.length) simIndex = onRoute ? simRoute.length - 1 : 0;
    }, SIM_TICK_MS);
  }

  function stopSimulation() {
    if (simTimer) {
      clearInterval(simTimer);
      simTimer = null;
    }
    if (window.Store.state.simulating) window.Store.setSimulating(false);
    // จุดของฉากสาธิตต้องหายไปพร้อมกับโหมดจำลอง ไม่ปนกับรายงานจริงของผู้ใช้
    window.Store.clearDemoReports();
    window.MapView.setSimRoute(null);
  }

  /* ---------- คำนวณภัยข้างหน้า ---------- */

  // ระหว่างนำทางไม่ต้องเตือนเรื่องพวกนี้ เพราะไม่ได้กระทบการขับตรงหน้า
  // ปล่อยให้ผู้ขับโฟกัสกับสิ่งที่ต้องหลบจริง ๆ
  const SKIP_WHILE_NAVIGATING = new Set(['police', 'fog', 'animal']);

  /** คืนรายการภัยที่อยู่ในระยะเตือน เรียงจากใกล้สุด */
  function evaluate(position, heading) {
    if (!position) return [];
    const results = [];
    const navigating = window.Navigate?.isActive;

    for (const r of window.Store.visibleReports()) {
      if (navigating && SKIP_WHILE_NAVIGATING.has(r.type)) continue;
      const target = [r.lng, r.lat];
      const dist = U.distance(position, target);
      const triggerAt = r.radius + LOOKAHEAD_M;
      if (dist > triggerAt) continue;

      const brg = U.bearing(position, target);
      let ahead = true;
      let angleDiff = 0;
      if (typeof heading === 'number') {
        angleDiff = Math.abs(((brg - heading + 540) % 360) - 180);
        ahead = angleDiff <= AHEAD_ANGLE;
      }
      results.push({ report: r, distance: dist, bearing: brg, ahead, angleDiff });
    }

    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  /** ตรวจสอบและยิงการแจ้งเตือนสำหรับภัยที่เพิ่งเข้าระยะ */
  function check(position, heading) {
    const nearby = evaluate(position, heading);
    onNearbyChange(nearby);

    /*
     * ระหว่างนำทาง ปล่อยให้ Navigate เป็นเจ้าของการเตือนจุดเสี่ยงแต่ผู้เดียว
     * เพราะมันวัดระยะตามแนวเส้นทางจริง จึงไม่เตือนภัยที่อยู่บนถนนคู่ขนาน
     * และไม่ให้ผู้ขับได้ยินเสียงพูดซ้ำสองชุดพร้อมกัน
     */
    if (window.Navigate?.isActive) return nearby;

    const now = Date.now();
    for (const item of nearby) {
      if (!item.ahead) continue;
      if (item.distance > item.report.radius + 400) continue;

      const last = lastAlerted.get(item.report.id) || 0;
      if (now - last < RE_ALERT_MS) continue;

      lastAlerted.set(item.report.id, now);
      fire(item);
    }
    return nearby;
  }

  function fire(item) {
    const def = CFG.HAZARD_TYPES[item.report.type];
    const dist = U.formatDistance(item.distance);
    const message = `${def.label} ข้างหน้า ${dist}`;

    onAlert({ ...item, message, def });

    if (settings.sound) beep(item.report.severity);
    if (settings.voice) speak(`${def.label}ข้างหน้า ${dist} ${item.report.road || ''}`);
    if (settings.vibrate && navigator.vibrate) {
      navigator.vibrate(item.report.severity === 'high' ? [120, 60, 120] : [90]);
    }
  }

  /**
   * เสียง + สั่นเตือนตามการตั้งค่า (ไม่มีข้อความ)
   * ใช้ตอนที่ผู้เรียกจะเขียนข้อความเตือนเอง เช่น Navigate เตือนจุดเสี่ยงบนเส้นทาง
   */
  function notify(severity = 'medium') {
    if (settings.sound) beep(severity);
    if (settings.vibrate && navigator.vibrate) {
      navigator.vibrate(severity === 'high' ? [120, 60, 120] : [90]);
    }
  }

  /* ---------- เสียง ---------- */

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function beep(severity) {
    const ctx = ensureAudio();
    if (!ctx) return;
    const times = severity === 'high' ? 3 : severity === 'medium' ? 2 : 1;
    for (let i = 0; i < times; i++) {
      const t0 = ctx.currentTime + i * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(severity === 'high' ? 880 : 660, t0);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.16);
    }
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'th-TH';
      utter.rate = 1.05;
      window.speechSynthesis.speak(utter);
    } catch (_) { /* บางเบราว์เซอร์บล็อกก่อนมี user gesture */ }
  }

  return {
    settings,
    SIM_WAYPOINTS,
    SIM_TRIP,
    setSetting,
    startTracking,
    stopTracking,
    startSimulation,
    stopSimulation,
    evaluate,
    check,
    notify,
    ensureAudio,
    speak,
    get isSimulating() { return !!simTimer; },
    get isTracking() { return watchId != null; },
    set onAlert(fn) { onAlert = fn; },
    set onNearbyChange(fn) { onNearbyChange = fn; },
  };
})();
