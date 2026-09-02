/* ส่วนติดต่อผู้ใช้: แผงรายการ ตัวกรอง ฟอร์มแจ้งเหตุ และการแจ้งเตือนบนหน้าจอ */
window.UI = (function () {
  const CFG = window.APP_CONFIG;
  const U = window.Utils;
  const { $, $$, el, escapeHtml } = U;

  let pendingLocation = null;   // [lng, lat] ที่ผู้ใช้เลือกไว้ในฟอร์ม
  let formType = 'accident';
  let formSeverity = 'medium';
  let nearbyCache = [];
  let alertTimer = null;

  /* ---------- ตัวกรองประเภท ---------- */

  const typeCount = Object.keys(CFG.HAZARD_TYPES).length;

  /** รายการกรองแบบเต็มในแผ่นซ้อน */
  function renderFilterSheet() {
    const box = $('#filterList');
    box.innerHTML = '';
    for (const [key, def] of Object.entries(CFG.HAZARD_TYPES)) {
      const row = el('button', 'filter-row');
      row.type = 'button';
      row.dataset.type = key;
      row.style.setProperty('--row-color', def.color);
      row.innerHTML = `
        <span class="filter-row__icon">${def.icon}</span>
        <span class="filter-row__label">${escapeHtml(def.label)}</span>
        <span class="filter-row__check">${window.Icons.get("check")}</span>`;
      row.addEventListener('click', () => window.Store.toggleType(key));
      box.appendChild(row);
    }
    syncFilters();
  }

  function syncFilters() {
    const active = window.Store.state.activeTypes;

    $$('#filterList .filter-row').forEach((row) => {
      row.classList.toggle('is-on', active.has(row.dataset.type));
    });

    // จุดสีบนปุ่มคัดกรอง บอกว่ากำลังซ่อนภัยบางประเภทอยู่
    const filtering = active.size !== typeCount;
    $('#filterDot').hidden = !filtering;
    $('#btnFilter').classList.toggle('is-on', filtering);
    $('#btnFilter').title = filtering
      ? `คัดกรองอยู่ — แสดง ${active.size} จาก ${typeCount} ประเภท`
      : 'คัดกรองประเภทภัย';
  }

  /* ---------- ที่มาของรายงาน ---------- */

  /**
   * ป้ายบอกว่ารายงานมาจากคนแจ้ง หรือเป็นจุดที่ระบบคาดการณ์ไว้เอง
   * ทั้งสองแบบใช้ไอคอนและสีคนละชุด เพื่อให้แยกออกตั้งแต่แรกเห็น
   */
  function sourceTag(report) {
    const predicted = (report.source || 'user') === 'predicted';
    return `<span class="src-tag src-tag--${predicted ? 'predicted' : 'user'}">
        ${window.Icons.get(predicted ? 'spark' : 'person')}
        ${predicted ? 'ระบบคาดการณ์' : 'ผู้ใช้แจ้ง'}
      </span>`;
  }

  /* ---------- รายการภัย ---------- */

  function origin() {
    const s = window.Store.state;
    if (s.userPosition) return s.userPosition;
    const map = window.MapView.instance;
    if (map) {
      const c = map.getCenter();
      return [c.lng, c.lat];
    }
    return CFG.DEFAULT_CENTER;
  }

  /*
   * แผ่นนี้ชื่อ "ความปลอดภัยรอบตัว" ทุกอย่างในนั้นจึงต้องอยู่บนฐานเดียวกัน
   * คือรัศมี 5 กม. เท่ากับที่การ์ดคะแนนใช้ และรวมทั้งสองแหล่งเหมือนกัน:
   * รายงานที่คนแจ้ง + จุดเสี่ยงจากสถิติ
   *
   * เดิมรายการนับทุกรายงานที่มีในเครื่องไม่สนระยะ เลยเกิดภาพที่ขัดกันเอง —
   * หัวแผ่นบอก "ทั้งหมด 14" แต่การ์ดใต้มันบอก "0 รายงานในรัศมี 5 กม."
   */
  function renderList() {
    const list = $('#hazardList');
    const here = origin();
    const items = window.Store.nearbyReports(here);
    const spots = window.Hotspots.near(here, 5000, 20);
    const selectedId = window.Store.state.selectedId;

    $('#sidebarCount').textContent = items.length + spots.length;
    list.innerHTML = '';

    if (!items.length && !spots.length) {
      const empty = el('li', 'empty-state');
      const searching = window.Store.state.search.trim();
      empty.innerHTML = searching
        ? `<div>${window.Icons.get('search')}</div><p>ไม่พบรายงานที่ตรงกับ “${escapeHtml(searching)}”<br />ลองคำอื่น หรือล้างช่องค้นหา</p>`
        : `<div>${window.Icons.get('map')}</div><p>ไม่มีจุดเสี่ยงในรัศมี 5 กม.<br />เลื่อนแผนที่ไปดูที่อื่น หรือกด “แจ้งเหตุ”</p>`;
      list.appendChild(empty);
    }

    for (const item of items) {
      const def = CFG.HAZARD_TYPES[item.type];
      const sev = CFG.SEVERITY[item.severity];
      const li = el('li', 'hazard-item');
      li.dataset.id = item.id;
      li.style.setProperty('--item-color', def.color);
      li.classList.toggle('is-selected', item.id === selectedId);

      // ความเสี่ยงรายจุดเป็น % ให้เทียบกันได้ทันทีว่าจุดไหนน่ากลัวกว่า
      const pct = window.Store.pointRisk(item, item.distance);
      const pctLevel = pct >= 70 ? 'high' : pct >= 40 ? 'medium' : 'low';

      li.innerHTML = `
        <div class="hazard-item__icon">${def.icon}</div>
        <div class="hazard-item__body">
          <div class="hazard-item__top">
            <strong>${escapeHtml(def.label)}</strong>
            <span class="sev sev--${item.severity}">${escapeHtml(sev.label)}</span>
          </div>
          <div class="hazard-item__road">${escapeHtml(item.road)}</div>
          <div class="hazard-item__meta">
            ${item.distance != null ? `<span>${U.formatDistance(item.distance)}</span>` : ''}
            <span>${U.formatAgo(item.createdAt)}</span>
            ${sourceTag(item)}
          </div>
        </div>
        <span class="hazard-item__risk hazard-item__risk--${pctLevel}"
              title="ความเสี่ยงของจุดนี้ ${pct}%">
          <strong>${pct}<small>%</small></strong>
          <em>เสี่ยง</em>
        </span>`;

      li.addEventListener('click', () => {
        window.Store.select(item.id);
        // กางแผ่นก่อนแล้วค่อยบินไปหาหมุด กล้องจะได้รู้ว่าเหลือพื้นที่ให้เห็นแค่ไหน
        // ถ้าบินก่อน มันจะเล็งด้วยขนาดแผ่นเดิม พอแผ่นกางขึ้นมาก็ทับหมุดพอดี
        collapseToMap();
        window.MapView.flyToReport(item);
      });
      list.appendChild(li);
    }

    /*
     * จุดเสี่ยงจากสถิติต่อท้าย มีหัวข้อคั่นให้เห็นว่าเป็นคนละชนิดข้อมูล
     * — ของบนคือสิ่งที่คนเพิ่งแจ้ง ของล่างคือที่ที่เคยเกิดซ้ำมา 4 ปี
     */
    if (spots.length) {
      const head = el('li', 'list-divider');
      head.innerHTML = `<span>จุดเสี่ยงจากสถิติ</span><small>${spots.length} จุดในรัศมี 5 กม.</small>`;
      list.appendChild(head);
    }

    for (const spot of spots) {
      const cat = window.Hotspots.classify(spot);
      const li = el('li', 'hazard-item hazard-item--stat');
      li.style.setProperty('--item-color', cat.color);
      li.innerHTML = `
        <div class="hazard-item__icon">${window.Icons.get(cat.icon)}</div>
        <div class="hazard-item__body">
          <div class="hazard-item__top">
            <strong>${escapeHtml(cat.label)}</strong>
            <span class="src-tag src-tag--stat">สถิติ</span>
          </div>
          <div class="hazard-item__road">${escapeHtml(spot.road || spot.province)}</div>
          <div class="hazard-item__meta">
            <span>${U.formatDistance(spot.distance)}</span>
            <span>เกิด ${spot.accidents} ครั้ง</span>
            ${spot.dead ? `<span>เสียชีวิต ${spot.dead}</span>` : ''}
          </div>
        </div>
        <span class="hazard-item__risk hazard-item__risk--stat" title="ข้อมูลจากสถิติอุบัติเหตุจริง">
          <strong>${spot.accidents}</strong>
          <em>ครั้ง</em>
        </span>`;
      li.addEventListener('click', () => {
        collapseToMap();
        window.UI.showHotspot(spot);
      });
      list.appendChild(li);
    }

    const total = window.Store.state.reports.length;
    const high = window.Store.state.reports.filter((r) => r.severity === 'high').length;
    $('#statsLine').textContent = `ทั้งหมด ${total} รายงาน · อันตราย ${high} จุด`;

    // สรุปความเสี่ยงใช้ข้อมูลชุดเดียวกัน จึงวาดใหม่พร้อมกันเสมอ
    renderRisk();
  }

  /* ---------- สรุปความเสี่ยง ---------- */

  function renderRisk() {
    const box = $('#riskPanel');
    const risk = window.Store.riskAssessment(origin());
    const known = window.Store.state.userPosition != null;

    /*
     * เอาผลโมเดลพยากรณ์มาปรับคะแนนด้วย — สามแหล่งรวมเป็นตัวเลขเดียว
     *
     *   รายงานผู้ใช้     สิ่งที่กำลังเกิดรอบตัวตอนนี้
     *   จุดเสี่ยงสถิติ    ที่ที่เคยเกิดซ้ำ ๆ มา 4 ปี
     *   โมเดลพยากรณ์    วันนี้เป็นวันแบบไหนสำหรับจังหวัดนี้
     *
     * ใช้ blendRouteScore ตัวเดียวกับที่ใช้กับคะแนนเส้นทาง เกณฑ์จึงตรงกัน
     * ทั้งแอป — ถ่วงน้ำหนักโมเดล 30% และวันที่ปกติจะไม่ขยับคะแนนเลย
     */
    const forecast = window.AIUI?.currentForecast?.() || null;
    const blended = window.AIForecast.blendRouteScore(risk.score, forecast);
    const level = blended.adjusted ? window.Store.riskLevelFor(blended.score) : risk.level;

    box.style.setProperty('--risk-color', level.color);
    box.dataset.level = level.key;

    const nearestText = risk.nearest && risk.nearest.distance != null
      ? U.formatDistance(risk.nearest.distance)
      : '—';

    // พาดหัวเป็น "ปลอดภัยกี่ %" ซึ่งอ่านง่ายกว่าคะแนนเสี่ยง 0-100 ที่ยิ่งมากยิ่งแย่
    const safety = 100 - blended.score;

    box.innerHTML = `
      <div class="risk__head">
        <span class="risk__level">${escapeHtml(level.label)}</span>
        <span class="risk__score">${safety}<small>%</small></span>
      </div>
      <div class="risk__meter" role="meter" aria-valuenow="${safety}"
           aria-valuemin="0" aria-valuemax="100"
           aria-label="ความปลอดภัยรอบตัว ${safety} เปอร์เซ็นต์">
        <div class="risk__bar" style="width:${Math.max(safety, 2)}%"></div>
      </div>
      <p class="risk__summary">
        <strong>${risk.count}</strong> รายงานในรัศมี ${Math.round(risk.radius / 1000)} กม.
        ${risk.high ? ` · <strong>${risk.high}</strong> อันตราย` : ''}
        ${risk.nearest ? ` · ใกล้สุด <strong>${escapeHtml(nearestText)}</strong>` : ''}
        ${known ? '' : ' · คิดจากกลางจอ'}
      </p>
      ${risk.hotspotCount ? `
        <p class="risk__summary risk__summary--stat">
          <strong>${risk.hotspotCount}</strong> จุดเสี่ยงจากสถิติในรัศมี
          ${Math.round(risk.hotspotRadius / 1000)} กม.
          ${risk.nearestHotspot
            ? ` · ใกล้สุด <strong>${escapeHtml(U.formatDistance(risk.nearestHotspot.distance))}</strong>`
            : ''}
        </p>` : ''}
      ${blended.adjusted ? `
        <p class="risk__summary risk__summary--ai">
          <span class="risk__ai-badge">AI</span>
          ${escapeHtml(forecast.province)}วันนี้${escapeHtml(forecast.level.label)}
          ${blended.delta > 0 ? 'จึงหัก' : 'จึงเพิ่ม'}คะแนนปลอดภัย
          ${Math.abs(blended.delta)} จุด (จาก ${100 - blended.original}%)
        </p>` : ''}`;
  }

  /* ---------- การ์ดรายละเอียด ---------- */

  function renderDetail() {
    const card = $('#sheetDetail');
    const sheet = $('#sidebar');
    const id = window.Store.state.selectedId;
    const report = window.Store.state.reports.find((r) => r.id === id);

    // ไม่มีอะไรถูกเลือก = กลับไปโหมดรายการตามปกติ
    if (!report) {
      sheet.classList.remove('is-detail');
      card.innerHTML = '';
      return;
    }

    const def = CFG.HAZARD_TYPES[report.type];
    const sev = CFG.SEVERITY[report.severity];
    const dist = U.distance(origin(), [report.lng, report.lat]);

    const pct = window.Store.pointRisk(report, dist);
    const pctLevel = pct >= 70 ? 'high' : pct >= 40 ? 'medium' : 'low';

    sheet.classList.add('is-detail');
    card.style.setProperty('--card-color', def.color);
    /*
     * เรียงจากบนลงล่างเป็นชั้น ๆ ชัดเจน: หัวเรื่อง → ชื่อถนน → บันทึก → ตัวเลข → ปุ่ม
     * ของเดิมยัดป้ายหลายอันไว้บรรทัดเดียวกัน พอชื่อยาวขึ้นก็ตีกัน
     */
    card.innerHTML = `
      <div class="detail-card__head">
        <div class="detail-card__icon">${def.icon}</div>
        <div class="detail-card__headText">
          <strong>${escapeHtml(def.label)}</strong>
          <h3 class="detail-card__road">${escapeHtml(report.road)}</h3>
        </div>
        <span class="detail-card__risk detail-card__risk--${pctLevel}">
          <strong>${pct}<small>%</small></strong>
          <em>เสี่ยง</em>
        </span>
      </div>

      <div class="detail-card__tags">
        <span class="sev sev--${report.severity}">${escapeHtml(sev.label)}</span>
        ${sourceTag(report)}
      </div>

      ${report.note ? `<p class="detail-card__note">${escapeHtml(report.note)}</p>` : ''}

      <dl class="detail-card__stats">
        <div><dt>ระยะห่าง</dt><dd>${U.formatDistance(dist)}</dd></div>
        <div><dt>รัศมีเตือน</dt><dd>${report.radius} ม.</dd></div>
        <div><dt>รายงานเมื่อ</dt><dd>${U.formatAgo(report.createdAt)}</dd></div>
      </dl>

      <button class="primary-btn detail-card__nav" data-act="navigate">${window.Icons.get('navigate')} นำทางไปจุดนี้</button>
      <div class="detail-card__actions">
        <button class="ghost-btn" data-act="up">ยังอยู่ · ${report.confirms}</button>
        <button class="ghost-btn" data-act="down">หายแล้ว · ${report.denies}</button>
        ${report.mine ? '<button class="ghost-btn danger" data-act="delete">ลบ</button>' : ''}
      </div>`;

    card.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'delete') {
          window.Store.removeReport(report.id);
          toast('ลบรายงานแล้ว');
        } else if (act === 'navigate') {
          // ผ่านแผ่นสรุปการเดินทางก่อน เพื่อให้เลือกพาหนะและเห็นความเสี่ยงของเส้นทาง
          openTripSheet({
            name: report.road || def.label,
            detail: def.label,
            lng: report.lng,
            lat: report.lat,
          });
        } else {
          window.Store.vote(report.id, act === 'up' ? 'up' : 'down');
        }
      });
    });
  }

  /* ---------- โหมดนำทาง ---------- */

  /**
   * เริ่มนำทางจากตำแหน่งปัจจุบัน (หรือกลางจอถ้ายังไม่เปิด GPS) ไปยังจุดหมาย
   * @param {object} opts.vehicle 'car' | 'motorbike'
   * @param {object} opts.preRoute เส้นทางที่แผ่นสรุปการเดินทางคำนวณไว้แล้ว
   */
  async function startNavigation(dest, opts = {}) {
    const from = origin();
    if (!from) {
      toast('ยังไม่ทราบตำแหน่งเริ่มต้น', 'warn');
      return;
    }

    window.Alerts.ensureAudio();
    if (!opts.preRoute) toast('กำลังคำนวณเส้นทาง…');

    try {
      const route = await window.Navigate.start(from, dest, opts);
      $('#phone').classList.add('is-navigating');
      const risky = window.RouteRisk.segments(window.Navigate.analysis);
      /*
       * การนำทางเกิดบนแผนที่เสมอ จึงต้องสลับกลับมาแท็บแผนที่ก่อน
       * ไม่งั้นถ้าสั่งเริ่มนำทางจากหน้าตั้งค่า/แดชบอร์ด (เช่นเปิดโหมดจำลอง)
       * หน้านั้นจะยังคลุมแผนที่อยู่ แล้วการ์ดนำทางไปลอยทับรายการตั้งค่าแทน
       */
      setView('map');
      // เริ่มนำทาง = ล็อกกล้องไว้ที่ลูกศรก่อนเสมอ
      window.Store.setFollowing(true);
      setDetent('closed');
      window.MapView.setNavRoute(route.coordinates, risky);

      if (opts.skipOverview) {
        // โหมดจำลองเริ่มขับทันที ถ้ายังโชว์ภาพรวมอยู่กล้องจะถูกแย่งไปมา
        window.MapView.navCamera(from, window.Store.state.userHeading, true);
      } else {
        // โชว์เส้นทางทั้งเส้นให้เห็นภาพรวมก่อน แล้วค่อยซูมกลับเข้ามาที่ตัวผู้ใช้
        window.MapView.fitRoute(route.coordinates);
        setTimeout(() => {
          if (!window.Navigate.isActive) return;
          const pos = window.Store.state.userPosition || from;
          window.MapView.navCamera(pos, window.Store.state.userHeading, true);
        }, 1600);
      }
      renderNav();

      if (!window.Store.state.userPosition) {
        toast('เปิดติดตามตำแหน่งหรือโหมดจำลองการขับ เพื่อให้นำทางเดินหน้าได้', 'warn');
      }

      announceForecast();
    } catch (err) {
      toast(err.message || 'หาเส้นทางไม่สำเร็จ', 'warn');
    }
  }

  /*
   * การ์ดรายละเอียดจุดเสี่ยงจากสถิติจริง (แตะวงกลมบนแผนที่)
   *
   * ใช้แผ่นรายละเอียดตัวเดียวกับหมุดรายงาน แต่เนื้อหาคนละแบบสิ้นเชิง —
   * ตรงนี้ไม่มี "เมื่อกี้มีคนแจ้ง" มีแต่ "ที่นี่เกิดมาแล้วกี่ครั้งใน 4 ปี"
   * จึงต้องบอกให้ชัดว่าเป็นสถิติย้อนหลัง ไม่ใช่เหตุที่กำลังเกิดอยู่
   */
  /*
   * สาเหตุที่พบบ่อยที่สุด — ยกขึ้นมาเป็นบล็อกเด่น
   *
   * เดิมเป็นบรรทัดสีเทาเล็ก ๆ ท้ายการ์ด ทั้งที่มันคือคำตอบของคำถามที่คนขับ
   * อยากรู้ที่สุด: "แล้วตรงนี้มันชนกันเพราะอะไร" ตัวเลขบอกว่าอันตรายแค่ไหน
   * แต่สาเหตุคือสิ่งเดียวที่บอกว่าจะระวังอะไร
   */
  function causeBlock(h, cat) {
    /*
     * ประเภทที่จัดจากลักษณะทางหรือช่วงเวลา (โค้ง/แยก/ลาดชัน/ทัศนวิสัย)
     * มีคำอธิบายของตัวเองว่าปัจจัยตรงนี้คืออะไร
     * ส่วนประเภทที่เหลือใช้สาเหตุจริงที่ต้นทางบันทึกไว้
     *
     * ป้ายกำกับต่างกันตามที่มา จะได้ไม่อ้างว่าข้อความนี้มาจากสถิติทั้งที่ไม่ใช่
     */
    const fromCategory = !!cat.cause;
    // ข้อความดิบจากต้นทางเป็นภาษาราชการและมีคู่ซ้ำ — จัดให้สั้นและตรงประเด็นก่อน
    const cause = fromCategory ? cat.cause : window.Hotspots.cleanCause(h.cause);
    if (!cause) return '';

    return `
      <div class="hotspot-cause" style="--cat-color:${cat.color}">
        <span class="hotspot-cause__label">${
          fromCategory ? 'ปัจจัยที่ทำให้เกิดเหตุ' : 'สาเหตุที่พบบ่อยที่สุด'
        }</span>
        <strong class="hotspot-cause__text">${escapeHtml(cause)}</strong>
      </div>`;
  }

  /*
   * ความรุนแรงของการชน — บอกเป็นประโยคที่เห็นภาพ ไม่ใช่แค่ตัวเลขลอย ๆ
   *
   * "5 ครั้ง 3 เสียชีวิต" อ่านแล้วยังต้องคิดต่อเอง แต่ "เกิด 5 ครั้ง มีคนตาย 3 คน"
   * เข้าใจทันที และการเทียบสัดส่วนตาย/ครั้ง ทำให้แยกออกว่าจุดไหน "ชนแล้วตาย"
   * กับจุดไหน "ชนบ่อยแต่เจ็บเล็กน้อย" ซึ่งเป็นคนละปัญหาและแก้คนละแบบ
   */
  function outcomeBlock(h) {
    if (!h.dead && !h.injured) return '';

    const parts = [];
    if (h.dead) parts.push(`<strong>เสียชีวิต ${h.dead} คน</strong>`);
    if (h.injured) parts.push(`บาดเจ็บ ${h.injured} คน`);

    // ตายมากกว่าครึ่งของจำนวนครั้ง = ชนทีไรถึงตายแทบทุกที ไม่ใช่จุดที่ชนเบา ๆ บ่อย
    const deadly = h.dead > 0 && h.dead / h.accidents >= 0.5;

    return `
      <div class="hotspot-outcome${deadly ? ' is-deadly' : ''}">
        <span class="hotspot-outcome__icon">${window.Icons.get(deadly ? 'accident' : 'shield')}</span>
        <span class="hotspot-outcome__text">
          เกิด ${h.accidents} ครั้ง · ${parts.join(' · ')}
          ${deadly ? '<br><small>ชนแล้วถึงตายเกินครึ่งของครั้งที่เกิด</small>' : ''}
        </span>
      </div>`;
  }

  /*
   * การ์ดจุดสถิติ แยกออกมาเป็นข้อความล้วนเพราะมีสองที่ที่ต้องวาดมัน
   * — แผ่นความปลอดภัยตอนจอด และแผ่นจุดเสี่ยงตอนกำลังนำทาง (แผ่นซ้อนคนละใบ)
   */
  function hotspotCardHtml(h) {
    const level = window.Hotspots.levelOf(h.severity);
    const cat = window.Hotspots.classify(h);
    return `
      <div class="hotspot-card">
        <div class="hotspot-card__head">
          <span class="hotspot-card__badge">สถิติจริง</span>
          <span class="hotspot-card__level" style="color:${level.color}">
            ${escapeHtml(level.label)}
          </span>
        </div>

        <span class="hotspot-card__cat" style="--cat-color:${cat.color}">
          ${window.Icons.get(cat.icon)}${escapeHtml(cat.label)}
        </span>

        <h3 class="hotspot-card__road">${escapeHtml(h.road || 'ไม่ระบุสายทาง')}</h3>
        <p class="hotspot-card__where">
          ${escapeHtml(h.province)}${h.geometry ? ` · ${escapeHtml(h.geometry)}` : ''}
        </p>

        ${causeBlock(h, cat)}

        ${outcomeBlock(h)}

        <div class="hotspot-card__stats">
          <div><strong>${h.accidents}</strong><span>ครั้ง</span></div>
          <div class="${h.dead ? 'is-fatal' : ''}"><strong>${h.dead}</strong><span>เสียชีวิต</span></div>
          <div><strong>${h.injured}</strong><span>บาดเจ็บ</span></div>
          <div><strong>${h.perYear}</strong><span>ครั้ง/ปี</span></div>
        </div>

        <p class="hotspot-card__hint">${escapeHtml(cat.hint)}</p>

        ${h.nightShare >= 0.4 ? `<p class="hotspot-card__line">เกิดตอนกลางคืน <strong>${Math.round(h.nightShare * 100)}%</strong> ของครั้งทั้งหมด</p>` : ''}
        ${h.rainShare >= 0.2 ? `<p class="hotspot-card__line">มีฝนตอนเกิดเหตุ <strong>${Math.round(h.rainShare * 100)}%</strong> ของครั้งทั้งหมด</p>` : ''}

        <p class="hotspot-card__note">
          สถิติสะสมปี 2565–2569 จากข้อมูลอุบัติเหตุบนโครงข่ายถนนของกระทรวงคมนาคม
          ไม่ใช่เหตุที่กำลังเกิดอยู่ตอนนี้ · เกิดล่าสุด ${escapeHtml(h.latest)}
        </p>
      </div>`;
  }

  function showHotspot(h) {
    /*
     * ระหว่างนำทาง แผ่นความปลอดภัยถูกจางทิ้งไปแล้ว (.is-navigating .sidebar)
     * ถ้าวาดการ์ดลงไปตรงนั้น ผู้ใช้กดหมุดแล้วจะไม่เห็นอะไรเลย
     * จึงส่งไปขึ้นบนแผ่นจุดเสี่ยงซึ่งลอยอยู่เหนือจอนำทางแทน
     */
    if (window.Navigate.isActive) {
      openRiskFocus({ kind: 'hotspot', h });
      return;
    }

    const level = window.Hotspots.levelOf(h.severity);
    const card = $('#sheetDetail');

    // ยกเลิกการเลือกหมุดรายงาน ไม่งั้น renderDetail() จะมาวาดทับการ์ดนี้
    window.Store.select(null);

    $('#sidebar').classList.add('is-detail');
    card.style.setProperty('--card-color', level.color);
    card.innerHTML = hotspotCardHtml(h);

    collapseToMap();
    window.MapView.instance.flyTo({ center: [h.lon, h.lat], zoom: 15.5, duration: 900 });
  }

  /*
   * แจ้งผลพยากรณ์ของวันนี้ตอนเริ่มนำทาง
   *
   * ตั้งใจแจ้งเฉพาะวันที่โมเดลบอกว่าเกินเกณฑ์จริง (ระดับ "ควรระวัง" ขึ้นไป)
   * ถ้าเด้งทุกครั้งที่กดนำทาง ผู้ใช้จะเลิกอ่านภายในไม่กี่วัน แล้วคำเตือนก็ไร้ค่า
   *
   * หน่วงไว้ให้ toast "กำลังคำนวณเส้นทาง" ผ่านไปก่อน จะได้ไม่ทับกัน
   */
  function announceForecast() {
    const notice = window.AIUI?.navigationNotice?.();
    if (!notice) return;

    setTimeout(() => {
      if (!window.Navigate.isActive) return;
      toast(notice.text, 'warn');
      if (window.Alerts.settings.voice) window.Alerts.speak(notice.speech);
    }, 2200);
  }

  /**
   * พากล้องกลับไปที่หัวลูกศรของผู้ใช้ — ใช้ร่วมกันทั้งหน้าแผนที่และหน้านำทาง
   * ถ้ายังไม่รู้ตำแหน่ง จะเริ่มติดตามตำแหน่งให้เลย
   */
  function goToMyLocation() {
    const s = window.Store.state;

    if (!s.userPosition) {
      toast('กำลังหาตำแหน่งของคุณ…');
      $('#btnTrack').click();
      return;
    }

    setView('map');
    window.Store.setFollowing(true);

    if (window.Navigate.isActive) {
      window.MapView.navCamera(s.userPosition, s.userHeading, true);
    } else {
      // กดปุ่มตำแหน่งของฉัน = หันแผนที่ให้ขนานกับหัวลูกศร (ลูกศรชี้ตรงขึ้น)
      // อยากกลับไปทิศเหนือก็กดปุ่มเข็มทิศที่โผล่ขึ้นมาข้าง ๆ
      window.MapView.followUser(s.userPosition, s.userHeading, { headingUp: true });
    }
    renderNav();
  }

  function stopNavigation() {
    window.Navigate.stop();
    // โหมดจำลองขับตามเส้นทางที่นำทางอยู่ จบนำทางแล้วก็ต้องหยุดขับด้วย
    // ไม่งั้นหมุดจะวิ่งต่อไปเรื่อย ๆ ทั้งที่ไม่มีเส้นทางแล้ว
    if (window.Alerts.isSimulating) window.Alerts.stopSimulation();
    $('#phone').classList.remove('is-navigating');
    window.MapView.setNavRoute(null);
    showNavHazard(null);
    closeRiskSheet();
    renderNav();
    setDetent('peek');
    syncSettings();
  }

  /* ---------- ฉากสาธิตของโหมดจำลองการขับ ---------- */

  /** ดัชนีจุดบนเส้นทางที่ระยะสะสมใกล้ค่าที่ต้องการที่สุด */
  function indexAtAlong(route, meters) {
    const cum = route.cumulative;
    for (let i = 0; i < cum.length; i++) if (cum[i] >= meters) return i;
    return cum.length - 1;
  }

  /** ชื่อถนนของช่วงที่ครอบจุดนี้อยู่ */
  function roadNameAt(route, index) {
    let name = '';
    for (const step of route.steps) {
      if (step.startIndex <= index) name = step.roadName || name;
      else break;
    }
    return name || 'ถนนเส้นทางสาธิต';
  }

  /**
   * จุดแรกบนเส้นทางหลักที่ "แยกออกจากเส้นทางสำรองแล้วจริง ๆ"
   *
   * ต้องวางจุดเสี่ยงหลังจุดนี้เท่านั้น ไม่งั้นจุดจะไปตกบนช่วงที่ทั้งสองเส้นใช้ร่วมกัน
   * แล้วเส้นทางสำรองก็จะเสี่ยงเท่ากัน — สาธิตการเลี่ยงเส้นทางไม่ได้เลย
   */
  function firstDivergence(main, alt) {
    if (!alt) return 0;
    for (let i = 0; i < main.coordinates.length; i++) {
      let nearest = Infinity;
      // สุ่มเทียบทีละ 5 จุดก็พอ เส้นทางละเอียดกว่านั้นอยู่แล้ว
      for (let j = 0; j < alt.coordinates.length; j += 5) {
        const d = U.distance(main.coordinates[i], alt.coordinates[j]);
        if (d < nearest) nearest = d;
        if (nearest <= 250) break;
      }
      if (nearest > 250) return i;
    }
    return 0;
  }

  /**
   * สร้างจุดเสี่ยงของฉากสาธิตลงบน "เส้นทางที่เร็วที่สุด"
   *
   * วางบนพิกัดจริงที่ OSRM คืนมา ไม่ใช่พิกัดตายตัวที่จดไว้ล่วงหน้า
   * ฉากจึงทำงานได้เสมอไม่ว่า OSRM จะให้เส้นทางแบบไหนมาในวันนั้น
   *
   * จุดยึดมีสองแบบ:
   *  - start    วัดจากต้นทาง ใช้กับอุบัติเหตุจุดแรก ให้เจอการเตือนภายในไม่กี่วินาที
   *             ไม่ต้องรอขับไปหลายกิโลก่อนถึงจะได้เห็นอะไร
   *  - diverge  วัดจากจุดที่เส้นทางสองเส้นแยกจากกัน ใช้กับกลุ่มที่ต้องทำให้
   *             "เส้นทางสำรองปลอดภัยกว่าจริง" ถ้าไปวางบนช่วงที่ใช้ถนนร่วมกัน
   *             ทั้งสองเส้นจะเสี่ยงเท่ากัน แล้วสาธิตการเลี่ยงเส้นทางไม่ได้เลย
   *
   * กลุ่มรถติดวางติดกันสามจุดเพื่อให้เส้นทางบนแผนที่ระบายเป็นแถบสียาวพอให้เห็นชัด
   * (จุดเดียวจะได้แถบสั้นมากจนไม่รู้ว่าเปลี่ยนสี)
   */
  function buildDemoScenario(routes, mainIndex = 0, statOnlyIndex = null) {
    // วางฉากลงบนเส้นที่เลือกไว้ ไม่ใช่เส้นที่เร็วที่สุดเสมอไป
    // (ผู้เรียกเลือกเส้นที่ผ่านจุดสถิติมากที่สุด เพื่อให้เจอครบทั้งสองแหล่ง)
    const main = routes[mainIndex] || routes[0];

    /*
     * แยกทางจาก "เส้นที่ต้องสะอาด" เป็นหลัก
     *
     * ถ้าวัดจากเส้นอื่นแล้ววางของก่อนจุดแยก รายงานจะไปตกบนช่วงถนนที่ใช้ร่วมกัน
     * แล้วเส้นที่ตั้งใจให้มีแต่จุดจากโมเดล ก็จะมีรายงานของคนปนเข้าไปด้วย
     * ซึ่งทำให้การเทียบสองเส้นไม่มีความหมาย
     */
    const avoid = statOnlyIndex != null ? routes[statOnlyIndex] : null;
    const other = avoid || routes.find((r) => r !== main) || routes[0];
    const divergeAlong = main.cumulative[firstDivergence(main, other)] || 0;
    const now = Date.now();

    const plan = [
      { from: 'diverge', at: 150, type: 'accident', severity: 'high', note: 'รถชนประสานงา ปิด 2 เลน รอเจ้าหน้าที่', ageMin: 6, confirms: 14 },
      { from: 'diverge', at: 300, type: 'traffic', severity: 'medium', note: 'ท้ายแถวยาว รถเคลื่อนตัวช้ามาก', ageMin: 4, confirms: 9 },
      { from: 'diverge', at: 700, type: 'traffic', severity: 'medium', note: 'รถติดสะสมจากอุบัติเหตุข้างหน้า', ageMin: 3, confirms: 7 },
      { from: 'diverge', at: 1100, type: 'traffic', severity: 'medium', note: 'ติดยาวถึงแยกหน้า', ageMin: 5, confirms: 6 },
      { from: 'diverge', at: 2600, type: 'flood', severity: 'high', note: 'น้ำท่วมขังสูงราว 30 ซม. รถเล็กเลี่ยง', ageMin: 25, confirms: 11 },
    ];

    return plan.map((p) => {
      const i = indexAtAlong(main, (p.from === 'start' ? 0 : divergeAlong) + p.at);
      const [lng, lat] = main.coordinates[i];
      return {
        id: U.uid(),
        type: p.type,
        severity: p.severity,
        lng,
        lat,
        road: roadNameAt(main, i),
        note: p.note,
        radius: CFG.HAZARD_TYPES[p.type].defaultRadius,
        createdAt: now - p.ageMin * 60000,
        confirms: p.confirms,
        denies: 0,
        mine: false,
        source: 'user',
      };
    });
  }

  /**
   * เปิด/ปิดโหมดจำลองการขับ
   *
   * เปิดแล้วจัดฉากสาธิตให้ครบชุด: วางอุบัติเหตุกับกลุ่มรถติดลงบนเส้นทางที่เร็วที่สุด
   * แล้วเปิดแผ่นเปรียบเทียบเส้นทางให้เห็นว่ามีเส้นที่ปลอดภัยกว่าให้เลือก
   * พอกดเริ่มนำทางถึงค่อยขับตามเส้นที่เลือก — ลูกศรจะขนานกับถนนเพราะขับบนเส้นทางจริง
   */
  async function toggleSimulationDrive() {
    if (window.Alerts.isSimulating) {
      stopNavigation();
      window.Store.setFollowing(false);
      syncStatusButtons();
      toast('หยุดจำลองการขับแล้ว');
      return;
    }

    window.Alerts.ensureAudio();
    toast('กำลังจัดฉากสาธิต…');

    const trip = window.Alerts.SIM_TRIP;

    try {
      const routes = await window.Route.getRoutes(trip.from, trip.to);

      /*
       * ฉากสาธิตต้องโชว์ทั้งสองแหล่งความเสี่ยงในการขับรอบเดียว
       *
       * จุดจากโมเดลอยู่ที่ไหนเราเลือกไม่ได้ (มันคือสถิติจริง) แต่รายงานของผู้ใช้
       * เราวางเองได้ จึงเลือกเส้นทางที่ผ่านจุดสถิติมากที่สุดก่อน แล้วค่อยวาง
       * รายงานสาธิตลงบนเส้นเดียวกัน — ขับรอบเดียวจะเจอทั้งคำเตือนจากคนแจ้ง
       * และคำเตือนจากจุดที่โมเดลชี้
       */
      const withCounts = routes.map((r, i) => ({
        i,
        n: window.Hotspots.countAlongRoute(r.coordinates),
      }));
      const ranked = [...withCounts].sort((a, b) => b.n - a.n);

      /*
       * เส้นที่หนึ่ง = โดนทั้งสองแหล่ง (วางรายงานสาธิตลงไป)
       * เส้นที่สอง  = โดนเฉพาะจุดที่โมเดลชี้ ไม่มีรายงานของคนเลย
       *
       * มีไว้ให้เทียบกันตรง ๆ ว่าเส้นที่ "ไม่มีใครแจ้งอะไรเลย" ก็ยังมีความเสี่ยง
       * ที่โมเดลมองเห็นอยู่ ซึ่งเป็นประเด็นทั้งหมดของการมีโมเดล
       */
      const best = ranked[0] || { i: 0, n: 0 };
      const statOnly = ranked.find((r) => r.i !== best.i && r.n > 0) || null;

      demoRouteIndex = best.n > 0 ? best.i : 0;
      demoStatOnlyIndex = statOnly ? statOnly.i : null;

      window.Store.setDemoReports(
        buildDemoScenario(routes, demoRouteIndex, demoStatOnlyIndex),
      );

      // วางตัวผู้ใช้ที่จุดเริ่ม เพื่อให้ทุกอย่างคิดจากตรงนั้น ไม่ใช่จากกลางจอ
      const head = U.bearing(routes[0].coordinates[0], routes[0].coordinates[1] || trip.to);
      window.Store.setUserPosition(routes[0].coordinates[0], head, 0);
      setView('map');

      openTripSheet(
        {
          name: trip.label,
          detail: demoStatOnlyIndex != null
            ? `ฉากสาธิต — เทียบสองเส้น: เส้นหนึ่งมีทั้งรายงานและจุดจากโมเดล ${best.n} จุด อีกเส้นมีแต่จุดจากโมเดล ${statOnly.n} จุด`
            : `ฉากสาธิต — เส้นนี้มีทั้งรายงานจากผู้ใช้และจุดเสี่ยงที่โมเดลชี้ ${best.n} จุด`,
          lng: trip.to[0],
          lat: trip.to[1],
        },
        { routes, simulate: true, pick: demoRouteIndex }
      );
    } catch (_) {
      /*
       * ต่อ OSRM ไม่ได้ (ออฟไลน์/เซิร์ฟเวอร์ล่ม) — ยังให้ขับตามเส้นสาธิตแบบเดิมได้
       * จะไม่มีหน้านำทางกับคำสั่งเลี้ยว แต่ยังใช้ทดสอบการเตือนภัยรอบตัวได้อยู่
       */
      window.Alerts.startSimulation();
      window.Store.setFollowing(true);
      toast('ต่อเซิร์ฟเวอร์เส้นทางไม่ได้ — ขับตามเส้นสาธิตแบบไม่มีการนำทาง', 'warn');
    }

    syncSettings();
    syncStatusButtons();
  }

  /** วาดการ์ดนำทางและแถบสรุปด้านล่างจากความคืบหน้าล่าสุด */
  function renderNav() {
    const active = window.Navigate.isActive;
    $('#navCard').hidden = !active;
    $('#navBar').hidden = !active;
    $('#navStatus').hidden = !active;
    // ระหว่างนำทาง ถ้าผู้ใช้เลื่อนแผนที่เอง กล้องจะเลิกเกาะลูกศร จึงเสนอปุ่มให้กลับไปล็อก
    $('#btnRecenter').hidden = !active || window.Store.state.following;
    if (!active) return;

    const p = window.Navigate.progress;
    if (!p) return;

    $('#navArrow').innerHTML = window.Icons.get(p.step?.arrow || 'straight');
    $('#navDistance').textContent = U.formatDistance(p.distanceToManeuver);
    $('#navInstruction').textContent = p.step?.instruction || 'ตรงไป';

    $('#navRemaining').textContent = U.formatDistance(p.remaining);
    $('#navDuration').textContent = formatDuration(p.remainingSeconds);
    $('#navEta').textContent = new Date(Date.now() + p.remainingSeconds * 1000)
      .toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

    renderNavStatus();
  }

  /** มาตรวัดความเร็ว + ป้ายบอกว่าเส้นทางที่กำลังวิ่งปลอดภัยแค่ไหน */
  function renderNavStatus() {
    const speed = window.Store.state.userSpeed;
    // ยังไม่มีค่าความเร็ว (ยังไม่เปิด GPS / จอดนิ่ง) แสดงขีดแทนเลข 0 ที่ชวนเข้าใจผิด
    $('#navSpeed').textContent = speed == null ? '—' : Math.round(speed * 3.6);

    // แผ่นจุดเสี่ยงถ้าเปิดค้างไว้ ต้องนับระยะถอยลงตามที่วิ่งไปด้วย ไม่ใช่ค้างค่าเดิม
    syncRiskSheet();

    const a = window.Navigate.analysis;
    const safety = $('#navSafety');
    if (!a) {
      $('#navSafetyLabel').textContent = 'กำลังประเมิน';
      $('#navSafetyDetail').textContent = 'เส้นทางนี้';
      $('#navSafetyScore').textContent = '';
      return;
    }

    /*
     * ตัวเลขระหว่างขับต้องเป็นชุดเดียวกับที่แผ่นสรุปแสดงก่อนออกรถ
     * จึงผ่าน tripBlend() ตัวเดียวกัน — รวมผลโมเดลพยากรณ์เข้าไปด้วย
     * ถ้าคิดคนละสูตร ผู้ใช้จะเห็นเลขกระโดดตอนกดเริ่มนำทางโดยไม่มีเหตุผล
     */
    const blend = tripBlend(a);

    safety.style.setProperty('--safety-color', blend.color);
    safety.dataset.level = blend.levelKey;
    $('#navSafetyLabel').textContent = blend.levelLabel;

    // นับทั้งจุดที่คนแจ้ง และจุดเสี่ยงจากสถิติที่อยู่บนเส้นทางเดียวกัน
    const stats = window.Hotspots.routeCount();
    const parts = [];
    if (a.points.length) parts.push(`${a.points.length} รายงาน`);
    if (stats) parts.push(`${stats} จุดสถิติ`);
    $('#navSafetyDetail').textContent = parts.length
      ? `${parts.join(' · ')} บนเส้นทาง`
      : 'ไม่พบจุดเสี่ยงบนเส้นทาง';

    $('#navSafetyScore').innerHTML = `${blend.score}<small>%</small>`;
  }

  // โทนสีการ์ดเตือนตามระดับความรุนแรง — อุ่นทุกระดับ เพราะทุกอันคือ "สิ่งที่ต้องระวัง"
  const ALERT_TONE = { low: '#ffb020', medium: '#ff8c1a', high: '#ff3b30' };

  /** แถบเตือนจุดเสี่ยงที่กำลังจะถึงบนเส้นทาง (null = ซ่อน) */
  function showNavHazard(hit) {
    const box = $('#navHazard');
    if (!hit) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }

    /*
     * การ์ดใบเดียวใช้ได้ทั้งรายงานของคนและจุดเสี่ยงจากสถิติ
     * แต่ต้องบอกให้ชัดว่าอันไหนเป็นอันไหน — "มีคนแจ้งว่าเกิดตอนนี้"
     * กับ "ที่นี่เคยเกิดมาแล้ว 12 ครั้ง" เป็นข้อมูลคนละน้ำหนักในการตัดสินใจ
     */
    const isStat = hit.isStat === true;

    /*
     * พาดหัวของการ์ดเตือนต้องบอก "ให้ทำอะไร" ไม่ใช่ "นี่คืออะไร"
     *
     * คนขับมีเวลาชายตามองแค่เสี้ยววินาที "ทางตรง ใช้ความเร็ว" ต้องแปลต่อเองว่า
     * แล้วยังไง ส่วน "ลดความเร็ว" ลงมือได้ทันที ชื่อประเภทย้ายไปอยู่บรรทัดล่าง
     */
    const def = isStat
      ? {
          label: hit.category.action || hit.category.label,
          icon: window.Icons.get(hit.category.icon),
          color: hit.category.color,
        }
      : CFG.HAZARD_TYPES[hit.report.type];
    const sev = isStat
      ? { label: `${hit.category.label} · เคยเกิด ${hit.spot.accidents} ครั้ง` }
      : CFG.SEVERITY[hit.report.severity];

    /*
     * ระยะแยกตัวเลขกับหน่วย เพื่อให้ตัวเลขตัวใหญ่โดดออกมาอ่านได้ด้วยการชายตามอง
     * ใกล้กว่า 30 ม. คือกำลังผ่านจุดนั้นพอดี บอก "อีก 0 ม." จะอ่านแล้วงง
     */
    const near = hit.ahead < 30;
    const [num, unit] = U.formatDistance(hit.ahead).split(' ');

    // แถบวัดความใกล้ ยิ่งเข้าใกล้ยิ่งเต็ม เห็นได้ทันทีว่ากำลังจะถึงแล้ว
    const closeness = Math.round(
      Math.min(100, Math.max(0, (1 - hit.ahead / window.RouteRisk.WARN_AHEAD_M) * 100))
    );

    box.hidden = false;
    box.dataset.severity = hit.report.severity;
    /*
     * สองช่องทางสื่อสาร: สีการ์ดบอก "ด่วนแค่ไหน" สีไอคอนบอก "ภัยชนิดไหน"
     *
     * ไม่ใช้สีประเภทภัยมาทาทั้งการ์ด เพราะบางประเภท (เช่นด่านตรวจ = คราม)
     * สีใกล้เคียงการ์ดบอกทางเลี้ยวที่เป็นม่วง จนแยกไม่ออกว่าเป็นคนละอัน
     * และสีเขียวของระดับ "เฝ้าระวัง" ก็อ่านเป็น "ปลอดภัย" ซึ่งผิดความหมายของการเตือน
     */
    box.style.setProperty('--hazard-color', ALERT_TONE[hit.report.severity]);
    box.style.setProperty('--hazard-type-color', def.color);
    box.innerHTML = `
      <span class="nav-hazard__icon">${def.icon}</span>
      <span class="nav-hazard__text">
        <strong>
          ${escapeHtml(def.label)}
          ${isStat ? '<em class="nav-hazard__tag">สถิติ</em>' : ''}
        </strong>
        <small>
          <span class="nav-hazard__sev">${escapeHtml(sev.label)}</span>
          ${escapeHtml(hit.road)}
        </small>
      </span>
      <span class="nav-hazard__dist">
        ${near ? '<b class="is-here">ตรงนี้</b>' : `<b>${num}</b><i>${unit}</i>`}
      </span>
      <span class="nav-hazard__meter"><i style="width:${closeness}%"></i></span>`;
  }

  /* ---------- แผ่นจุดเสี่ยงบนเส้นทาง (แตะป้ายความปลอดภัยระหว่างนำทาง) ---------- */

  /*
   * ป้ายบนจอบอกได้แค่ "เส้นทางนี้เสี่ยง 48%" ซึ่งตอบไม่ได้ว่าเสี่ยงตรงไหน
   *
   * ข้อมูลนั้นมีอยู่แล้วครบ (RouteRisk จับคู่รายงานเข้ากับเส้นทาง และ Hotspots
   * จับคู่จุดสถิติ) แต่เดิมถูกใช้เฉพาะตอนเตือนทีละจุดตอนใกล้ถึงเท่านั้น
   * แผ่นนี้กางของชุดเดียวกันออกมาให้ดูทั้งเส้นทางเมื่อผู้ใช้อยากรู้เอง
   *
   * ตั้งใจให้เป็น "แตะแล้วดู" ไม่ใช่แสดงค้างไว้ เพราะเป็นข้อมูลสำหรับจังหวะที่
   * ผู้ใช้ตัดสินใจจะดู (ติดไฟแดง / ผู้โดยสารเปิดให้) ไม่ใช่ระหว่างมองถนน
   */

  // เลยจุดไปแล้วเกินเท่านี้ถึงนับว่า "ผ่านแล้ว" — ค่าเดียวกับที่ใช้ตอนเตือน
  // เพราะ GPS คลาดเคลื่อนได้ ถ้าตัดที่ 0 พอดี จุดจะเปลี่ยนสถานะตอนขับผ่านพอดี
  const PASSED_M = -60;

  let riskOpen = false;
  let riskMode = 'route';    // 'route' = ทั้งเส้นทาง · 'focus' = จุดเดียวที่กดมา
  let riskFocus = null;      // จุดที่กำลังดูอยู่ในโหมด focus
  let riskDrawnFor = null;   // analysis ที่วาดรายการไว้แล้ว
  let riskPoints = [];       // พิกัดของแต่ละแถว เอาไว้พาแผนที่ไปดู

  function openRiskSheet() {
    if (!window.Navigate.isActive) return;
    riskOpen = true;
    riskMode = 'route';
    riskFocus = null;
    riskDrawnFor = null;
    $('#riskName').textContent = window.Navigate.destination?.label || 'เส้นทางนี้';
    syncRiskSheet();
    openOverlay('#riskSheet');
  }

  /*
   * กดหมุดบนแผนที่ระหว่างนำทาง = อยากรู้เรื่องจุดนั้นจุดเดียว
   *
   * ใช้แผ่นใบเดียวกับรายการทั้งเส้นทาง เพราะทั้งสองอย่างตอบคำถามเดียวกัน
   * ("ข้างหน้ามีอะไร") คนละความละเอียด การมีแผ่นซ้อนสองใบระหว่างขับ
   * แปลว่าผู้ใช้ต้องจำว่าตัวเองเปิดอันไหนค้างไว้ ซึ่งไม่ควรต้องคิดตอนขับ
   *
   * @param {object} focus {kind:'hotspot', h} หรือ {kind:'report', report}
   */
  function openRiskFocus(focus) {
    if (!window.Navigate.isActive) return;
    riskOpen = true;
    riskMode = 'focus';
    riskFocus = focus;
    riskDrawnFor = null;
    renderRiskFocus();
    openOverlay('#riskSheet');
  }

  /** กดหมุดรายงาน — ระหว่างนำทางไปขึ้นแผ่นจุดเสี่ยง นอกนั้นใช้แผ่นความปลอดภัยเดิม */
  function openReportDetail(id) {
    const report = window.Store.state.reports.find((r) => r.id === id);

    if (window.Navigate.isActive && report) {
      openRiskFocus({ kind: 'report', report });
      return;
    }

    window.Store.select(id);
    // ต้องกางแผ่นก่อนบิน กล้องจะได้เล็งหมุดไว้เหนือแผ่น ไม่ใช่ไปอยู่หลังมัน
    collapseToMap();
    if (report) {
      window.MapView.flyToReport(report, {
        zoom: Math.max(window.MapView.instance.getZoom(), 16.5),
      });
    }
  }

  function closeRiskSheet() {
    if (!riskOpen) return;
    riskOpen = false;
    riskMode = 'route';
    riskFocus = null;
    riskDrawnFor = null;
    riskPoints = [];
    closeOverlay('#riskSheet');
  }

  /*
   * วาดใหม่ทั้งแผ่นเฉพาะตอนเส้นทางเปลี่ยน นอกนั้นขยับแค่ตัวเลขระยะ
   *
   * ตัวนี้ถูกเรียกทุกครั้งที่ GPS ขยับ ถ้าเขียน innerHTML ใหม่ทุกรอบ รายการจะ
   * กระพริบและเด้งกลับไปบนสุดขณะที่ผู้ใช้กำลังไถอ่านอยู่
   */
  function syncRiskSheet() {
    if (!riskOpen) return;

    const a = window.Navigate.analysis;
    if (!a) {
      $('#riskBody').innerHTML = '<p class="place-note">กำลังประเมินเส้นทาง…</p>';
      riskDrawnFor = null;
      return;
    }
    if (riskMode === 'focus') {
      updateFocusDistance();
      return;
    }
    if (a !== riskDrawnFor) {
      riskDrawnFor = a;
      renderRiskSheet(a);
    }
    updateRiskDistances();
  }

  /* ---------- โหมดดูจุดเดียว ---------- */

  /*
   * จุดนี้อยู่ตรงไหนของเส้นทางที่กำลังวิ่ง (เมตรจากต้นทาง) — null ถ้าไม่ได้อยู่บนเส้นทาง
   *
   * คิดใหม่ทุกครั้งแทนที่จะจำไว้ตอนกด เพราะเส้นทางเปลี่ยนได้ระหว่างที่แผ่นเปิดค้าง
   * (หลุดเส้นทางแล้วคำนวณใหม่) ถ้าจำค่าเก่าไว้ ระยะจะอ้างอิงเส้นทางที่เลิกใช้ไปแล้ว
   */
  function alongOnRoute(focus) {
    const a = window.Navigate.analysis;
    if (!a) return null;

    if (focus.kind === 'hotspot') {
      const hit = window.Hotspots.routeSpotsOrdered().find((x) => x.spot === focus.h);
      return hit ? hit.along : null;
    }
    const p = a.points.find((x) => x.report.id === focus.report.id);
    return p ? p.along : null;
  }

  function updateFocusDistance() {
    const along = alongOnRoute(riskFocus);
    const box = $('#riskDetail');

    if (along == null) {
      box.textContent = 'ไม่ได้อยู่บนเส้นทางที่กำลังนำทาง';
      return;
    }
    const ahead = along - (window.Navigate.progress?.travelled ?? 0);
    box.textContent = ahead < PASSED_M
      ? 'ผ่านจุดนี้มาแล้ว'
      : ahead < 30 ? 'กำลังผ่านจุดนี้' : `อีก ${U.formatDistance(ahead)} ข้างหน้า`;
  }

  /*
   * การ์ดรายงานฉบับย่อสำหรับตอนขับ — ตัด "นำทางไปจุดนี้" ออกเพราะกำลังนำทางอยู่แล้ว
   *
   * แต่เก็บปุ่มยืนยัน/ปฏิเสธไว้ เพราะนี่คือจังหวะที่ผู้ใช้รู้คำตอบจริง ๆ:
   * เขาเพิ่งขับผ่านจุดนั้นมา จึงบอกได้ว่าของที่มีคนแจ้งไว้ยังอยู่ไหม
   */
  function navReportCard(report) {
    const def = CFG.HAZARD_TYPES[report.type];
    const sev = CFG.SEVERITY[report.severity];

    return `
      <div class="detail-card__head" style="--card-color:${def.color}">
        <div class="detail-card__icon">${def.icon}</div>
        <div class="detail-card__headText">
          <strong>${escapeHtml(def.label)}</strong>
          <h3 class="detail-card__road">${escapeHtml(report.road)}</h3>
        </div>
      </div>

      <div class="detail-card__tags">
        <span class="sev sev--${report.severity}">${escapeHtml(sev.label)}</span>
        ${sourceTag(report)}
      </div>

      ${report.note ? `<p class="detail-card__note">${escapeHtml(report.note)}</p>` : ''}

      <dl class="detail-card__stats">
        <div><dt>รัศมีเตือน</dt><dd>${report.radius} ม.</dd></div>
        <div><dt>รายงานเมื่อ</dt><dd>${U.formatAgo(report.createdAt)}</dd></div>
      </dl>

      <div class="detail-card__actions">
        <button class="ghost-btn" data-act="up">ยังอยู่ · ${report.confirms}</button>
        <button class="ghost-btn" data-act="down">หายแล้ว · ${report.denies}</button>
      </div>`;
  }

  function renderRiskFocus() {
    const f = riskFocus;
    const isSpot = f.kind === 'hotspot';

    $('#riskName').textContent = isSpot
      ? (f.h.road || 'จุดเสี่ยงจากสถิติ')
      : CFG.HAZARD_TYPES[f.report.type].label;

    $('#riskBody').innerHTML = `
      ${isSpot ? hotspotCardHtml(f.h) : navReportCard(f.report)}
      <button type="button" class="ghost-btn risk-back" id="riskBack">
        ${window.Icons.get('arrowLeft')} ดูจุดเสี่ยงทั้งหมดบนเส้นทาง
      </button>`;

    $('#riskBack').addEventListener('click', openRiskSheet);

    // โหวตแล้วตัวเลขต้องขยับให้เห็น จึงวาดการ์ดใบเดิมซ้ำหลังกด
    $$('#riskBody [data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.Store.vote(f.report.id, btn.dataset.act === 'up' ? 'up' : 'down');
        renderRiskFocus();
      });
    });

    updateFocusDistance();
  }

  /*
   * รวมจุดเสี่ยงสองแหล่งเป็นรายการเดียว เรียงตามลำดับที่จะวิ่งผ่าน
   *
   * คนขับอ่านเส้นทางเป็นลำดับเวลา ไม่ใช่เป็นหมวดหมู่ การแยกเป็นสองรายการ
   * ("รายงาน" กับ "สถิติ") จะบังคับให้เขาไล่สลับสองฝั่งเพื่อรู้ว่าจุดถัดไปคืออะไร
   * จึงรวมเป็นเส้นเดียวแล้วติดป้ายกำกับที่มาไว้ที่แต่ละแถวแทน
   */
  function riskItems(analysis) {
    const out = [];

    for (const p of analysis.points) {
      const def = CFG.HAZARD_TYPES[p.report.type];
      out.push({
        along: p.along,
        lng: p.report.lng,
        lat: p.report.lat,
        color: def.color,
        icon: def.icon,
        title: def.label,
        sub: `${CFG.SEVERITY[p.report.severity].label} · ${p.road}`,
        tag: 'รายงาน',
      });
    }

    for (const s of window.Hotspots.routeSpotsOrdered()) {
      const cat = window.Hotspots.classify(s.spot);
      out.push({
        along: s.along,
        lng: s.spot.lon,
        lat: s.spot.lat,
        color: cat.color,
        icon: window.Icons.get(cat.icon),
        // พาดหัวบอกสิ่งที่ต้องทำก่อน ด้วยเหตุผลเดียวกับการ์ดเตือนระหว่างขับ
        title: cat.action || cat.label,
        sub: `เคยเกิด ${s.spot.accidents} ครั้ง · ${s.spot.road || s.spot.province}`,
        tag: 'สถิติ',
      });
    }

    out.sort((x, y) => x.along - y.along);
    return out;
  }

  function renderRiskSheet(a) {
    const blend = tripBlend(a);
    riskPoints = riskItems(a);

    const rows = riskPoints.map((it, i) => `
      <li class="risk-item" data-i="${i}" data-along="${Math.round(it.along)}"
          style="--item-color:${it.color}">
        <span class="risk-item__icon">${it.icon}</span>
        <span class="risk-item__text">
          <strong>${escapeHtml(it.title)}<em class="risk-item__tag">${escapeHtml(it.tag)}</em></strong>
          <small>${escapeHtml(it.sub)}</small>
        </span>
        <span class="risk-item__dist"></span>
      </li>`).join('');

    const roads = a.roads.slice(0, 5).map((r) => `
      <li class="trip-road" style="--road-color:${r.level.color}">
        <span class="trip-road__bar"><i style="height:${Math.max(r.score, 6)}%"></i></span>
        <span class="trip-road__text">
          <strong>${escapeHtml(r.road)}</strong>
          <small>${r.count} จุด${r.accidents ? ` · อุบัติเหตุ ${r.accidents}` : ''}</small>
        </span>
        <span class="trip-road__score">${r.score}<small>%</small></span>
      </li>`).join('');

    $('#riskBody').innerHTML = `
      <div class="trip-risk" data-level="${blend.levelKey}" style="--risk-color:${blend.color}">
        <span class="trip-risk__icon">${window.Icons.get('shield')}</span>
        <span class="trip-risk__text">
          <strong>เส้นทางนี้ ${escapeHtml(blend.levelLabel)}</strong>
          <small>${
            riskPoints.length
              ? `${riskPoints.length} จุดเสี่ยงบนเส้นทางที่จะวิ่งผ่าน`
              : 'ไม่พบจุดเสี่ยงบนเส้นทางที่จะวิ่งผ่าน'
          }</small>
        </span>
        <span class="trip-risk__score">${blend.score}<small>%</small></span>
      </div>

      ${blend.note}

      ${rows ? `
        <h4 class="trip-subhead">จุดเสี่ยงเรียงตามลำดับที่จะผ่าน</h4>
        <p class="risk-passed" id="riskPassed" hidden></p>
        <ul class="risk-list">${rows}</ul>` : ''}

      ${roads ? `
        <h4 class="trip-subhead">ความเสี่ยงรายถนนบนเส้นทาง</h4>
        <ul class="trip-roads">${roads}</ul>` : ''}

      <p class="trip-note">${escapeHtml(a.vehicle.note)} · นับจุดที่อยู่ห่างเส้นทางไม่เกิน ${a.corridor} ม.</p>`;

    // แตะแถวไหน แผนที่พาไปดูจุดนั้น แล้วปิดแผ่นเพื่อให้เห็นถนนจริง
    $$('#riskBody .risk-item').forEach((row) => {
      row.addEventListener('click', () => {
        const it = riskPoints[Number(row.dataset.i)];
        if (!it) return;
        /*
         * ปลดล็อกกล้องก่อน ไม่งั้นตำแหน่ง GPS ครั้งถัดไปจะลากกล้องกลับมาที่ลูกศร
         * ภายในเสี้ยววินาที ผู้ใช้จะเห็นแค่แผนที่กระตุกแล้วเด้งกลับ
         * ปุ่ม "กลับไปตำแหน่งฉัน" จะโผล่ขึ้นมาเองให้กดกลับได้
         */
        window.Store.setFollowing(false);
        window.MapView.flyToReport(it, { zoom: 16.5 });
        closeRiskSheet();
      });
    });
  }

  /* ขยับเฉพาะตัวเลขระยะกับสถานะ "ผ่านแล้ว" ตามความคืบหน้าล่าสุด */
  function updateRiskDistances() {
    const p = window.Navigate.progress;
    const a = window.Navigate.analysis;
    const travelled = p?.travelled ?? 0;
    let passed = 0;

    // บรรทัดหัวแผ่นต้องเดินตามรถด้วย ไม่ใช่ค้างค่าตอนที่กดเปิดแผ่น
    $('#riskDetail').textContent =
      `${a.vehicle.label} · เหลืออีก ${U.formatDistance(p?.remaining ?? a.distance)}`;

    for (const row of $$('#riskBody .risk-item')) {
      const ahead = Number(row.dataset.along) - travelled;
      const dist = row.querySelector('.risk-item__dist');

      if (ahead < PASSED_M) {
        passed++;
        row.classList.add('is-passed');
        dist.textContent = 'ผ่านแล้ว';
        continue;
      }
      row.classList.remove('is-passed');
      // ใกล้กว่านี้คือกำลังผ่านจุดนั้นพอดี บอก "อีก 0 ม." แล้วอ่านแล้วงง
      row.classList.toggle('is-here', ahead < 30);
      dist.textContent = ahead < 30 ? 'ตรงนี้' : `อีก ${U.formatDistance(ahead)}`;
    }

    const note = $('#riskPassed');
    if (note) {
      note.hidden = passed === 0;
      note.textContent = `ผ่านมาแล้ว ${passed} จุด`;
    }
  }

  function formatDuration(seconds) {
    const mins = Math.max(1, Math.round(seconds / 60));
    if (mins < 60) return `${mins} นาที`;
    return `${Math.floor(mins / 60)} ชม. ${mins % 60} น.`;
  }

  /* ---------- แถบแจ้งเตือน + toast ---------- */

  function showAlert({ message, def, report, distance }) {
    const banner = $('#alertBanner');
    banner.hidden = false;
    banner.dataset.severity = report.severity;
    banner.style.setProperty('--alert-color', def.color);
    // def.icon เป็นมาร์กอัป SVG แล้ว ถ้าใช้ textContent จะโชว์เป็นโค้ดดิบบนหน้าจอ
    $('#alertIcon').innerHTML = def.icon;
    $('#alertTitle').textContent = message;
    $('#alertMeta').textContent = `${report.road}${report.note ? ' · ' + report.note : ''}`;
    banner.classList.remove('is-in');
    void banner.offsetWidth; // เริ่มแอนิเมชันใหม่
    banner.classList.add('is-in');

    clearTimeout(alertTimer);
    alertTimer = setTimeout(hideAlert, 9000);
  }

  function hideAlert() {
    const banner = $('#alertBanner');
    banner.classList.remove('is-in');
    banner.hidden = true;
  }

  function toast(text, kind = 'info') {
    const box = $('#toasts');
    const node = el('div', `toast toast--${kind}`, text);
    box.appendChild(node);
    requestAnimationFrame(() => node.classList.add('is-in'));
    setTimeout(() => {
      node.classList.remove('is-in');
      setTimeout(() => node.remove(), 300);
    }, 4200);
  }

  /* ---------- ฟอร์มแจ้งเหตุ ---------- */

  function renderTypeGrid() {
    const grid = $('#typeGrid');
    grid.innerHTML = '';
    for (const [key, def] of Object.entries(CFG.HAZARD_TYPES)) {
      const btn = el('button', 'type-card');
      btn.type = 'button';
      btn.dataset.type = key;
      btn.style.setProperty('--type-color', def.color);
      btn.innerHTML = `<span class="type-card__icon">${def.icon}</span><span>${escapeHtml(def.label)}</span>`;
      btn.classList.toggle('is-active', key === formType);
      btn.addEventListener('click', () => {
        formType = key;
        formSeverity = def.defaultSeverity;
        $$('#typeGrid .type-card').forEach((b) => b.classList.toggle('is-active', b.dataset.type === key));
        syncSeverity();
      });
      grid.appendChild(btn);
    }
  }

  function syncSeverity() {
    $$('#severityGroup button').forEach((b) =>
      b.classList.toggle('is-active', b.dataset.severity === formSeverity)
    );
  }

  function openReportSheet() {
    pendingLocation = null;
    updateLocationText();
    renderTypeGrid();
    syncSeverity();
    $('#reportSheet').hidden = false;
    requestAnimationFrame(() => $('#reportSheet').classList.add('is-open'));
    fillRoadFromLocation();
  }

  /** เติมชื่อถนนให้อัตโนมัติ คนที่กำลังขับจะได้ไม่ต้องพิมพ์เอง */
  let roadLookupId = 0;
  async function fillRoadFromLocation() {
    const input = $('#roadInput');
    if (input.value.trim()) return; // ผู้ใช้พิมพ์เองแล้ว อย่าไปทับ

    const id = ++roadLookupId;
    const [lng, lat] = resolveLocation();
    input.placeholder = 'กำลังหาชื่อถนน…';
    try {
      const road = await window.Geocode.reverse(lng, lat);
      if (id !== roadLookupId) return;
      if (road && !input.value.trim()) input.value = road;
    } catch (_) {
      /* หาไม่เจอก็ปล่อยให้พิมพ์เอง */
    } finally {
      if (id === roadLookupId) input.placeholder = 'เช่น ถนนพระราม 4 ใกล้แยกคลองเตย';
    }
  }

  function closeReportSheet() {
    const sheet = $('#reportSheet');
    sheet.classList.remove('is-open');
    window.MapView.setPickMode(false);
    setTimeout(() => { sheet.hidden = true; }, 200);
  }

  function updateLocationText() {
    const text = $('#locationText');
    if (pendingLocation) {
      text.textContent = `${pendingLocation[1].toFixed(5)}, ${pendingLocation[0].toFixed(5)}`;
    } else if (window.Store.state.userPosition) {
      text.textContent = 'ตำแหน่งปัจจุบันของคุณ';
    } else {
      text.textContent = 'กลางจอแผนที่';
    }
  }

  function resolveLocation() {
    if (pendingLocation) return pendingLocation;
    if (window.Store.state.userPosition) return window.Store.state.userPosition;
    const c = window.MapView.instance.getCenter();
    return [c.lng, c.lat];
  }

  function submitReport(e) {
    e.preventDefault();
    const [lng, lat] = resolveLocation();
    const report = window.Store.addReport({
      type: formType,
      severity: formSeverity,
      lng,
      lat,
      road: $('#roadInput').value.trim(),
      note: $('#noteInput').value.trim(),
    });
    $('#roadInput').value = '';
    $('#noteInput').value = '';
    closeReportSheet();
    window.Store.select(report.id);
    window.MapView.flyToReport(report);
    toast('ส่งรายงานแล้ว ขอบคุณที่ช่วยเตือนเพื่อนร่วมถนน 🙏', 'success');
  }

  /* ---------- ตั้งค่า ---------- */

  function syncSettings() {
    $('#setTrack').checked = window.Alerts.isTracking;
    $('#setSound').checked = window.Alerts.settings.sound;
    $('#setVoice').checked = window.Alerts.settings.voice;
    $('#setVibrate').checked = window.Alerts.settings.vibrate;
    $('#setSim').checked = window.Store.state.simulating;
    $('#setRealMap').checked = window.MapView.getStyleMode() !== 'plain';

    /*
     * เสียงไทยไม่ได้มีทุกเครื่อง — Windows ต้องลงชุดภาษาไทยก่อน
     * ถ้าไม่บอก ผู้ใช้จะเปิดสวิตช์แล้วไม่ได้ยินอะไร โดยไม่รู้ว่าเป็นที่เครื่องตัวเอง
     */
    const warn = $('#voiceWarn');
    const status = window.Alerts.thaiVoiceStatus();
    if (!window.Alerts.settings.voice || status !== false) {
      warn.hidden = true;
    } else {
      warn.hidden = false;
      warn.textContent =
        'เครื่องนี้ยังไม่มีเสียงภาษาไทยติดตั้งอยู่ ระบบจะเตือนด้วยเสียงและการสั่นแทน — '
        + 'บน Windows เพิ่มได้ที่ ตั้งค่า → เวลาและภาษา → ภาษา แล้วติดตั้งแพ็กเสียงภาษาไทย';
    }
  }

  /* ---------- แท็บล่าง ---------- */

  const VIEWS = ['map', 'dashboard', 'settings'];
  let currentView = 'map';

  function setView(name) {
    // "แจ้งเหตุ" ไม่ใช่หน้า แต่เป็นแผ่นซ้อน — เปิดแล้วคงแท็บเดิมไว้
    if (name === 'report') {
      openReportSheet();
      syncTabs();
      return;
    }

    currentView = name;
    $('#viewDashboard').hidden = name !== 'dashboard';
    $('#viewSettings').hidden = name !== 'settings';
    // แผนที่กับแผ่นรายการเป็นของแท็บ "แผนที่"
    $('#phone').classList.toggle('is-map-view', name === 'map');

    if (name === 'dashboard') renderDashboard();
    if (name === 'settings') syncSettings();
    syncTabs();
  }

  function syncTabs() {
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === currentView));
  }

  /* ---------- แดชบอร์ด ---------- */

  function renderDashboard() {
    const risk = window.Store.riskAssessment(origin());

    renderImpact();
    renderDashNow(risk);
    renderFactors(risk);
    renderEvents();
    // คำอธิบายสัญลักษณ์ของจุดเสี่ยงจากสถิติ อยู่ที่หน้านี้แล้ว ไม่ใช่แผ่นรายการ
    window.Hotspots.renderLegend();
  }

  /* ---------- ผลลัพธ์ที่แอปสร้าง: อุบัติเหตุลดลงกี่ % ---------- */

  /**
   * ตัวเลขพาดหัว + กราฟเส้น 6 เดือน
   *
   * เป็นซีรีส์เดียว จึงไม่ต้องมีคำอธิบายสี (legend) — ติดป้ายเฉพาะจุดสุดท้าย
   * ที่เป็นค่าปัจจุบัน ส่วนที่เหลือให้แกนกับการแตะบนกราฟเป็นตัวบอก
   */
  function renderImpact() {
    const s = window.Impact.summary(6);
    const c = window.Impact.contribution();
    const box = $('#impactPanel');

    box.innerHTML = `
      <div class="impact__hero">
        <span class="impact__icon">${window.Icons.get('trendDown')}</span>
        <div class="impact__figure">
          <strong>${s.reductionPct}<small>%</small></strong>
          <span>อุบัติเหตุลดลงใน ${s.months} เดือน</span>
        </div>
      </div>

      ${impactChart(s)}

      <div class="impact__foot">
        <div><span>ก่อนใช้แอป</span><strong>${s.baseline}</strong></div>
        <div><span>เดือนล่าสุด</span><strong>${s.current}</strong></div>
        <div><span>เทียบเดือนก่อน</span><strong>−${s.monthOverMonthPct}%</strong></div>
      </div>
      <p class="impact__note">
        หน่วย: อุบัติเหตุต่อ 1,000 เที่ยวเดินทาง · ชุดตัวเลขรายเดือนเป็นข้อมูลสาธิต
        เพราะต้นแบบนี้ยังไม่มีสถิติย้อนหลังจริง (คุณช่วยรายงานแล้ว ${c.mine} จุด
        จากทั้งหมด ${c.reports} จุดในเครื่องนี้)
      </p>`;
  }

  /**
   * กราฟพื้นที่ + เส้น วาดเป็น SVG ตรง ๆ ไม่ต้องพึ่งไลบรารีกราฟ
   * เส้นตารางเป็นเส้นบางสีจาง ไม่ใช่เส้นประ เพื่อให้ถอยไปอยู่หลังข้อมูล
   */
  function impactChart(s) {
    const W = 300;
    const H = 120;
    // เว้นขอบซ้าย-ขวาให้ป้ายชื่อเดือนของจุดหัว-ท้ายมีที่ยืน ไม่ล้นออกนอกกรอบ
    const padX = 16;
    const padTop = 12;
    const padBottom = 26;

    const values = s.data.map((d) => d.value);
    const max = Math.max(...values) * 1.12;
    const min = 0;

    const x = (i) => padX + (i * (W - padX * 2)) / (s.data.length - 1);
    const y = (v) => padTop + (1 - (v - min) / (max - min)) * (H - padTop - padBottom);

    const line = s.data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join('');
    const area = `${line}L${x(s.data.length - 1).toFixed(1)},${H - padBottom}L${padX},${H - padBottom}Z`;

    // เส้นตารางแนวนอน 3 เส้น พอให้กะระดับได้ ไม่ถี่จนบังข้อมูล
    const grid = [0.25, 0.5, 0.75]
      .map((f) => {
        const gy = (padTop + f * (H - padTop - padBottom)).toFixed(1);
        return `<line class="ic__grid" x1="${padX}" y1="${gy}" x2="${W - padX}" y2="${gy}" />`;
      })
      .join('');

    const dots = s.data
      .map((d, i) => {
        const last = i === s.data.length - 1;
        return `<circle class="ic__dot${last ? ' ic__dot--last' : ''}" cx="${x(i).toFixed(1)}"
                  cy="${y(d.value).toFixed(1)}" r="${last ? 4.5 : 3}"><title>${escapeHtml(d.label)} · ${d.value}</title></circle>`;
      })
      .join('');

    const labels = s.data
      .map((d, i) => `<text class="ic__tick" x="${x(i).toFixed(1)}" y="${H - 8}">${escapeHtml(d.label)}</text>`)
      .join('');

    const lastIdx = s.data.length - 1;
    const lastVal = s.data[lastIdx].value;

    return `
      <svg class="impact-chart" viewBox="0 0 ${W} ${H}" role="img"
           aria-label="กราฟอุบัติเหตุต่อ 1,000 เที่ยวเดินทาง ${s.months} เดือนล่าสุด ลดลงจาก ${s.data[0].value} เหลือ ${lastVal}">
        <defs>
          <linearGradient id="icFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--ok)" stop-opacity="0.28" />
            <stop offset="100%" stop-color="var(--ok)" stop-opacity="0" />
          </linearGradient>
        </defs>
        ${grid}
        <path class="ic__area" d="${area}" />
        <path class="ic__line" d="${line}" />
        ${dots}
        <text class="ic__value" x="${x(lastIdx).toFixed(1)}" y="${(y(lastVal) - 10).toFixed(1)}">${lastVal}</text>
        ${labels}
      </svg>`;
  }

  /** สรุปความปลอดภัยรอบตัวตอนนี้ — ย้ายมาจากเกจวงกลมเดิม ให้อ่านเป็นบรรทัดเดียว */
  function renderDashNow(risk) {
    const safety = 100 - risk.score;
    const box = $('#dashNow');

    box.style.setProperty('--risk-color', risk.level.color);
    box.innerHTML = `
      <div class="dash-now__head">
        <span class="dash-now__level">${escapeHtml(risk.level.label)}</span>
        <span class="dash-now__score">${safety}<small>%</small></span>
      </div>
      <div class="risk__meter">
        <div class="risk__bar" style="width:${Math.max(safety, 2)}%"></div>
      </div>
      <p class="dash-now__sub">
        ${risk.count} จุดในรัศมี ${risk.radius / 1000} กม.
        ${risk.high ? ` · ${risk.high} จุดอันตราย` : ''}
        · ${window.Store.state.userPosition ? 'รอบตำแหน่งคุณ' : 'รอบกลางจอแผนที่'}
      </p>
      <p class="dash-now__advice">${escapeHtml(risk.level.advice)}</p>`;
  }

  /**
   * ปัจจัยเสี่ยงคำนวณจากข้อมูลที่มีจริงในแอปเท่านั้น
   * (ไม่ได้ต่อบริการพยากรณ์อากาศหรือสภาพจราจรจากภายนอก)
   */
  function renderFactors(risk) {
    const box = $('#riskFactors');
    const reports = window.Store.visibleReports();

    const hour = new Date().getHours();
    const rush = (hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 19);
    const night = hour >= 20 || hour <= 5;

    const traffic = reports.filter((r) => r.type === 'traffic').length;
    const flood = reports.filter((r) => r.type === 'flood').length;

    const factors = [
      {
        icon: 'construction',
        label: 'ความหนาแน่นของเหตุ',
        detail: `${risk.count} จุดในรัศมี ${risk.radius / 1000} กม.`,
        level: risk.count >= 8 ? 'high' : risk.count >= 4 ? 'medium' : 'low',
      },
      {
        icon: 'traffic',
        label: 'สภาพจราจร',
        detail: traffic ? `มีรายงานรถติด ${traffic} จุด` : 'ไม่มีรายงานรถติด',
        level: traffic >= 2 ? 'high' : traffic ? 'medium' : 'low',
      },
      {
        icon: 'flood',
        label: 'น้ำท่วมขัง',
        detail: flood ? `มีรายงานน้ำท่วม ${flood} จุด` : 'ไม่มีรายงานน้ำท่วม',
        level: flood >= 2 ? 'high' : flood ? 'medium' : 'low',
      },
      {
        icon: 'clock',
        label: 'ช่วงเวลา',
        detail: rush ? 'ชั่วโมงเร่งด่วน' : night ? 'กลางคืน ทัศนวิสัยลดลง' : 'นอกชั่วโมงเร่งด่วน',
        level: rush ? 'high' : night ? 'medium' : 'low',
      },
    ];

    const LEVEL = {
      low: { text: 'ต่ำ', color: 'var(--ok)', width: 28 },
      medium: { text: 'ปานกลาง', color: 'var(--warn)', width: 62 },
      high: { text: 'สูง', color: 'var(--danger)', width: 92 },
    };

    box.innerHTML = factors
      .map((f) => {
        const l = LEVEL[f.level];
        return `
          <div class="factor">
            <span class="factor__icon">${window.Icons.get(f.icon)}</span>
            <div class="factor__body">
              <div class="factor__top">
                <strong>${escapeHtml(f.label)}</strong>
                <span class="factor__level" style="color:${l.color}">${l.text}</span>
              </div>
              <div class="factor__bar">
                <div style="width:${l.width}%;background:${l.color}"></div>
              </div>
              <span class="factor__detail">${escapeHtml(f.detail)}</span>
            </div>
          </div>`;
      })
      .join('');
  }

  function renderEvents() {
    const list = $('#dashEvents');
    const items = window.Store.sortedByDistance(origin()).slice(0, 8);
    list.innerHTML = '';

    if (!items.length) {
      // ต้องเป็น template literal ไม่ใช่ single quote ไม่งั้น ${...} จะโผล่เป็นข้อความดิบ
      list.innerHTML = `<li class="empty-state"><div>${window.Icons.get('map')}</div><p>ยังไม่มีรายงานในขณะนี้</p></li>`;
      return;
    }

    for (const item of items) {
      const def = CFG.HAZARD_TYPES[item.type];
      const li = el('li', 'event');
      li.style.setProperty('--item-color', def.color);
      li.innerHTML = `
        <span class="event__icon">${def.icon}</span>
        <div class="event__body">
          <div class="event__top">
            <strong>${escapeHtml(def.label)}</strong>
            <span class="event__ago">${U.formatAgo(item.createdAt)}</span>
          </div>
          <p class="event__text">${escapeHtml(item.note || item.road)}</p>
          <span class="event__meta">ยืนยัน ${item.confirms} · ${U.formatDistance(item.distance || 0)}</span>
        </div>`;
      li.addEventListener('click', () => {
        setView('map');
        window.Store.select(item.id);
        collapseToMap();
        window.MapView.flyToReport(item);
      });
      list.appendChild(li);
    }
  }

  /* ---------- แผ่นซ้อนทั่วไป ---------- */

  function openOverlay(sel) {
    $(sel).hidden = false;
    requestAnimationFrame(() => $(sel).classList.add('is-open'));
  }

  function closeOverlay(sel) {
    const sheet = $(sel);
    sheet.classList.remove('is-open');
    setTimeout(() => { sheet.hidden = true; }, 200);
  }

  /* ---------- หน้าค้นหาสถานที่ (เต็มจอ) ---------- */

  let searchOpen = false;

  function openSearchView() {
    if (searchOpen) return;
    searchOpen = true;
    const view = $('#viewSearch');
    view.hidden = false;
    // ต้องรอให้เบราว์เซอร์วาดก่อน คลาสเปิดถึงจะทำให้แอนิเมชันเล่น
    requestAnimationFrame(() => {
      view.classList.add('is-open');
      $('#searchInput').focus();
    });
    renderSearchResults(null);
  }

  function closeSearchView() {
    if (!searchOpen) return;
    searchOpen = false;
    const view = $('#viewSearch');
    view.classList.remove('is-open');
    $('#searchInput').blur();
    setTimeout(() => { view.hidden = true; }, 220);
  }

  function clearSearch() {
    $('#searchInput').value = '';
    $('#searchClear').hidden = true;
    window.Store.setSearch('');
    renderSearchResults(null);
  }

  /**
   * วาดผลค้นหา
   * @param {Array|null} places null = ยังไม่ได้ค้น (โชว์หน้าเริ่มต้น)
   * @param {string} [note] ข้อความสถานะแทนรายการ เช่น "กำลังค้นหา…"
   */
  function renderSearchResults(places, note) {
    const box = $('#placeResults');
    box.innerHTML = '';

    // ยังไม่ได้พิมพ์อะไร — เสนอจุดเสี่ยงใกล้ตัวให้กดไปดูได้เลย
    if (places == null && !note) {
      box.appendChild(nearbySuggestions());
      return;
    }

    if (note) {
      box.innerHTML = `<p class="place-note">${escapeHtml(note)}</p>`;
      return;
    }

    // รายงานในเครื่องที่ตรงคำค้น — ตอบได้ทันทีโดยไม่ต้องรอเน็ต
    const matches = window.Store.sortedByDistance(origin());
    if (matches.length) {
      box.appendChild(sectionTitle(`จุดเสี่ยงที่ตรงกับคำค้น · ${matches.length}`));
      for (const item of matches.slice(0, 4)) box.appendChild(hazardResultRow(item));
    }

    box.appendChild(sectionTitle('สถานที่'));
    if (!places.length) {
      box.insertAdjacentHTML('beforeend', '<p class="place-note">ไม่พบสถานที่ที่ตรงกับคำค้น</p>');
      return;
    }
    for (const place of places) box.appendChild(placeRow(place));
  }

  function sectionTitle(text) {
    return el('h3', 'place-section', text);
  }

  /** หน้าเริ่มต้นของช่องค้นหา: จุดเสี่ยงใกล้ตัวที่กดดูได้ทันที */
  function nearbySuggestions() {
    const wrap = el('div');
    const items = window.Store.sortedByDistance(origin()).slice(0, 6);

    if (!items.length) {
      wrap.innerHTML = `<p class="place-note">พิมพ์ชื่อสถานที่ ถนน หรือจุดหมายที่ต้องการไป</p>`;
      return wrap;
    }

    wrap.appendChild(sectionTitle('จุดเสี่ยงใกล้คุณ'));
    for (const item of items) wrap.appendChild(hazardResultRow(item));
    return wrap;
  }

  function hazardResultRow(item) {
    const def = CFG.HAZARD_TYPES[item.type];
    const pct = window.Store.pointRisk(item, item.distance);
    const row = el('button', 'place-row place-row--hazard');
    row.type = 'button';
    row.style.setProperty('--row-color', def.color);
    row.innerHTML = `
      <span class="place-row__pin place-row__pin--hazard" aria-hidden="true">${def.icon}</span>
      <span class="place-row__text">
        <span class="place-row__name">${escapeHtml(item.road)}</span>
        <span class="place-row__detail">${escapeHtml(def.label)}${
          item.distance != null ? ` · ${U.formatDistance(item.distance)}` : ''
        }</span>
      </span>
      <span class="place-row__pct">${pct}%</span>`;

    row.addEventListener('click', () => {
      closeSearchView();
      clearSearch();
      setView('map');
      window.Store.select(item.id);
      window.MapView.flyToReport(item);
      collapseToMap();
    });
    return row;
  }

  function placeRow(place) {
    const row = el('button', 'place-row');
    row.type = 'button';
    row.innerHTML = `
      <span class="place-row__pin" aria-hidden="true">${window.Icons.get('pin')}</span>
      <span class="place-row__text">
        <span class="place-row__name">${escapeHtml(place.name)}</span>
        ${place.detail ? `<span class="place-row__detail">${escapeHtml(place.detail)}</span>` : ''}
      </span>
      <span class="place-row__go" aria-hidden="true">${window.Icons.get('chevronRight')}</span>`;

    // เลือกสถานที่ = เปิดแผ่นสรุปการเดินทาง ให้เลือกพาหนะและดูความเสี่ยงก่อนออกรถ
    row.addEventListener('click', () => {
      closeSearchView();
      openTripSheet(place);
    });
    return row;
  }

  function bindSearch() {
    const input = $('#searchInput');
    let filterTimer = null;
    let placeTimer = null;
    let requestId = 0;

    // แตะช่องค้นหาบนแผนที่ = เปิดหน้าค้นหาเต็มจอ (ไม่ได้พิมพ์ตรงนั้น)
    $('#searchTrigger').addEventListener('click', openSearchView);
    $('#searchBack').addEventListener('click', () => {
      clearSearch();
      closeSearchView();
    });
    $('#searchClear').addEventListener('click', () => {
      clearSearch();
      input.focus();
    });

    input.addEventListener('input', () => {
      const value = input.value;
      $('#searchClear').hidden = !value;

      // กรองรายงานในเครื่องทันที (เร็ว ไม่ต้องยิงเน็ต)
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        window.Store.setSearch(value);
        // คำสั้นกว่า 2 ตัวจะไม่ยิงค้นสถานที่ จึงต้องวาดหน้าเริ่มต้นกลับมาเอง
        if (searchOpen && value.trim().length < 2) renderSearchResults(null);
      }, 180);

      // ค้นสถานที่จริงต้องยิงเน็ต จึงหน่วงนานกว่าและเลิกถ้าคำสั้นเกินไป
      clearTimeout(placeTimer);
      if (value.trim().length < 2) return;
      placeTimer = setTimeout(() => lookupPlaces(value), 650);
    });

    async function lookupPlaces(value) {
      const id = ++requestId;
      renderSearchResults(null, 'กำลังค้นหาสถานที่…');
      try {
        const places = await window.Geocode.search(value, origin());
        if (id !== requestId || input.value.trim() !== value.trim()) return;
        renderSearchResults(places);
      } catch (_) {
        if (id !== requestId) return;
        // ออฟไลน์หรือ Nominatim ล่ม — ยังกรองรายงานในเครื่องได้ตามปกติ
        renderSearchResults(null, 'ค้นหาสถานที่ไม่สำเร็จ — ลองใหม่อีกครั้ง');
      }
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        clearSearch();
        closeSearchView();
      }
    });
  }

  /* ---------- แผ่นสรุปการเดินทาง (เลือกพาหนะ + ความเสี่ยงรายถนน) ---------- */

  let tripPlace = null;     // จุดหมายที่กำลังดูอยู่
  let tripRoutes = [];      // เส้นทางทั้งหมดที่ OSRM ให้มา (ตัวแรก = เร็วที่สุด)
  let tripPick = 0;         // ผู้ใช้เลือกเส้นไหนอยู่
  // เส้นที่ฉากสาธิตวางของไว้ — ต้องเป็นเส้นเดียวกับที่แผ่นทริปเลือกให้ตั้งแต่แรก
  let demoRouteIndex = 0;
  // เส้นที่ตั้งใจให้มีแต่จุดจากโมเดล ไม่มีรายงานของคนเลย (null = ไม่มีเส้นแบบนั้น)
  let demoStatOnlyIndex = null;
  let tripVehicle = 'car';
  let tripSimulate = false; // เปิดมาจากโหมดจำลอง = กดเริ่มแล้วให้ขับให้ดูเลย

  const tripRoute = () => tripRoutes[tripPick] || null;

  /**
   * @param {object} [opts.routes] เส้นทางที่คำนวณมาแล้ว (ฉากสาธิตส่งมาเอง)
   * @param {boolean} [opts.simulate] กดเริ่มนำทางแล้วให้เริ่มขับจำลองด้วย
   */
  async function openTripSheet(place, opts = {}) {
    tripPlace = place;
    tripRoutes = [];
    // ฉากสาธิตวางของไว้บนเส้นหนึ่งโดยเฉพาะ จึงต้องเปิดมาที่เส้นนั้น
    tripPick = opts.pick || 0;
    tripSimulate = !!opts.simulate;

    $('#tripName').textContent = place.name;
    $('#tripDetail').textContent = place.detail || '';
    $('#tripStart').textContent = tripSimulate ? 'เริ่มขับจำลอง' : 'เริ่มนำทาง';
    $('#tripStart').disabled = true;
    renderVehiclePicker();
    $('#tripBody').innerHTML = '<p class="place-note">กำลังคำนวณเส้นทางและประเมินความเสี่ยง…</p>';
    openOverlay('#tripSheet');

    try {
      // ขอเส้นทางสำรองมาด้วย เพื่อเทียบว่ามีเส้นที่ปลอดภัยกว่าไหม
      const routes = opts.routes
        || (await window.Route.getRoutes(origin(), [place.lng, place.lat]));
      if (tripPlace !== place) return; // ผู้ใช้เปลี่ยนจุดหมายระหว่างรอ
      tripRoutes = routes;
      $('#tripStart').disabled = false;
      renderTripBody();
    } catch (err) {
      $('#tripBody').innerHTML = `<p class="place-note">${escapeHtml(err.message || 'หาเส้นทางไม่สำเร็จ')}</p>`;
    }
  }

  function closeTripSheet() {
    // ปิดแผ่นฉากสาธิตทิ้งโดยไม่กดเริ่ม = ยกเลิกฉาก เก็บจุดสาธิตออกให้เรียบร้อย
    if (tripSimulate) {
      window.Store.clearDemoReports();
      syncSettings();
    }
    tripPlace = null;
    tripRoutes = [];
    tripPick = 0;
    tripSimulate = false;
    closeOverlay('#tripSheet');
  }

  function renderVehiclePicker() {
    const box = $('#vehiclePicker');
    box.innerHTML = '';
    for (const v of Object.values(window.RouteRisk.VEHICLES)) {
      const btn = el('button', 'vehicle-card');
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(v.key === tripVehicle));
      btn.classList.toggle('is-active', v.key === tripVehicle);
      btn.innerHTML = `
        <span class="vehicle-card__icon">${window.Icons.get(v.icon)}</span>
        <span class="vehicle-card__label">${escapeHtml(v.label)}</span>`;
      btn.addEventListener('click', () => {
        tripVehicle = v.key;
        renderVehiclePicker();
        if (tripRoute()) renderTripBody();
      });
      box.appendChild(btn);
    }
  }

  /*
   * รวมคะแนนของโมเดลพยากรณ์เข้ากับคะแนนเส้นทาง
   *
   * คะแนนของ RouteRisk มาจากรายงานผู้ใช้บนถนนเส้นนั้น ส่วนโมเดลบอกว่า "วันนี้"
   * เป็นวันแบบไหนสำหรับจังหวัดนี้ (ฝน วันหยุดยาว สงกรานต์) สองอย่างนี้คนละแกนกัน
   * จึงเอามารวมได้ โดยให้โมเดลถ่วงน้ำหนักแค่ 30% — ดู AIForecast.blendRouteScore()
   *
   * ถ้าโมเดลยังโหลดไม่เสร็จหรือใช้ไม่ได้ ทุกอย่างกลับไปเป็นคะแนนเดิมเป๊ะ ๆ
   */
  /*
   * จุดที่โมเดลชี้ต้องมีน้ำหนักในคะแนนเส้นทางด้วย
   *
   * RouteRisk นับเฉพาะรายงานของคน เส้นทางที่ไม่มีใครแจ้งอะไรเลยจึงได้ 2%
   * แล้วขึ้นว่า "ปลอดภัย" ทั้งที่วิ่งผ่านจุดที่เคยเกิดอุบัติเหตุมาแล้ว 21 ครั้ง
   * ซึ่งเป็นการบอกผู้ใช้ผิดในทางที่อันตราย — บอกว่าปลอดภัยแล้วเขาไม่ระวัง
   *
   * ถ่วงน้ำหนักด้วยความรุนแรง (ตาย×10 + เจ็บ) ไม่ใช่จำนวนจุด เพราะจุดที่
   * เกิดบ่อยแต่เจ็บเล็กน้อยไม่ควรดันคะแนนเท่าจุดที่ชนทีไรถึงตาย
   */
  function statRouteScore(baseScore) {
    const spots = window.Hotspots.routeHotspots();
    if (!spots.length) return baseScore;

    const weight = spots.reduce((sum, h) => sum + Math.min(1, h.severity / 60), 0);
    // เส้นโค้งอิ่มตัว: 1 จุดหนัก ≈ +23 แต้ม, 4 จุด ≈ +55 แต้ม, ไม่พุ่งชน 100 ง่าย ๆ
    const add = 100 * (1 - Math.exp(-weight / 4));
    const scored = Math.round(Math.min(100, baseScore + (100 - baseScore) * (add / 100)));

    /*
     * พื้นขั้นต่ำ: มีจุดสถิติบนเส้นทางแล้วห้ามขึ้นว่า "ปลอดภัย"
     *
     * จุดที่เบาที่สุดในชุดนี้ก็ยังหมายถึงมีคนเจ็บจากอุบัติเหตุซ้ำ ๆ ที่เดิม
     * อย่างน้อย 4 ครั้ง การบอกว่าเส้นทางปลอดภัยแล้วผู้ใช้เลิกระวังเป็นความผิด
     * ที่แพงกว่าการเตือนเกินไปหน่อย — 20 คือเกณฑ์ต่ำสุดของระดับ "ต้องระวัง"
     */
    return Math.max(scored, 20);
  }

  /*
   * ตัดปลายคะแนนเส้นทางไว้ที่ 5-95 ด้วยเหตุผลเดียวกับคะแนนรอบตัว
   * — มันคือการคาดการณ์ ไม่ใช่ความจริงที่วัดได้ จึงไม่ควรอ่านเป็น 0% หรือ 100%
   */
  const clampScore = (n) => Math.min(95, Math.max(5, n));

  function tripBlend(analysis) {
    const forecast = window.AIUI?.currentForecast?.() || null;
    const withStats = statRouteScore(analysis.score);
    const blended = window.AIForecast.blendRouteScore(withStats, forecast);

    if (!blended.adjusted && withStats === analysis.score) {
      return {
        score: clampScore(analysis.score),
        levelKey: analysis.level.key,
        levelLabel: analysis.level.label,
        color: analysis.level.color,
        note: '',
      };
    }

    const level = window.RouteRisk.levelFor(blended.score);

    // มีแต่จุดสถิติ ไม่มีผลจากพยากรณ์รายวัน — อธิบายเท่าที่มีจริง
    if (!blended.adjusted) {
      const spots = window.Hotspots.routeHotspots();
      return {
        score: clampScore(blended.score),
        levelKey: level.key,
        levelLabel: level.label,
        color: level.color,
        note: `
          <p class="trip-ai" style="--ai-color:var(--accent-2)">
            <strong>${spots.length} จุดเสี่ยงจากสถิติบนเส้นทางนี้</strong>
            เคยเกิดอุบัติเหตุรวม ${spots.reduce((n, h) => n + h.accidents, 0)} ครั้ง
            จึงเพิ่มคะแนนเสี่ยงไป ${blended.score - analysis.score} จุด
            (จาก ${analysis.score}%)
          </p>`,
      };
    }
    const reason = forecast.reasons[0];
    const direction = blended.delta > 0 ? 'เพิ่ม' : 'ลด';

    return {
      score: clampScore(blended.score),
      levelKey: level.key,
      levelLabel: level.label,
      color: level.color,
      note: `
        <p class="trip-ai" style="--ai-color:${forecast.level.color}">
          <strong>${escapeHtml(forecast.province)}วันนี้${escapeHtml(forecast.level.label)}</strong>
          คาดว่าทั้งจังหวัดจะเกิด ${forecast.expectedCount.toFixed(1)} ครั้ง
          จึง${direction}คะแนนเสี่ยงของเส้นทางไป ${Math.abs(blended.delta)} จุด
          (จาก ${blended.original}%)
          ${reason ? `<br><small>${escapeHtml(reason.text)}</small>` : ''}
        </p>`,
    };
  }

  /** เวลา ระยะทาง ความเสี่ยงรวม และรายชื่อถนนเสี่ยงบนเส้นทางที่เลือก */
  function renderTripBody() {
    const all = tripRoutes.map((r) => window.RouteRisk.analyze(r, tripVehicle));
    const verdict = window.RouteRisk.compare(all);
    const a = all[tripPick];

    const eta = new Date(Date.now() + a.duration * 1000)
      .toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

    const blend = tripBlend(a);

    const roads = a.roads.slice(0, 5).map((r) => `
      <li class="trip-road" style="--road-color:${r.level.color}">
        <span class="trip-road__bar"><i style="height:${Math.max(r.score, 6)}%"></i></span>
        <span class="trip-road__text">
          <strong>${escapeHtml(r.road)}</strong>
          <small>${r.count} จุด${r.accidents ? ` · อุบัติเหตุ ${r.accidents}` : ''}</small>
        </span>
        <span class="trip-road__score">${r.score}<small>%</small></span>
      </li>`).join('');

    $('#tripBody').innerHTML = `
      ${renderRouteChoices(all, verdict)}

      <div class="trip-stats">
        <div><span>เวลาเดินทาง</span><strong>${formatDuration(a.duration)}</strong></div>
        <div><span>ระยะทาง</span><strong>${U.formatDistance(a.distance)}</strong></div>
        <div><span>ถึงเวลา</span><strong>${eta}</strong></div>
      </div>

      <div class="trip-risk" data-level="${blend.levelKey}" style="--risk-color:${blend.color}">
        <span class="trip-risk__icon">${window.Icons.get('shield')}</span>
        <span class="trip-risk__text">
          <strong>เส้นทางนี้ ${escapeHtml(blend.levelLabel)}</strong>
          <small>${
            a.points.length
              ? `พบ ${a.points.length} จุดเสี่ยงบนถนนที่จะวิ่งผ่าน${a.accidents ? ` (อุบัติเหตุ ${a.accidents})` : ''}`
              : 'ยังไม่มีรายงานจุดเสี่ยงบนถนนที่จะวิ่งผ่าน'
          }</small>
        </span>
        <span class="trip-risk__score">${blend.score}<small>%</small></span>
      </div>

      ${blend.note}

      ${roads ? `
        <h4 class="trip-subhead">ความเสี่ยงรายถนนบนเส้นทาง</h4>
        <ul class="trip-roads">${roads}</ul>` : ''}

      <p class="trip-note">${escapeHtml(a.vehicle.note)} · นับจุดที่อยู่ห่างเส้นทางไม่เกิน ${a.corridor} ม.</p>`;

    $$('#tripBody [data-route]').forEach((btn) => {
      btn.addEventListener('click', () => {
        tripPick = Number(btn.dataset.route);
        renderTripBody();
      });
    });
  }

  /**
   * ตัวเลือกเส้นทาง — โผล่เฉพาะตอน OSRM ให้เส้นทางสำรองมามากกว่าหนึ่งเส้น
   *
   * ตั้งใจไม่สลับเส้นทางให้เองเงียบ ๆ แค่ชี้ให้เห็นว่ามีเส้นที่ปลอดภัยกว่า
   * แล้วให้ผู้ใช้ตัดสินใจ เพราะคะแนนความเสี่ยงของเรายังเป็นค่าประมาณ
   */
  function renderRouteChoices(all, verdict) {
    if (all.length < 2) return '';

    const fastest = all[0];
    const rows = all.map((a, i) => {
      const slower = a.duration - fastest.duration;
      /*
       * ในฉากสาธิตป้ายบอก "เส้นนี้มีความเสี่ยงชนิดไหน" สำคัญกว่าบอกว่าเร็วหรือปลอดภัย
       * เพราะทั้งฉากมีไว้เทียบสองแหล่งข้อมูลให้เห็น ไม่ใช่ให้เลือกเส้นที่ดีที่สุด
       */
      let badge;
      if (tripSimulate && i === demoRouteIndex) {
        badge = '<em class="route-opt__badge route-opt__badge--both">รายงาน + โมเดล</em>';
      } else if (tripSimulate && i === demoStatOnlyIndex) {
        badge = '<em class="route-opt__badge route-opt__badge--ai">เฉพาะโมเดล</em>';
      } else if (a === verdict.safest && verdict.safest !== fastest) {
        badge = '<em class="route-opt__badge route-opt__badge--safe">ปลอดภัยกว่า</em>';
      } else {
        badge = i === 0 ? '<em class="route-opt__badge">เร็วที่สุด</em>' : '';
      }

      return `
        <button type="button" class="route-opt${i === tripPick ? ' is-active' : ''}"
                data-route="${i}" style="--opt-color:${a.level.color}">
          <span class="route-opt__main">
            <strong>${formatDuration(a.duration)}</strong>
            <small>${U.formatDistance(a.distance)}${
              slower > 30 ? ` · ช้ากว่า ${formatDuration(slower)}` : ''
            }</small>
          </span>
          ${badge}
          <span class="route-opt__score">${a.score}<small>%</small></span>
        </button>`;
    }).join('');

    const tip = verdict.shouldSwitch
      ? `<p class="route-tip">มีเส้นที่เสี่ยงน้อยกว่า <strong>${verdict.gain}</strong> แต้ม
         ${verdict.extraSeconds > 30 ? `แลกกับเวลาเพิ่ม ${formatDuration(verdict.extraSeconds)}` : 'โดยไม่ช้าลงเลย'}</p>`
      : '';

    return `
      <span class="field-label">เลือกเส้นทาง</span>
      <div class="route-opts">${rows}</div>
      ${tip}`;
  }

  /* ---------- แผ่นรายการแบบลากได้ ---------- */

  // ระยะที่เลื่อนแผ่นลง คิดเป็น % ของความสูงแผ่น (0 = เปิดเต็ม)
  const DETENTS = { full: 0, half: 42, peek: 56, closed: 100 };
  let detent = 'peek';

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  function setDetent(name) {
    const sheet = $('#sidebar');
    detent = name;
    sheet.dataset.detent = name;
    sheet.classList.toggle('is-open', name !== 'closed');
    // เผื่อระยะขอบล่างตอนปิด เพื่อให้ซ่อนมิด
    sheet.style.setProperty(
      '--sheet-shift',
      name === 'closed' ? 'calc(100% + 16px)' : `${DETENTS[name]}%`
    );

    // ปิดแผ่นแล้วต้องมีทางเรียกกลับ — โชว์แถบเตี้ยไว้เหนือแท็บบาร์
    // (ซ่อนตอนนำทางเพราะมีการ์ดนำทางกับแถบสรุปอยู่แล้ว)
    const peek = $('#sheetPeek');
    peek.hidden = name !== 'closed' || window.Navigate.isActive || currentView !== 'map';
    $('#sheetPeekCount').textContent = $('#sidebarCount').textContent;

    syncSheetToggle();
    syncMapInsets(name);
  }

  /**
   * บอกแผนที่ว่าตอนนี้มี UI บังอยู่เท่าไร กล้องจะได้เล็งกลาง "ส่วนที่มองเห็น"
   *
   * แผนที่กินพื้นที่เต็มจอ แต่แถบค้นหาบังด้านบนและแผ่นความปลอดภัยบังด้านล่าง
   * ถ้าไม่บอก กล้องจะเล็งกลางจอจริง แล้วหัวลูกศรของผู้ใช้ไปโผล่หลังแผ่นพอดี
   *
   * ใช้ offsetTop/offsetHeight ซึ่งไม่นับ transform จึงอ่านค่าได้ทันทีที่สั่งเลื่อนแผ่น
   * ไม่ต้องรอแอนิเมชัน 320 มิลลิวินาทีจบก่อน (getBoundingClientRect จะได้ค่ากลางทาง)
   */
  function syncMapInsets(name = detent) {
    const sheet = $('#sidebar');
    const phoneH = $('#phone').clientHeight;
    if (!phoneH || !sheet.offsetHeight) return;

    // ระยะจากก้นจอถึงขอบล่างของแผ่น (ตอนยังไม่ถูกเลื่อนลง)
    const bottomGap = phoneH - sheet.offsetTop - sheet.offsetHeight;
    const shownPct = name === 'closed' ? 0 : 1 - DETENTS[name] / 100;
    const covered = bottomGap + sheet.offsetHeight * shownPct;

    // ปิดแผ่นแล้วยังมีแท็บบาร์กับแถบดึงแผ่นอยู่ จึงกันที่ไว้เท่านั้นเป็นอย่างน้อย
    const floor = $('.tabbar').offsetHeight + 56;
    const top = $('.searchbar').offsetHeight + 24;
    let bottom = Math.max(floor, covered);

    // ตอนกางเต็มแผ่นบนจอเตี้ย ระยะบน+ล่างอาจรวมกันเกินความสูงจอ
    // จนไม่เหลือพื้นที่ให้กล้องเล็ง — ต้องเหลือช่องว่างไว้อย่างน้อย 120px เสมอ
    const maxTotal = phoneH - 120;
    if (top + bottom > maxTotal) bottom = Math.max(0, maxTotal - top);

    window.MapView.setViewInsets({ top, bottom });
  }

  /**
   * ปุ่มย่อ/ขยายในหัวแผ่น
   *
   * กดแล้วหดลงทีละขั้น (เต็มจอ → ครึ่งจอ → แง้ม → ปิด) และเมื่อปิดสนิท
   * ก็ยังดึงกลับมาได้จากแถบเตี้ยเหนือแท็บบาร์ ผู้ใช้จึงไม่ต้องลากแผ่นเองเสมอไป
   */
  const COLLAPSE_NEXT = { full: 'half', half: 'peek', peek: 'closed', closed: 'half' };

  function syncSheetToggle() {
    const btn = $('#btnSheetToggle');
    if (!btn) return;
    const expanded = detent !== 'closed';
    btn.setAttribute('aria-expanded', String(expanded));
    btn.title = expanded ? 'ย่อแผ่นลง' : 'ขยายแผ่นขึ้น';
    btn.innerHTML = window.Icons.get(expanded ? 'chevronDown' : 'chevronUp');
  }

  function nearestDetent(pct) {
    return Object.keys(DETENTS).reduce((best, key) =>
      Math.abs(DETENTS[key] - pct) < Math.abs(DETENTS[best] - pct) ? key : best
    );
  }

  function bindSheetDrag() {
    const sheet = $('#sidebar');
    const grip = sheet.querySelector('.sidebar__head');
    let startY = 0;
    let startPx = 0;
    let height = 0;
    let dragging = false;

    grip.addEventListener('pointerdown', (e) => {
      // ปุ่มในหัวแผ่น (กรองข้อมูล / ย้อนกลับ) ต้องกดได้ ไม่ใช่ไปลากแผ่น
      if (e.target.closest('button')) return;
      dragging = true;
      startY = e.clientY;
      height = sheet.offsetHeight;
      startPx = (DETENTS[detent] / 100) * height;
      sheet.classList.add('is-dragging');
      grip.setPointerCapture(e.pointerId);
    });

    grip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const px = clamp(startPx + (e.clientY - startY), 0, height);
      sheet.style.setProperty('--sheet-shift', `${px}px`);
    });

    const finish = (e) => {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('is-dragging');
      const moved = Math.abs(e.clientY - startY);

      // ขยับน้อยกว่า 6px ถือว่าเป็นการ "แตะ" ไม่ใช่ลาก — สลับแง้ม/ครึ่งจอ
      if (moved < 6) {
        setDetent(detent === 'peek' ? 'half' : 'peek');
        return;
      }
      const px = clamp(startPx + (e.clientY - startY), 0, height);
      setDetent(nearestDetent((px / height) * 100));
    };

    grip.addEventListener('pointerup', finish);
    grip.addEventListener('pointercancel', finish);
  }

  function closeMobilePanel() {
    setDetent('closed');
  }

  /**
   * เลือกรายการแล้ว — แผ่นสลับเป็นหน้ารายละเอียด
   *
   * ต้องกางเต็มแผ่น ไม่ใช่ครึ่งจอ เพราะการ์ดรายละเอียดสูงกว่าครึ่งจอ
   * ถ้าเปิดแค่ 'half' ปุ่ม "นำทางไปจุดนี้" จะจมอยู่หลังแท็บบาร์
   */
  function collapseToMap() {
    closeSearchView();
    setDetent(window.Store.state.selectedId ? 'full' : 'half');
  }

  /* ---------- สถานะปุ่มติดตาม / เสียง ---------- */

  function syncStatusButtons() {
    const s = window.Store.state;
    const tracking = window.Alerts.isTracking || s.simulating;
    // ตัวบ่งชี้ย้ายไปอยู่ที่ปุ่มตำแหน่งบนแผนที่ ตั้งแต่ตัดปุ่ม 📍 ในช่องค้นหาออก
    const btn = $('#btnMyLocation');
    btn.classList.toggle('is-live', tracking);
    btn.title = tracking ? 'กำลังติดตามตำแหน่ง' : 'ไปที่ตำแหน่งของฉัน';
    // สวิตช์ในหน้าตั้งค่าคือทางเดียวที่จะ "หยุด" ติดตาม หลังปุ่ม 📍 ถูกตัดออกจากช่องค้นหา
    $('#setTrack').checked = window.Alerts.isTracking;
  }

  function setNearby(list) {
    nearbyCache = list;
  }

  /* ---------- ผูกเหตุการณ์ ---------- */

  function bind() {

    renderFilterSheet();
    renderTypeGrid();

    $('#btnFilter').addEventListener('click', () => openOverlay('#filterSheet'));

    // ย่อ/ขยายแผ่นความปลอดภัยด้วยปุ่ม (นอกเหนือจากการลาก)
    $('#btnSheetToggle').addEventListener('click', () => setDetent(COLLAPSE_NEXT[detent]));

    // แผ่นจุดเสี่ยงบนเส้นทาง — เปิดจากป้ายความปลอดภัยบนจอนำทาง
    $('#navSafety').addEventListener('click', openRiskSheet);
    $('#riskClose').addEventListener('click', closeRiskSheet);
    $('#riskDone').addEventListener('click', closeRiskSheet);
    $('#riskSheet').addEventListener('click', (e) => {
      if (e.target.id === 'riskSheet') closeRiskSheet();
    });

    // แผ่นสรุปการเดินทาง
    $('#tripClose').addEventListener('click', closeTripSheet);
    $('#tripCancel').addEventListener('click', closeTripSheet);
    $('#tripSheet').addEventListener('click', (e) => {
      if (e.target.id === 'tripSheet') closeTripSheet();
    });
    $('#tripStart').addEventListener('click', async () => {
      const preRoute = tripRoute();
      if (!tripPlace || !preRoute) return;
      const dest = { lng: tripPlace.lng, lat: tripPlace.lat, label: tripPlace.name };
      const vehicle = tripVehicle;
      const simulate = tripSimulate;

      /*
       * เส้น "เฉพาะโมเดล" ไม่มีรายงานสาธิตวางไว้ให้เจอระหว่างทาง
       * ถ้าเริ่มขับจากต้นทางจริงอาจต้องรอหลายนาทีกว่าจะถึงจุดแรก
       * จึงเริ่มที่ราว 400 ม. ก่อนถึงจุดสถิติจุดแรก — คำเตือนจะขึ้นในไม่กี่วินาที
       * (400 ม. ต่ำกว่าระยะเตือนล่วงหน้า 500 ม. เล็กน้อย)
       */
      const startAtRisk = simulate && tripPick === demoStatOnlyIndex;
      const drivePath = startAtRisk
        ? window.Hotspots.trimToFirstSpot(preRoute.coordinates)
        : preRoute.coordinates;

      if (startAtRisk && drivePath !== preRoute.coordinates) {
        const head = U.bearing(drivePath[0], drivePath[1]);
        window.Store.setUserPosition(drivePath[0], head, 0);
      }
      // เคลียร์ก่อนปิด ไม่งั้น closeTripSheet จะไปลบจุดของฉากที่กำลังจะใช้ขับทิ้ง
      tripSimulate = false;
      closeTripSheet();

      await startNavigation(dest, { vehicle, preRoute, skipOverview: simulate });

      // ฉากสาธิต: ขับตามเส้นที่ผู้ใช้เพิ่งเลือก หัวลูกศรจึงขนานกับถนนเสมอ
      if (simulate && window.Navigate.isActive) {
        window.Alerts.startSimulation(drivePath);
        syncSettings();
        syncStatusButtons();
      }
    });
    // ปุ่มย้อนกลับในหน้ารายละเอียด — เลิกเลือกแล้วแผ่นจะกลับเป็นรายการเอง
    // และหุบกลับมาระดับแง้ม เพราะรายการไม่ต้องใช้ที่เยอะเท่าการ์ดรายละเอียด
    $('#btnBack').addEventListener('click', () => {
      window.Store.select(null);
      setDetent('peek');
    });
    $('#filterClose').addEventListener('click', () => closeOverlay('#filterSheet'));
    $('#filterSheet').addEventListener('click', (e) => {
      if (e.target.id === 'filterSheet') closeOverlay('#filterSheet');
    });
    $('#filterAll').addEventListener('click', () => window.Store.setAllTypes(true));
    $('#filterNone').addEventListener('click', () => window.Store.setAllTypes(false));

    bindSearch();

    $('#btnReset').addEventListener('click', () => {
      window.Store.resetToSeed();
      toast('รีเซ็ตข้อมูลตัวอย่างแล้ว');
    });

    $('#reportClose').addEventListener('click', closeReportSheet);
    $('#reportCancel').addEventListener('click', closeReportSheet);
    $('#reportForm').addEventListener('submit', submitReport);
    $('#reportSheet').addEventListener('click', (e) => {
      if (e.target.id === 'reportSheet') closeReportSheet();
    });

    $('#btnPickLocation').addEventListener('click', () => {
      window.MapView.setPickMode(true);
      $('#reportSheet').classList.add('is-picking');
      toast('แตะจุดบนแผนที่เพื่อระบุตำแหน่งเหตุ');
    });

    window.MapView.onMapClick = (coord) => {
      pendingLocation = coord;
      window.MapView.setPickMode(false);
      $('#reportSheet').classList.remove('is-picking');
      updateLocationText();
      // ย้ายจุดแล้วชื่อถนนเดิมอาจไม่ตรง จึงหาใหม่ให้
      $('#roadInput').value = '';
      fillRoadFromLocation();
      toast('บันทึกตำแหน่งแล้ว');
    };

    $$('#severityGroup button').forEach((btn) => {
      btn.addEventListener('click', () => {
        formSeverity = btn.dataset.severity;
        syncSeverity();
      });
    });

    // แท็บล่าง
    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => setView(tab.dataset.view));
    });
    $('#btnViewMap').addEventListener('click', () => setView('map'));
    $('#btnReset2').addEventListener('click', () => {
      window.Store.resetToSeed();
      toast('รีเซ็ตข้อมูลตัวอย่างแล้ว');
    });

    // สลับพื้นทึบ / แผนที่จริง
    $('#setRealMap').addEventListener('change', (e) => {
      window.MapView.setStyleMode(e.target.checked ? 'vector' : 'plain');
      toast(e.target.checked ? 'เปิดแผนที่จริงแล้ว' : 'กลับไปใช้พื้นทึบแล้ว');
    });

    // สวิตช์นี้เป็นตัวสลับเดียวกับที่ปุ่มตำแหน่งบนแผนที่เรียกใช้
    $('#setTrack').addEventListener('change', () => $('#btnTrack').click());

    $('#setSound').addEventListener('change', (e) => {
      window.Alerts.setSetting('sound', e.target.checked);
      if (e.target.checked) window.Alerts.ensureAudio();
      syncStatusButtons();
    });
    $('#setVoice').addEventListener('change', (e) => {
      window.Alerts.setSetting('voice', e.target.checked);
      syncSettings(); // เปิดสวิตช์แล้วต้องรู้ทันทีว่าเครื่องนี้มีเสียงไทยไหม
    });

    /*
     * Chrome คืนรายการเสียงเป็น array ว่างในครั้งแรก แล้วค่อยยิง voiceschanged ตามมา
     * ถ้าไม่ฟัง event นี้ หน้าตั้งค่าจะค้างอยู่กับข้อมูลตอนเปิดหน้า
     * แล้วอาจเตือนว่า "ไม่มีเสียงไทย" ทั้งที่มี หรือกลับกัน
     */
    if ('speechSynthesis' in window) {
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        if (!$('#viewSettings').hidden) syncSettings();
      });
    }
    $('#setVibrate').addEventListener('change', (e) => window.Alerts.setSetting('vibrate', e.target.checked));

    $('#alertClose').addEventListener('click', hideAlert);
    $('#btnStopNav').addEventListener('click', () => {
      stopNavigation();
      toast('จบการนำทางแล้ว');
    });

    $('#btnRecenter').addEventListener('click', goToMyLocation);

    // กดหรือปัดขึ้นที่แถบเตี้ย = เปิดแผ่นความปลอดภัยกลับมา
    $('#sheetPeek').addEventListener('click', () => setDetent('peek'));
    bindSheetDrag();
    setDetent('peek');
    setView('map');
    syncSettings();

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#reportSheet').hidden) closeReportSheet();
      else if (riskOpen) closeRiskSheet();
      else if (!$('#tripSheet').hidden) closeTripSheet();
      else if (!$('#filterSheet').hidden) closeOverlay('#filterSheet');
      else if (searchOpen) { clearSearch(); closeSearchView(); }
      else if (window.Store.state.selectedId) window.Store.select(null);
    });
  }

  return {
    bind,
    renderList,
    renderRisk,
    renderDetail,
    renderNav,
    renderNavStatus,
    renderDashboard,
    setView,
    syncSettings,
    startNavigation,
    stopNavigation,
    toggleSimulationDrive,
    goToMyLocation,
    showDetailSheet: collapseToMap,

    renderFilterSheet,
    syncFilters,
    syncStatusButtons,
    showAlert,
    hideAlert,
    showNavHazard,
    openRiskSheet,
    openReportDetail,
    showHotspot,
    openTripSheet,
    toast,
    setNearby,
    closeMobilePanel,
    get nearby() { return nearbyCache; },
  };
})();
