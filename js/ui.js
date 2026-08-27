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

    renderTypeChips();
  }

  /* ---------- แถบชิปเลือกประเภท (ปัดซ้าย-ขวาได้) ---------- */

  /**
   * แถวชิปในหัวแผ่น: "ทั้งหมด" ตามด้วยประเภทภัยทีละอัน
   *
   * กดชิปประเภท = แสดงเฉพาะประเภทนั้นอย่างเดียว (ไม่ใช่เปิด/ปิดทีละอันสะสมกัน)
   * กดซ้ำที่ชิปที่เลือกอยู่ หรือกด "ทั้งหมด" = กลับไปแสดงครบทุกประเภท
   * แถวนี้เลื่อนแนวนอนในตัวเอง จึงไม่มีทางล้นออกนอกขอบขวาของจอ
   */
  function renderTypeChips() {
    const box = $('#typeChips');
    if (!box) return;

    const active = window.Store.state.activeTypes;
    const counts = window.Store.countsByType();
    const showingAll = active.size === typeCount;
    // "เลือกอยู่ประเภทเดียว" คือสถานะที่ชิปนั้นควรถูกไฮไลต์
    const only = active.size === 1 ? [...active][0] : null;

    box.innerHTML = '';

    const allChip = el('button', 'chip');
    allChip.type = 'button';
    allChip.setAttribute('role', 'tab');
    allChip.setAttribute('aria-selected', String(showingAll));
    allChip.classList.toggle('is-on', showingAll);
    allChip.innerHTML = `ทั้งหมด <span class="chip__n">${window.Store.state.reports.length}</span>`;
    allChip.addEventListener('click', () => window.Store.setAllTypes(true));
    box.appendChild(allChip);

    for (const [key, def] of Object.entries(CFG.HAZARD_TYPES)) {
      const n = counts[key] || 0;
      const chip = el('button', 'chip chip--type');
      chip.type = 'button';
      chip.setAttribute('role', 'tab');
      chip.dataset.type = key;
      chip.style.setProperty('--chip-color', def.color);
      const on = only === key;
      chip.setAttribute('aria-selected', String(on));
      chip.classList.toggle('is-on', on);
      chip.classList.toggle('is-empty', n === 0);
      chip.innerHTML = `
        <span class="chip__icon">${def.icon}</span>
        ${escapeHtml(def.label)}
        <span class="chip__n">${n}</span>`;

      chip.addEventListener('click', () => {
        if (only === key) window.Store.setAllTypes(true);
        else window.Store.setOnlyType(key);
      });
      box.appendChild(chip);

      // เลื่อนชิปที่เพิ่งเลือกให้เข้ามาอยู่ในสายตา เผื่อมันอยู่นอกจอทางขวา
      if (on) requestAnimationFrame(() => chip.scrollIntoView({ inline: 'center', block: 'nearest' }));
    }
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

  function renderList() {
    const list = $('#hazardList');
    const items = window.Store.sortedByDistance(origin());
    const selectedId = window.Store.state.selectedId;

    $('#sidebarCount').textContent = items.length;
    list.innerHTML = '';

    if (!items.length) {
      const empty = el('li', 'empty-state');
      const searching = window.Store.state.search.trim();
      empty.innerHTML = searching
        ? `<div>${window.Icons.get('search')}</div><p>ไม่พบรายงานที่ตรงกับ “${escapeHtml(searching)}”<br />ลองคำอื่น หรือล้างช่องค้นหา</p>`
        : `<div>${window.Icons.get('map')}</div><p>ยังไม่มีรายงานที่ตรงกับตัวกรอง<br />ลองเปิดตัวกรองเพิ่ม หรือกด “แจ้งเหตุ”</p>`;
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
        window.MapView.flyToReport(item);
        collapseToMap();
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

    box.style.setProperty('--risk-color', risk.level.color);
    box.dataset.level = risk.level.key;


    const nearestText = risk.nearest && risk.nearest.distance != null
      ? U.formatDistance(risk.nearest.distance)
      : '—';

    // พาดหัวเป็น "ปลอดภัยกี่ %" ซึ่งอ่านง่ายกว่าคะแนนเสี่ยง 0-100 ที่ยิ่งมากยิ่งแย่
    const safety = 100 - risk.score;

    box.innerHTML = `
      <div class="risk__head">
        <span class="risk__level">${escapeHtml(risk.level.label)}</span>
        <span class="risk__score">${safety}<small>%</small></span>
      </div>
      <div class="risk__meter" role="meter" aria-valuenow="${safety}"
           aria-valuemin="0" aria-valuemax="100"
           aria-label="ความปลอดภัยรอบตัว ${safety} เปอร์เซ็นต์">
        <div class="risk__bar" style="width:${Math.max(safety, 2)}%"></div>
      </div>
      <p class="risk__summary">
        <strong>${risk.count}</strong> จุดใกล้เคียง
        ${risk.high ? ` · <strong>${risk.high}</strong> อันตราย` : ''}
        ${risk.nearest ? ` · ใกล้สุด <strong>${escapeHtml(nearestText)}</strong>` : ''}
        ${known ? '' : ' · คิดจากกลางจอ'}
      </p>`;
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
      /*
       * การนำทางเกิดบนแผนที่เสมอ จึงต้องสลับกลับมาแท็บแผนที่ก่อน
       * ไม่งั้นถ้าสั่งเริ่มนำทางจากหน้าตั้งค่า/แดชบอร์ด (เช่นเปิดโหมดจำลอง)
       * หน้านั้นจะยังคลุมแผนที่อยู่ แล้วการ์ดนำทางไปลอยทับรายการตั้งค่าแทน
       */
      setView('map');
      // เริ่มนำทาง = ล็อกกล้องไว้ที่ลูกศรก่อนเสมอ
      window.Store.setFollowing(true);
      setDetent('closed');
      window.MapView.setNavRoute(route.coordinates);

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
    } catch (err) {
      toast(err.message || 'หาเส้นทางไม่สำเร็จ', 'warn');
    }
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
      window.MapView.followUser(s.userPosition, s.userHeading);
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
    renderNav();
    setDetent('peek');
    syncSettings();
  }

  /**
   * เปิด/ปิดโหมดจำลองการขับ
   *
   * เปิดแล้วพาเข้าหน้านำทางเลย ไม่ใช่แค่ขยับหมุดอยู่บนหน้าแผนที่ และให้รถวิ่งตาม
   * "เส้นทางจริงที่ OSRM คืนมา" ซึ่งเป็นเส้นเดียวกับที่กำลังนำทาง หัวลูกศรจึงขนาน
   * กับถนนเสมอ (ของเดิมวิ่งเป็นเส้นตรงระหว่างจุดสาธิต ลูกศรเลยเฉียงออกจากเส้นสีน้ำเงิน)
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
    toast('กำลังเตรียมเส้นทางสาธิต…');

    try {
      const route = await window.Route.getRouteVia(window.Alerts.SIM_WAYPOINTS);
      const path = route.coordinates;
      const start = path[0];
      const end = path[path.length - 1];

      // วางตัวผู้ใช้ที่จุดเริ่มก่อน เพื่อให้การนำทางคิดจากตรงนั้น ไม่ใช่จากกลางจอ
      window.Store.setUserPosition(start, U.bearing(start, path[1] || end), 0);

      await startNavigation(
        { lng: end[0], lat: end[1], label: 'ปลายทางเส้นทางสาธิต' },
        { vehicle: 'car', preRoute: route, skipOverview: true }
      );
      // เริ่มขับหลังจากตั้งโหมดนำทางเสร็จ กล้องจะได้ไม่โดนแย่งระหว่างจัดมุมครั้งแรก
      // (ไม่ต้อง toast ซ้ำ — การที่หน้าจอเปลี่ยนเป็นโหมดนำทางก็บอกอยู่แล้วว่าเริ่มแล้ว)
      window.Alerts.startSimulation(path);
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

    const a = window.Navigate.analysis;
    const safety = $('#navSafety');
    if (!a) {
      $('#navSafetyLabel').textContent = 'กำลังประเมิน';
      $('#navSafetyDetail').textContent = 'เส้นทางนี้';
      return;
    }

    safety.style.setProperty('--safety-color', a.level.color);
    safety.dataset.level = a.level.key;
    $('#navSafetyLabel').textContent = a.level.label;
    $('#navSafetyDetail').textContent = a.points.length
      ? `${a.points.length} จุดเสี่ยงบนเส้นทาง`
      : 'ไม่พบจุดเสี่ยงบนเส้นทาง';
  }

  /** แถบเตือนจุดเสี่ยงที่กำลังจะถึงบนเส้นทาง (null = ซ่อน) */
  function showNavHazard(hit) {
    const box = $('#navHazard');
    if (!hit) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }

    const def = CFG.HAZARD_TYPES[hit.report.type];
    // ใกล้กว่า 30 ม. คือกำลังผ่านจุดนั้นพอดี บอก "อีก 0 ม." จะอ่านแล้วงง
    const ahead = hit.ahead < 30 ? 'ตรงนี้' : `อีก ${U.formatDistance(hit.ahead)}`;

    box.hidden = false;
    box.dataset.severity = hit.report.severity;
    box.style.setProperty('--hazard-color', def.color);
    box.innerHTML = `
      <span class="nav-hazard__icon">${def.icon}</span>
      <span class="nav-hazard__text">
        <strong>${escapeHtml(def.label)} ${ahead}</strong>
        <small>${escapeHtml(hit.road)}</small>
      </span>`;
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
        window.MapView.flyToReport(item);
        collapseToMap();
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
  let tripRoute = null;     // เส้นทางที่คำนวณแล้ว (ใช้ซ้ำตอนกดเริ่มนำทาง)
  let tripVehicle = 'car';

  async function openTripSheet(place) {
    tripPlace = place;
    tripRoute = null;

    $('#tripName').textContent = place.name;
    $('#tripDetail').textContent = place.detail || '';
    $('#tripStart').disabled = true;
    renderVehiclePicker();
    $('#tripBody').innerHTML = '<p class="place-note">กำลังคำนวณเส้นทางและประเมินความเสี่ยง…</p>';
    openOverlay('#tripSheet');

    try {
      tripRoute = await window.Route.getRoute(origin(), [place.lng, place.lat]);
      if (tripPlace !== place) return; // ผู้ใช้เปลี่ยนจุดหมายระหว่างรอ
      $('#tripStart').disabled = false;
      renderTripBody();
    } catch (err) {
      $('#tripBody').innerHTML = `<p class="place-note">${escapeHtml(err.message || 'หาเส้นทางไม่สำเร็จ')}</p>`;
    }
  }

  function closeTripSheet() {
    tripPlace = null;
    tripRoute = null;
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
        if (tripRoute) renderTripBody();
      });
      box.appendChild(btn);
    }
  }

  /** เวลา ระยะทาง ความเสี่ยงรวม และรายชื่อถนนเสี่ยงบนเส้นทางที่เลือก */
  function renderTripBody() {
    const a = window.RouteRisk.analyze(tripRoute, tripVehicle);
    const eta = new Date(Date.now() + a.duration * 1000)
      .toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

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
      <div class="trip-stats">
        <div><span>เวลาเดินทาง</span><strong>${formatDuration(a.duration)}</strong></div>
        <div><span>ระยะทาง</span><strong>${U.formatDistance(a.distance)}</strong></div>
        <div><span>ถึงเวลา</span><strong>${eta}</strong></div>
      </div>

      <div class="trip-risk" data-level="${a.level.key}" style="--risk-color:${a.level.color}">
        <span class="trip-risk__icon">${window.Icons.get('shield')}</span>
        <span class="trip-risk__text">
          <strong>เส้นทางนี้ ${escapeHtml(a.level.label)}</strong>
          <small>${
            a.points.length
              ? `พบ ${a.points.length} จุดเสี่ยงบนถนนที่จะวิ่งผ่าน${a.accidents ? ` (อุบัติเหตุ ${a.accidents})` : ''}`
              : 'ยังไม่มีรายงานจุดเสี่ยงบนถนนที่จะวิ่งผ่าน'
          }</small>
        </span>
        <span class="trip-risk__score">${a.score}<small>%</small></span>
      </div>

      ${roads ? `
        <h4 class="trip-subhead">ความเสี่ยงรายถนนบนเส้นทาง</h4>
        <ul class="trip-roads">${roads}</ul>` : ''}

      <p class="trip-note">${escapeHtml(a.vehicle.note)} · นับจุดที่อยู่ห่างเส้นทางไม่เกิน ${a.corridor} ม.</p>`;
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

    // แผ่นสรุปการเดินทาง
    $('#tripClose').addEventListener('click', closeTripSheet);
    $('#tripCancel').addEventListener('click', closeTripSheet);
    $('#tripSheet').addEventListener('click', (e) => {
      if (e.target.id === 'tripSheet') closeTripSheet();
    });
    $('#tripStart').addEventListener('click', () => {
      if (!tripPlace || !tripRoute) return;
      const dest = { lng: tripPlace.lng, lat: tripPlace.lat, label: tripPlace.name };
      const preRoute = tripRoute;
      const vehicle = tripVehicle;
      closeTripSheet();
      startNavigation(dest, { vehicle, preRoute });
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
    $('#setVoice').addEventListener('change', (e) => window.Alerts.setSetting('voice', e.target.checked));
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
    renderTypeChips,
    syncFilters,
    syncStatusButtons,
    showAlert,
    hideAlert,
    showNavHazard,
    openTripSheet,
    toast,
    setNearby,
    closeMobilePanel,
    get nearby() { return nearbyCache; },
  };
})();
