/*
 * รันโมเดล XGBoost ที่เทรนไว้แล้ว บนเบราว์เซอร์
 *
 * โมเดลถูกแปลงเป็น data/ai/model.json ด้วย ai-pipeline/train/export_web.py
 * ต้นไม้แต่ละต้นเก็บเป็น array แบน index ด้วย nodeid:
 *
 *     โหนดแยก : [ลำดับ feature, ค่าเกณฑ์, ลูกฝั่ง yes, ลูกฝั่ง no, ลูกฝั่ง missing]
 *     ใบไม้    : [-1, ค่าที่ใบ, 0, 0, 0]
 *
 * ทำไมต้องเดินต้นไม้เอง แทนที่จะโหลดไลบรารี — XGBoost ไม่มีตัวรันฝั่งเบราว์เซอร์
 * ที่เล็กพอ และการทำนายก็แค่เดินต้นไม้ตามเงื่อนไข ไม่มีอะไรซับซ้อนกว่านี้
 * เขียนเองราว 40 บรรทัด แลกกับไม่ต้องแบก WASM หลายเมกะไบต์
 *
 * ความถูกต้องถูกตรวจด้วย ai-pipeline/tools/verifyWebModel.js ซึ่งเทียบผลของไฟล์นี้
 * กับผลที่ XGBoost ฝั่ง Python คำนวณจาก feature vector ชุดเดียวกัน
 */
window.AIModel = (function () {
  let model = null;
  let loading = null;

  /*
   * ค่า intercept ของ XGBoost
   *
   * base_score ที่เก็บในโมเดลอยู่ในหน่วยของ "ผลลัพธ์" (ความน่าจะเป็น / จำนวนครั้ง)
   * แต่ต้นไม้บวกกันในหน่วย margin จึงต้องแปลงกลับด้วย link function ผกผันก่อน
   * binary:logistic ใช้ logit ส่วน count:poisson ใช้ log
   */
  function intercept(baseScore, link) {
    if (link === 'logit') {
      const b = Math.min(Math.max(baseScore, 1e-6), 1 - 1e-6);
      return Math.log(b / (1 - b));
    }
    return Math.log(Math.max(baseScore, 1e-6));
  }

  /* เดินต้นไม้ต้นเดียวจากรากลงไปจนถึงใบ แล้วคืนค่าที่ใบ */
  function walk(nodes, x) {
    let i = 0;
    // เพดานกันลูปไม่รู้จบถ้าไฟล์โมเดลเสียหาย — ต้นไม้ลึกสุดที่เทรนไว้คือ 6
    for (let guard = 0; guard < 64; guard++) {
      const node = nodes[i];
      if (node[0] === -1) return node[1];
      const value = x[node[0]];
      // ค่าที่หายไปมีทิศทางของมันเองที่เรียนมาตอนเทรน ไม่ใช่แค่แทนด้วยศูนย์
      if (value === null || value === undefined || Number.isNaN(value)) {
        i = node[4];
      } else {
        /*
         * ต้องปัดค่าเป็น float32 ก่อนเทียบ เพราะ XGBoost เก็บทั้งข้อมูลและ
         * threshold เป็น float32 ค่าที่อยู่ติดเส้นแบ่งจะแตกคนละกิ่งถ้าเทียบ
         * ด้วย float64 ของ JS — เจอจริงกับ vehicle_km ที่เป็นเลขหลักพันล้าน
         * (1,377,368,278 ปัดเป็น float32 ได้ 1,377,368,320 ซึ่งข้าม threshold พอดี)
         *
         * ฝั่ง threshold ถูกปัดเป็น float32 ไว้ตั้งแต่ตอน export แล้ว
         */
        i = Math.fround(value) < node[1] ? node[2] : node[3];
      }
    }
    throw new Error('เดินต้นไม้ลึกเกินไป — ไฟล์โมเดลน่าจะเสียหาย');
  }

  function margin(part, x, link) {
    let sum = intercept(part.base_score, link);
    for (const tree of part.trees) sum += walk(tree, x);
    return sum;
  }

  /*
   * ปรับความน่าจะเป็นดิบให้ตรงกับอัตราที่เกิดจริง (isotonic regression)
   *
   * โมเดลดิบมักมั่นใจเกินจริง ตัวปรับนี้เทรนบนชุด valid แล้วเก็บเป็นเส้นหักหลายท่อน
   * ถ้าไม่ปรับ ตัวเลข % ที่โชว์ผู้ใช้จะไม่ตรงกับความเป็นจริง
   */
  /*
   * เพดาน/พื้นของค่าที่ยอมให้แสดง — ค่ามาจาก model.json ไม่ได้ตั้งซ้ำที่นี่
   *
   * isotonic อิ่มตัวที่ 0 กับ 1 พอดีได้ ถ้าทุกวันในถังปลายสุดของชุด valid
   * ออกผลไปทางเดียวกันหมด — กรุงเทพฯ เข้าเงื่อนไขนี้จริง เพราะแทบไม่มีวันไหน
   * ที่ไม่เกิดอุบัติเหตุเลย แต่การบอกผู้ใช้ว่า "100%" คือการอ้างความแน่นอน
   * ที่ข้อมูลจำนวนจำกัดให้ไม่ได้ และ "0%" ก็แปลว่ารับประกันว่าปลอดภัย
   * ซึ่งอันตรายกว่า จึงตัดปลายทั้งสองข้างไว้
   */
  function calibrate(p) {
    const { x, y } = model.calibrator;
    const floor = model.clamp?.floor ?? 0;
    const ceil = model.clamp?.ceil ?? 1;
    const clamp = (v) => Math.min(Math.max(v, floor), ceil);
    if (p <= x[0]) return clamp(y[0]);
    if (p >= x[x.length - 1]) return clamp(y[y.length - 1]);
    let lo = 0;
    let hi = x.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (x[mid] <= p) lo = mid;
      else hi = mid;
    }
    const span = x[hi] - x[lo];
    if (span === 0) return clamp(y[lo]);
    return clamp(y[lo] + ((p - x[lo]) * (y[hi] - y[lo])) / span);
  }

  async function load(url) {
    if (model) return model;
    if (loading) return loading;
    loading = fetch(url || 'data/ai/model.json')
      .then((r) => {
        if (!r.ok) throw new Error(`โหลดโมเดลไม่สำเร็จ (HTTP ${r.status})`);
        return r.json();
      })
      .then((doc) => {
        model = doc;
        return doc;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
    return loading;
  }

  /*
   * แปลง object {ชื่อ feature: ค่า} เป็น array ตามลำดับที่โมเดลคาดหวัง
   * feature ที่ไม่ได้ใส่มาจะเป็น null ซึ่งโมเดลจัดการเป็น missing ให้เอง
   */
  function vectorize(values) {
    return model.features.map((name) => {
      const v = values[name];
      return v === undefined ? null : v;
    });
  }

  function predict(values) {
    if (!model) throw new Error('ยังไม่ได้โหลดโมเดล — เรียก AIModel.load() ก่อน');
    const x = Array.isArray(values) ? values : vectorize(values);

    const raw = 1 / (1 + Math.exp(-margin(model.binary, x, 'logit')));
    const count = Math.exp(margin(model.count, x, 'log'));

    return {
      probability: calibrate(raw),
      rawProbability: raw,
      expectedCount: count,
      threshold: model.threshold,
    };
  }

  /*
   * ผลของ feature แต่ละตัว วัดแบบ "ถอดออกทีละตัว"
   *
   * SHAP จริงต้องเดินทุก subset ซึ่งหนักเกินจะทำในเบราว์เซอร์ วิธีนี้ใช้แทน:
   * แทนค่า feature ด้วย missing แล้วดูว่า margin ขยับไปเท่าไร
   * ได้ทิศทางและลำดับความสำคัญที่ถูกต้อง แม้ขนาดจะไม่เท่า SHAP เป๊ะ ๆ
   */
  function explain(values, topN) {
    const x = Array.isArray(values) ? values : vectorize(values);
    const base = margin(model.binary, x, 'logit');

    const effects = [];
    for (let i = 0; i < x.length; i++) {
      if (x[i] === null) continue;
      const probe = x.slice();
      probe[i] = null;
      const delta = base - margin(model.binary, probe, 'logit');
      if (Math.abs(delta) > 1e-6) {
        effects.push({ feature: model.features[i], value: x[i], effect: delta });
      }
    }
    effects.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
    return effects.slice(0, topN || 8);
  }

  /* ชื่อ feature ที่โมเดลต้องการแต่ผู้เรียกไม่ได้ส่งค่ามา — ใช้จับบั๊กตอนต่อระบบ */
  function missingFeatures(values) {
    return model.features.filter((name) => {
      const v = values[name];
      return v === null || v === undefined || Number.isNaN(v);
    });
  }

  return {
    load,
    predict,
    explain,
    vectorize,
    missingFeatures,
    isReady: () => model !== null,
    info: () => model && { features: model.features.length, ...model.metrics, generated_at: model.generated_at },
  };
})();
