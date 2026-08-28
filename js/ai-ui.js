/*
 * ส่วนติดต่อผู้ใช้ของโมเดลพยากรณ์
 *
 * รับผิดชอบสามที่ตามที่ออกแบบไว้:
 *   1. การ์ดสรุปในแผ่นรายการ  — #aiPanel ใต้สรุปความเสี่ยงรอบตัว
 *   2. คะแนนเส้นทาง            — ui.js เรียก AIForecast.blendRouteScore() ตอนวาดแผ่นทริป
 *   3. เตือนตอนเริ่มนำทาง      — navigate.js เรียก AIUI.navigationNotice()
 *
 * ทั้งหมดออกแบบให้ "ขาดได้" — ถ้าโหลดโมเดลไม่สำเร็จหรือเน็ตล่ม
 * แอปยังทำงานครบทุกอย่างเหมือนเดิม แค่ไม่มีส่วนพยากรณ์ ไม่มี error ค้างหน้าจอ
 */
window.AIUI = (function () {
  const U = window.Utils;
  const escapeHtml = (s) => U.escapeHtml(s);

  // ผลพยากรณ์ของวันนี้ ณ ตำแหน่งล่าสุด เก็บไว้ให้ส่วนอื่นหยิบไปใช้แบบไม่ต้องรอ
  let current = null;
  let currentGeocode = null;
  let inFlight = false;
  let failed = false;

  function panel() {
    return document.getElementById('aiPanel');
  }

  /* ---------- วาดการ์ด ---------- */

  function renderLoading() {
    const box = panel();
    if (!box || current) return;
    box.hidden = false;
    box.innerHTML = `<p class="ai__loading">กำลังประเมินความเสี่ยงของวันนี้ ...</p>`;
  }

  /*
   * โมเดลล้มเหลวไม่ใช่เรื่องที่ต้องเอา error ไปขวางหน้าผู้ใช้
   * ซ่อนการ์ดไปเลยดีกว่าโชว์กล่องแดง ๆ ที่ผู้ใช้ทำอะไรกับมันไม่ได้
   */
  function renderFailed() {
    const box = panel();
    if (box) box.hidden = true;
  }

  /*
   * บรรทัดเทียบกับวันธรรมดา
   *
   * ตัวเลขดิบอย่างเดียวไม่มีความหมายกับผู้ใช้ — "7.7 ครั้ง" ในกรุงเทพฯ คือวันปกติ
   * แต่ในจังหวัดเล็กคือวิกฤต จึงต้องบอกเสมอว่าเทียบกับที่นี่แล้วมันมากหรือน้อย
   */
  function compareText(result) {
    const ratio = result.level.ratio;
    if (!ratio) {
      return `โอกาสเกิดอย่างน้อย 1 ครั้ง <strong>${Math.round(result.probability * 100)}%</strong>`;
    }
    const diff = Math.round(Math.abs(ratio - 1) * 100);
    if (diff < 5) return 'พอ ๆ กับวันธรรมดาของจังหวัดนี้';
    return ratio > 1
      ? `<strong>สูงกว่า</strong>วันธรรมดาของจังหวัดนี้ ${diff}%`
      : `<strong>ต่ำกว่า</strong>วันธรรมดาของจังหวัดนี้ ${diff}%`;
  }

  /*
   * การ์ดแสดงผลของ "วันนี้" อย่างเดียว
   *
   * เคยมีแถบพยากรณ์ 7 วันข้างหน้าด้วย แต่ถอดออกแล้ว — พยากรณ์อากาศยิ่งไกลวัน
   * ยิ่งคลาดเคลื่อน และคนขับตัดสินใจจากวันนี้เป็นหลัก การโชว์ตัวเลขล่วงหน้า
   * ที่เชื่อถือได้น้อยกว่าไว้ข้าง ๆ กันทำให้ตัวเลขวันนี้ดูน่าเชื่อถือน้อยลงไปด้วย
   *
   * AIForecast.forecastWeek() ยังอยู่ ถ้าจะเอากลับมาก็เรียกได้เลย
   */
  function renderCard(result) {
    const box = panel();
    if (!box) return;
    box.hidden = false;
    box.dataset.level = result.level.key;
    box.style.setProperty('--ai-color', result.level.color);

    const reasons = result.reasons.slice(0, 3).map(
      (r) => `<li>${escapeHtml(r.text)}</li>`,
    ).join('');

    box.innerHTML = `
      <div class="ai__head">
        <div class="ai__title">
          <span class="ai__badge">โมเดลพยากรณ์</span>
          <strong>${escapeHtml(result.province)}</strong>
        </div>
        <span class="ai__level">${escapeHtml(result.level.label)}</span>
      </div>

      <div class="ai__figure">
        <span class="ai__pct">${result.expectedCount.toFixed(1)}<small>ครั้ง</small></span>
        <span class="ai__caption">
          จำนวนอุบัติเหตุบนทางหลวงที่คาดว่าจะเกิดวันนี้ทั้งจังหวัด<br>
          ${compareText(result)}
        </span>
      </div>

      ${reasons ? `<ul class="ai__reasons">${reasons}</ul>` : ''}

      <button class="ai__note-toggle" type="button" id="aiNoteToggle">ตัวเลขนี้มาจากไหน</button>
      <p class="ai__note" id="aiNote" hidden>
        โมเดล XGBoost เทรนจากสถิติอุบัติเหตุบนทางหลวง ทางหลวงชนบท และทางพิเศษ
        ปี 2565–2569 (121,737 แถว ระดับจังหวัด × วัน) รวมกับพยากรณ์อากาศและปฏิทินวันหยุด
        <br><br>
        เป็นความเสี่ยง<strong>ระดับจังหวัด</strong> ไม่ใช่ของถนนเส้นที่คุณจะขับ
        และไม่รวมถนนในเมืองกับซอย ส่วนฟีเจอร์ประวัติอุบัติเหตุใช้ค่าเฉลี่ยย้อนหลัง
        แทนตัวเลขเรียลไทม์ (ไม่มีแหล่งข้อมูลให้) ความแม่นจริงจึงต่ำกว่าที่วัดได้ตอนเทรน
        <br><br>
        ใช้เป็นตัวช่วยตัดสินใจ ไม่ใช่คำรับประกัน
      </p>`;

    const toggle = document.getElementById('aiNoteToggle');
    const note = document.getElementById('aiNote');
    if (toggle && note) {
      toggle.addEventListener('click', () => {
        note.hidden = !note.hidden;
        toggle.textContent = note.hidden ? 'ตัวเลขนี้มาจากไหน' : 'ซ่อนคำอธิบาย';
      });
    }
  }

  /* ---------- อัปเดตตามตำแหน่ง ---------- */

  /*
   * เรียกได้บ่อยเท่าไรก็ได้ — จะไปดึงของใหม่ก็ต่อเมื่อข้ามเข้าจังหวัดอื่นจริง ๆ
   * เพราะโมเดลทำนายระดับจังหวัด ขยับไปสองสามกิโลผลไม่เปลี่ยน
   */
  async function updateFor(lngLat) {
    if (failed || inFlight || !lngLat) return;

    try {
      await window.AIForecast.init();
    } catch (err) {
      failed = true;
      renderFailed();
      console.warn('ส่วนพยากรณ์ใช้งานไม่ได้:', err.message);
      return;
    }

    const province = window.AIForecast.provinceAt(lngLat);
    if (!province) return;
    if (province.geocode === currentGeocode && current) return;

    inFlight = true;
    renderLoading();
    try {
      const result = await window.AIForecast.forecastProvince(province);
      current = result;
      currentGeocode = province.geocode;
      renderCard(result);
      // คะแนนความปลอดภัยรอบตัวใช้ผลนี้ด้วย ต้องวาดใหม่เมื่อผลเพิ่งมาถึง
      window.UI.renderList();
    } catch (err) {
      // อากาศดึงไม่ได้ก็แค่ไม่มีการ์ด ไม่ต้องปิดตายทั้งระบบ เผื่อครั้งหน้าเน็ตกลับมา
      console.warn('พยากรณ์ไม่สำเร็จ:', err.message);
      if (!current) renderFailed();
    } finally {
      inFlight = false;
    }
  }

  /* ---------- ใช้ที่อื่น ---------- */

  /* ผลพยากรณ์ล่าสุด — คืน null ถ้ายังไม่พร้อม ผู้เรียกต้องรับมือได้ */
  function currentForecast() {
    return current;
  }

  /*
   * ข้อความเตือนตอนเริ่มนำทาง
   *
   * เตือนเฉพาะวันที่โมเดลบอกว่าเกิน threshold จริง ๆ ถ้าเตือนทุกวัน
   * ผู้ใช้จะเลิกอ่านภายในสามวัน แล้วคำเตือนก็ไร้ความหมาย
   */
  function navigationNotice() {
    if (!current) return null;
    if (current.level.key === 'normal' || current.level.key === 'watch') return null;

    const reason = current.reasons[0];
    const head = `${current.province}วันนี้${current.level.label}`;
    return {
      level: current.level,
      text: reason ? `${head} — ${reason.text}` : head,
      speech: reason
        ? `วันนี้ในจังหวัด${current.province} ${current.level.label} ${reason.text}`
        : `วันนี้ในจังหวัด${current.province} ${current.level.label}`,
    };
  }

  return { updateFor, currentForecast, navigationNotice, renderCard };
})();
