/* ขอเส้นทางขับรถจาก OSRM (เซิร์ฟเวอร์สาธิตของ OpenStreetMap — ไม่ต้องใช้ API key) */
window.Route = (function () {
  const U = window.Utils;
  const ENDPOINT = 'https://router.project-osrm.org/route/v1/driving';

  /* ---------- แปลงคำสั่งเลี้ยวเป็นภาษาไทย ---------- */

  const SIDE = {
    left: 'ซ้าย',
    right: 'ขวา',
    'slight left': 'ซ้ายเล็กน้อย',
    'slight right': 'ขวาเล็กน้อย',
    'sharp left': 'ซ้ายหักศอก',
    'sharp right': 'ขวาหักศอก',
  };

  // ชื่อไอคอนลูกศรบนการ์ดนำทาง เลือกตามทิศที่ต้องเลี้ยว
  const ARROW = {
    left: 'turnLeft',
    right: 'turnRight',
    'slight left': 'slightLeft',
    'slight right': 'slightRight',
    'sharp left': 'turnLeft',
    'sharp right': 'turnRight',
    straight: 'straight',
    uturn: 'uturn',
  };

  function arrowFor(maneuver) {
    if (maneuver.type === 'depart') return 'straight';
    if (maneuver.type === 'arrive') return 'flag';
    if (maneuver.type === 'roundabout' || maneuver.type === 'rotary') return 'roundabout';
    return ARROW[maneuver.modifier] || 'straight';
  }

  /** ข้อความสั่งเลี้ยวภาษาไทย เช่น "เลี้ยวซ้ายเข้าถนนพระราม 4" */
  function instructionFor(maneuver, roadName) {
    const into = roadName ? `เข้า${roadName}` : '';
    const side = SIDE[maneuver.modifier] || '';

    switch (maneuver.type) {
      case 'depart':
        return roadName ? `เริ่มต้นบน${roadName}` : 'เริ่มออกเดินทาง';
      case 'arrive':
        return 'ถึงจุดหมาย';
      case 'turn':
        if (maneuver.modifier === 'uturn') return 'กลับรถ';
        if (maneuver.modifier === 'straight') return `ตรงไป${into}`;
        return `เลี้ยว${side}${into}`;
      case 'end of road':
        return `สุดถนน เลี้ยว${side}${into}`;
      case 'fork':
        return `ชิด${side}${into}`;
      case 'merge':
        return `รวมเลน${side ? ' ' + side : ''}${into}`;
      case 'on ramp':
        return `ขึ้นทางด่วน${into}`;
      case 'off ramp':
        return `ลงทางด่วน${into}`;
      case 'roundabout':
      case 'rotary':
        return maneuver.exit ? `เข้าวงเวียน ออกทางที่ ${maneuver.exit}` : 'เข้าวงเวียน';
      case 'new name':
      case 'continue':
        return roadName ? `ตรงไปตาม${roadName}` : 'ตรงไป';
      default:
        return roadName ? `ไปตาม${roadName}` : 'ตรงไป';
    }
  }

  /* ---------- เรียกเส้นทาง ---------- */

  /**
   * @param {[number, number]} from พิกัดต้นทาง [lng, lat]
   * @param {[number, number]} to พิกัดปลายทาง [lng, lat]
   * @returns {Promise<object>} เส้นทางที่แตกเป็นจุดย่อยพร้อมระยะสะสมและคำสั่งเลี้ยว
   */
  async function getRoute(from, to) {
    const coords = `${from[0]},${from[1]};${to[0]},${to[1]}`;
    const url = `${ENDPOINT}/${coords}?overview=full&geometries=geojson&steps=true&alternatives=false`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`เซิร์ฟเวอร์เส้นทางตอบกลับ ${res.status}`);

    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) {
      throw new Error('หาเส้นทางไปจุดนี้ไม่ได้');
    }
    return build(data.routes[0]);
  }

  /**
   * ต่อ geometry ของแต่ละ step เข้าด้วยกันเป็นเส้นเดียว
   * พร้อมจำไว้ว่าแต่ละ step เริ่มที่จุดไหน เพื่อใช้บอกว่า "เลี้ยวถัดไปอีกกี่เมตร"
   */
  function build(route) {
    const legs = route.legs || [];
    const coordinates = [];
    const steps = [];

    for (const leg of legs) {
      for (const step of leg.steps || []) {
        const geom = step.geometry?.coordinates || [];
        if (!geom.length) continue;

        // จุดแรกของ step ถัดไปซ้ำกับจุดสุดท้ายของ step ก่อนหน้า จึงข้ามไป
        const startIndex = coordinates.length ? coordinates.length - 1 : 0;
        for (let i = coordinates.length ? 1 : 0; i < geom.length; i++) {
          coordinates.push(geom[i]);
        }

        steps.push({
          startIndex,
          roadName: step.name || '',
          arrow: arrowFor(step.maneuver),
          instruction: instructionFor(step.maneuver, step.name || ''),
          distance: step.distance,
        });
      }
    }

    // ระยะสะสมจากจุดเริ่มถึงแต่ละจุด ใช้คำนวณระยะคงเหลือแบบเร็ว ๆ
    const cumulative = [0];
    for (let i = 1; i < coordinates.length; i++) {
      cumulative[i] = cumulative[i - 1] + U.distance(coordinates[i - 1], coordinates[i]);
    }

    return {
      coordinates,
      cumulative,
      steps,
      distance: route.distance,
      duration: route.duration,
    };
  }

  /* ---------- ตำแหน่งบนเส้นทาง ---------- */

  /** ดัชนีจุดบนเส้นทางที่ใกล้ตำแหน่งปัจจุบันที่สุด (ค้นหาแบบหน้าต่างเลื่อนเพื่อความเร็ว) */
  function nearestIndex(route, position, fromIndex = 0) {
    let best = fromIndex;
    let bestDist = Infinity;
    // มองไปข้างหน้าจากจุดเดิมเท่านั้น กันกรณีเส้นทางวนกลับมาใกล้จุดเดิม
    const end = Math.min(route.coordinates.length, fromIndex + 400);

    for (let i = fromIndex; i < end; i++) {
      const d = U.distance(position, route.coordinates[i]);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return { index: best, offRoute: bestDist };
  }

  /** สรุปความคืบหน้า: เหลือระยะเท่าไร เลี้ยวถัดไปคืออะไร อีกกี่เมตร */
  function progress(route, position, fromIndex = 0) {
    const { index, offRoute } = nearestIndex(route, position, fromIndex);
    const total = route.cumulative[route.cumulative.length - 1] || 0;
    const travelled = route.cumulative[index] || 0;
    const remaining = Math.max(0, total - travelled);

    // step ปัจจุบันคือ step สุดท้ายที่เริ่มก่อนหรือตรงจุดที่เราอยู่
    let stepIndex = 0;
    for (let i = 0; i < route.steps.length; i++) {
      if (route.steps[i].startIndex <= index) stepIndex = i;
      else break;
    }

    const next = route.steps[stepIndex + 1];
    const distanceToManeuver = next
      ? Math.max(0, (route.cumulative[next.startIndex] || total) - travelled)
      : remaining;

    return {
      index,
      offRoute,
      remaining,
      // ความเร็วเฉลี่ยจาก OSRM ใช้ประมาณเวลาที่เหลือตามสัดส่วนระยะทาง
      remainingSeconds: total > 0 ? (route.duration * remaining) / total : 0,
      step: next || route.steps[route.steps.length - 1],
      distanceToManeuver,
      arrived: remaining < 30,
    };
  }

  return { getRoute, progress };
})();
