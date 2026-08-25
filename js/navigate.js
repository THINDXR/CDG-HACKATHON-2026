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
  let lastIndex = 0;
  let lastRecalcAt = 0;
  let spokenFor = null;     // จำว่าพูดเตือนทางเลี้ยวไหนไปแล้ว
  let recalculating = false;

  let onChange = () => {};
  let onFinish = () => {};

  /** เริ่มนำทางไปยังจุดหมาย */
  async function start(from, dest) {
    destination = dest;
    route = await window.Route.getRoute(from, [dest.lng, dest.lat]);
    lastIndex = 0;
    spokenFor = null;
    lastRecalcAt = Date.now();
    progress = window.Route.progress(route, from, 0);
    onChange();
    return route;
  }

  function stop() {
    route = null;
    destination = null;
    progress = null;
    lastIndex = 0;
    spokenFor = null;
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
    onChange();
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
    get isActive() { return !!route; },
    get route() { return route; },
    get destination() { return destination; },
    get progress() { return progress; },
    set onChange(fn) { onChange = fn; },
    set onFinish(fn) { onFinish = fn; },
  };
})();
