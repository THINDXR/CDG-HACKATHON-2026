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

  /** ชิปกรองด่วนเหนือแผนที่ — มี "ทั้งหมด" นำหน้า แล้วตามด้วยแต่ละประเภท */
  function renderFilters() {
    const box = $('#quickFilters');
    box.innerHTML = '';

    const all = el('button', 'chip chip--all');
    all.type = 'button';
    all.dataset.type = '*';
    all.textContent = 'ทั้งหมด';
    all.addEventListener('click', () => window.Store.setAllTypes(true));
    box.appendChild(all);

    for (const [key, def] of Object.entries(CFG.HAZARD_TYPES)) {
      const btn = el('button', 'chip');
      btn.type = 'button';
      btn.dataset.type = key;
      btn.style.setProperty('--chip-color', def.color);
      btn.innerHTML = `<span>${def.icon}</span>${escapeHtml(def.label)}`;
      btn.addEventListener('click', () => window.Store.toggleType(key));
      box.appendChild(btn);
    }
    syncFilters();
  }

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
        <span class="filter-row__check">✓</span>`;
      row.addEventListener('click', () => window.Store.toggleType(key));
      box.appendChild(row);
    }
    syncFilters();
  }

  function syncFilters() {
    const active = window.Store.state.activeTypes;
    const showingAll = active.size === typeCount;
    $$('#quickFilters .chip').forEach((btn) => {
      // เมื่อเลือก "ทั้งหมด" ชิปรายประเภทจะเป็นสีกลาง ไม่ให้แถบดูรกไปหมด
      const on = btn.dataset.type === '*' ? showingAll : !showingAll && active.has(btn.dataset.type);
      btn.classList.toggle('is-on', on);
    });
    $$('#filterList .filter-row').forEach((row) => {
      row.classList.toggle('is-on', active.has(row.dataset.type));
    });
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
        ? `<div>🔍</div><p>ไม่พบรายงานที่ตรงกับ “${escapeHtml(searching)}”<br />ลองคำอื่น หรือล้างช่องค้นหา</p>`
        : `<div>🛣️</div><p>ยังไม่มีรายงานที่ตรงกับตัวกรอง<br />ลองเปิดตัวกรองเพิ่ม หรือกด “แจ้งเหตุ”</p>`;
      list.appendChild(empty);
    }

    for (const item of items) {
      const def = CFG.HAZARD_TYPES[item.type];
      const sev = CFG.SEVERITY[item.severity];
      const li = el('li', 'hazard-item');
      li.dataset.id = item.id;
      li.style.setProperty('--item-color', def.color);
      li.classList.toggle('is-selected', item.id === selectedId);

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
            <span>${item.confirms} รายงาน</span>
          </div>
        </div>
        <span class="hazard-item__go" aria-hidden="true">›</span>`;

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

    // ป้ายย่อบนแผนที่ ใช้ข้อมูลชุดเดียวกัน
    const chip = $('#riskChip');
    chip.style.setProperty('--risk-color', risk.level.color);
    chip.dataset.level = risk.level.key;
    chip.querySelector('.risk-chip__label').textContent = risk.level.label;
    chip.querySelector('.risk-chip__score').textContent = risk.score;

    const dominant = risk.dominantType ? CFG.HAZARD_TYPES[risk.dominantType] : null;
    const nearestText = risk.nearest && risk.nearest.distance != null
      ? U.formatDistance(risk.nearest.distance)
      : '—';

    box.innerHTML = `
      <div class="risk__head">
        <span class="risk__title">ความเสี่ยงรอบตัว</span>
        <span class="risk__level">${escapeHtml(risk.level.label)} · ${risk.score}</span>
      </div>
      <div class="risk__meter" role="meter" aria-valuenow="${risk.score}"
           aria-valuemin="0" aria-valuemax="100"
           aria-label="คะแนนความเสี่ยง ${risk.score} จาก 100">
        <div class="risk__bar" style="width:${Math.max(risk.score, 2)}%"></div>
      </div>
      <div class="risk__stats">
        <div><strong>${risk.count}</strong><span>จุดใกล้เคียง</span></div>
        <div><strong>${risk.high}</strong><span>อันตราย</span></div>
        <div><strong>${escapeHtml(nearestText)}</strong><span>ใกล้ที่สุด</span></div>
      </div>
      <p class="risk__advice">
        ${dominant ? `${dominant.icon} ส่วนใหญ่เป็น${escapeHtml(dominant.label)} — ` : ''}${escapeHtml(risk.level.advice)}${known ? '' : ' (คิดจากกลางจอแผนที่)'}
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

    sheet.classList.add('is-detail');
    card.style.setProperty('--card-color', def.color);
    card.innerHTML = `
      <div class="detail-card__head">
        <div class="detail-card__icon">${def.icon}</div>
        <div>
          <strong>${escapeHtml(def.label)}</strong>
          <div class="detail-card__sub">
            <span class="sev sev--${report.severity}">${escapeHtml(sev.label)}</span>
          </div>
        </div>
      </div>
      <h3 class="detail-card__road">${escapeHtml(report.road)}</h3>
      ${report.note ? `<p class="detail-card__note">${escapeHtml(report.note)}</p>` : ''}
      <div class="detail-card__stats">
        <div><span>ระยะห่าง</span><strong>${U.formatDistance(dist)}</strong></div>
        <div><span>รัศมีเตือน</span><strong>${report.radius} ม.</strong></div>
        <div><span>รายงานเมื่อ</span><strong>${U.formatAgo(report.createdAt)}</strong></div>
      </div>
      <button class="primary-btn detail-card__nav" data-act="navigate">🧭 นำทางไปจุดนี้</button>
      <div class="detail-card__actions">
        <button class="ghost-btn" data-act="up">👍 ยังอยู่ (${report.confirms})</button>
        <button class="ghost-btn" data-act="down">👎 หายแล้ว (${report.denies})</button>
        ${report.mine ? '<button class="ghost-btn danger" data-act="delete">ลบ</button>' : ''}
      </div>`;

    card.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'delete') {
          window.Store.removeReport(report.id);
          toast('ลบรายงานแล้ว');
        } else if (act === 'navigate') {
          startNavigation(
            { lng: report.lng, lat: report.lat, label: report.road || CFG.HAZARD_TYPES[report.type].label }
          );
        } else {
          window.Store.vote(report.id, act === 'up' ? 'up' : 'down');
        }
      });
    });
  }

  /* ---------- โหมดนำทาง ---------- */

  /** เริ่มนำทางจากตำแหน่งปัจจุบัน (หรือกลางจอถ้ายังไม่เปิด GPS) ไปยังจุดหมาย */
  async function startNavigation(dest) {
    const from = origin();
    if (!from) {
      toast('ยังไม่ทราบตำแหน่งเริ่มต้น', 'warn');
      return;
    }

    window.Alerts.ensureAudio();
    toast('กำลังคำนวณเส้นทาง…');

    try {
      const route = await window.Navigate.start(from, dest);
      $('#phone').classList.add('is-navigating');
      setDetent('closed');
      window.MapView.setNavRoute(route.coordinates);
      window.MapView.fitRoute(route.coordinates);
      renderNav();

      if (!window.Store.state.userPosition) {
        toast('เปิดติดตามตำแหน่งหรือโหมดจำลองการขับ เพื่อให้นำทางเดินหน้าได้', 'warn');
      }
    } catch (err) {
      toast(err.message || 'หาเส้นทางไม่สำเร็จ', 'warn');
    }
  }

  function stopNavigation() {
    window.Navigate.stop();
    $('#phone').classList.remove('is-navigating');
    window.MapView.setNavRoute(null);
    renderNav();
    setDetent('peek');
  }

  /** วาดการ์ดนำทางและแถบสรุปด้านล่างจากความคืบหน้าล่าสุด */
  function renderNav() {
    const active = window.Navigate.isActive;
    $('#navCard').hidden = !active;
    $('#navBar').hidden = !active;
    if (!active) return;

    const p = window.Navigate.progress;
    if (!p) return;

    $('#navArrow').textContent = p.step?.arrow || '⬆';
    $('#navDistance').textContent = U.formatDistance(p.distanceToManeuver);
    $('#navInstruction').textContent = p.step?.instruction || 'ตรงไป';

    $('#navRemaining').textContent = U.formatDistance(p.remaining);
    $('#navDuration').textContent = formatDuration(p.remainingSeconds);
    $('#navEta').textContent = new Date(Date.now() + p.remainingSeconds * 1000)
      .toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
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
    $('#alertIcon').textContent = def.icon;
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

  function openSettings() {
    $('#setSound').checked = window.Alerts.settings.sound;
    $('#setVoice').checked = window.Alerts.settings.voice;
    $('#setVibrate').checked = window.Alerts.settings.vibrate;
    $('#setSim').checked = window.Store.state.simulating;
    openOverlay('#settingsSheet');
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

  /* ---------- ค้นหา ---------- */

  function hideSearchResults() {
    const box = $('#searchResults');
    box.hidden = true;
    box.innerHTML = '';
  }

  function renderSearchResults(places) {
    const box = $('#searchResults');
    box.innerHTML = '';

    if (!places.length) {
      box.innerHTML = '<div class="search-note">ไม่พบสถานที่ที่ตรงกับคำค้น</div>';
      box.hidden = false;
      return;
    }

    for (const place of places) {
      const row = el('div', 'search-result');
      row.setAttribute('role', 'option');
      row.innerHTML = `
        <button class="search-result__main" type="button">
          <span class="search-result__pin" aria-hidden="true">📍</span>
          <span class="search-result__text">
            <span class="search-result__name">${escapeHtml(place.name)}</span>
            ${place.detail ? `<span class="search-result__detail">${escapeHtml(place.detail)}</span>` : ''}
          </span>
        </button>
        <button class="search-result__go" type="button" title="นำทางไปที่นี่">นำทาง</button>`;

      row.querySelector('.search-result__main').addEventListener('click', () => goToPlace(place));
      row.querySelector('.search-result__go').addEventListener('click', () => {
        $('#searchInput').value = '';
        window.Store.setSearch('');
        hideSearchResults();
        $('#searchInput').blur();
        startNavigation({ lng: place.lng, lat: place.lat, label: place.name });
      });
      box.appendChild(row);
    }
    box.hidden = false;
  }

  function goToPlace(place) {
    $('#searchInput').value = '';
    window.Store.setSearch('');
    hideSearchResults();
    $('#searchInput').blur();

    window.MapView.instance.flyTo({
      center: [place.lng, place.lat],
      zoom: 15.5,
      pitch: 55,
      duration: 1200,
    });
    setDetent('peek');
    toast(`ไปที่ ${place.name}`);
  }

  function bindSearch() {
    const input = $('#searchInput');
    let filterTimer = null;
    let placeTimer = null;
    let requestId = 0;

    input.addEventListener('input', () => {
      const value = input.value;

      // กรองรายงานทันที (ทำในเครื่อง เร็ว)
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => window.Store.setSearch(value), 180);

      // ค้นสถานที่จริงต้องยิงเน็ต จึงหน่วงนานกว่าและเลิกถ้าคำสั้นเกินไป
      clearTimeout(placeTimer);
      if (value.trim().length < 2) {
        hideSearchResults();
        return;
      }
      placeTimer = setTimeout(() => lookupPlaces(value), 650);
    });

    async function lookupPlaces(value) {
      const id = ++requestId;
      try {
        const places = await window.Geocode.search(value, origin());
        if (id !== requestId || input.value.trim() !== value.trim()) return;
        renderSearchResults(places);
      } catch (_) {
        if (id !== requestId) return;
        // ออฟไลน์หรือ Nominatim ล่ม — ยังกรองรายงานในเครื่องได้ตามปกติ
        const box = $('#searchResults');
        box.innerHTML = '<div class="search-note">ค้นหาสถานที่ไม่สำเร็จ — ยังกรองรายงานในรายการได้</div>';
        box.hidden = false;
      }
    }

    // แตะช่องค้นหา = กางรายการเต็มจอให้เลือกได้สะดวก
    input.addEventListener('focus', () => setDetent('full'));

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        window.Store.setSearch('');
        hideSearchResults();
        input.blur();
        setDetent('peek');
      }
    });

    // แตะที่อื่นแล้วปิดรายการผลลัพธ์
    document.addEventListener('pointerdown', (e) => {
      if (e.target.closest('#searchResults') || e.target.closest('.searchbar')) return;
      hideSearchResults();
    });
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

  /** เลือกรายการแล้ว — แผ่นสลับเป็นหน้ารายละเอียด เปิดครึ่งจอให้เห็นแผนที่ด้วย */
  function collapseToMap() {
    const input = $('#searchInput');
    if (document.activeElement === input) input.blur();
    hideSearchResults();
    setDetent('half');
  }

  /* ---------- สถานะปุ่มติดตาม / เสียง ---------- */

  function syncStatusButtons() {
    const s = window.Store.state;
    const tracking = window.Alerts.isTracking || s.simulating;
    $('#btnTrack').classList.toggle('is-live', tracking);
    $('#btnTrack').title = tracking ? 'กำลังติดตามตำแหน่ง' : 'ติดตามตำแหน่งของฉัน';

    const muted = !window.Alerts.settings.sound;
    $('#btnMute').textContent = muted ? '🔕' : '🔔';
    $('#btnMute').title = muted ? 'เปิดเสียงเตือน' : 'ปิดเสียงเตือน';
  }

  function setNearby(list) {
    nearbyCache = list;
  }

  /* ---------- ผูกเหตุการณ์ ---------- */

  function bind() {
    renderFilters();
    renderFilterSheet();
    renderTypeGrid();

    $('#btnFilter').addEventListener('click', () => openOverlay('#filterSheet'));
    // ปุ่มย้อนกลับในหน้ารายละเอียด — เลิกเลือกแล้วแผ่นจะกลับเป็นรายการเอง
    $('#btnBack').addEventListener('click', () => window.Store.select(null));
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

    $('#btnReport').addEventListener('click', openReportSheet);
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

    $('#btnSettings').addEventListener('click', openSettings);
    $('#settingsClose').addEventListener('click', () => closeOverlay('#settingsSheet'));
    $('#settingsSheet').addEventListener('click', (e) => {
      if (e.target.id === 'settingsSheet') closeOverlay('#settingsSheet');
    });
    $('#setSound').addEventListener('change', (e) => {
      window.Alerts.setSetting('sound', e.target.checked);
      if (e.target.checked) window.Alerts.ensureAudio();
      syncStatusButtons();
    });
    $('#setVoice').addEventListener('change', (e) => window.Alerts.setSetting('voice', e.target.checked));
    $('#setVibrate').addEventListener('change', (e) => window.Alerts.setSetting('vibrate', e.target.checked));

    // กระดิ่งบนแถบบน = ปิด/เปิดเสียงเตือนอย่างเร็ว
    $('#btnMute').addEventListener('click', () => {
      const next = !window.Alerts.settings.sound;
      window.Alerts.setSetting('sound', next);
      if (next) window.Alerts.ensureAudio();
      syncStatusButtons();
      toast(next ? 'เปิดเสียงเตือนแล้ว' : 'ปิดเสียงเตือนแล้ว');
    });

    $('#alertClose').addEventListener('click', hideAlert);
    $('#btnStopNav').addEventListener('click', () => {
      stopNavigation();
      toast('จบการนำทางแล้ว');
    });
    $('#riskChip').addEventListener('click', () => setDetent('half'));
    bindSheetDrag();
    setDetent('peek');

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#reportSheet').hidden) closeReportSheet();
      else if (!$('#filterSheet').hidden) closeOverlay('#filterSheet');
      else if (!$('#settingsSheet').hidden) closeOverlay('#settingsSheet');
      else if (window.Store.state.selectedId) window.Store.select(null);
    });
  }

  return {
    bind,
    renderList,
    renderRisk,
    renderDetail,
    renderNav,
    startNavigation,
    stopNavigation,
    showDetailSheet: collapseToMap,
    renderFilters,
    renderFilterSheet,
    syncFilters,
    syncStatusButtons,
    showAlert,
    hideAlert,
    toast,
    setNearby,
    closeMobilePanel,
    get nearby() { return nearbyCache; },
  };
})();
