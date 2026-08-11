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

  function renderFilters() {
    const box = $('#filters');
    box.innerHTML = '';
    for (const [key, def] of Object.entries(CFG.HAZARD_TYPES)) {
      const btn = el('button', 'chip');
      btn.type = 'button';
      btn.dataset.type = key;
      btn.style.setProperty('--chip-color', def.color);
      btn.innerHTML = `<span>${def.icon}</span>${escapeHtml(def.label)}`;
      btn.classList.toggle('is-on', window.Store.state.activeTypes.has(key));
      btn.addEventListener('click', () => window.Store.toggleType(key));
      box.appendChild(btn);
    }
  }

  function syncFilters() {
    $$('#filters .chip').forEach((btn) => {
      btn.classList.toggle('is-on', window.Store.state.activeTypes.has(btn.dataset.type));
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
      empty.innerHTML = `<div>🛣️</div><p>ยังไม่มีรายงานที่ตรงกับตัวกรอง<br />ลองเปิดตัวกรองเพิ่ม หรือกด “แจ้งเหตุ”</p>`;
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
          ${item.note ? `<div class="hazard-item__note">${escapeHtml(item.note)}</div>` : ''}
          <div class="hazard-item__meta">
            ${item.distance != null ? `<span>📍 ${U.formatDistance(item.distance)}</span>` : ''}
            <span>🕒 ${U.formatAgo(item.createdAt)}</span>
            <span>👍 ${item.confirms}</span>
          </div>
        </div>`;

      li.addEventListener('click', () => {
        window.Store.select(item.id);
        window.MapView.flyToReport(item);
        closeMobilePanel();
      });
      list.appendChild(li);
    }

    const total = window.Store.state.reports.length;
    const high = window.Store.state.reports.filter((r) => r.severity === 'high').length;
    $('#statsLine').textContent = `ทั้งหมด ${total} รายงาน · อันตราย ${high} จุด`;
  }

  /* ---------- การ์ดรายละเอียด ---------- */

  function renderDetail() {
    const card = $('#detailCard');
    const id = window.Store.state.selectedId;
    const report = window.Store.state.reports.find((r) => r.id === id);

    if (!report) {
      card.hidden = true;
      card.innerHTML = '';
      return;
    }

    const def = CFG.HAZARD_TYPES[report.type];
    const sev = CFG.SEVERITY[report.severity];
    const dist = U.distance(origin(), [report.lng, report.lat]);

    card.hidden = false;
    card.style.setProperty('--card-color', def.color);
    card.innerHTML = `
      <button class="detail-card__close" type="button" aria-label="ปิด">✕</button>
      <div class="detail-card__head">
        <div class="detail-card__icon">${def.icon}</div>
        <div>
          <strong>${escapeHtml(def.label)}</strong>
          <div class="detail-card__sub">
            <span class="sev sev--${report.severity}">${escapeHtml(sev.label)}</span>
            <span>${escapeHtml(report.road)}</span>
          </div>
        </div>
      </div>
      ${report.note ? `<p class="detail-card__note">${escapeHtml(report.note)}</p>` : ''}
      <div class="detail-card__stats">
        <div><span>ระยะห่าง</span><strong>${U.formatDistance(dist)}</strong></div>
        <div><span>รัศมีเตือน</span><strong>${report.radius} ม.</strong></div>
        <div><span>รายงานเมื่อ</span><strong>${U.formatAgo(report.createdAt)}</strong></div>
      </div>
      <div class="detail-card__actions">
        <button class="ghost-btn" data-act="up">👍 ยังอยู่ (${report.confirms})</button>
        <button class="ghost-btn" data-act="down">👎 หายแล้ว (${report.denies})</button>
        ${report.mine ? '<button class="ghost-btn danger" data-act="delete">ลบ</button>' : ''}
      </div>`;

    card.querySelector('.detail-card__close').addEventListener('click', () => window.Store.select(null));
    card.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'delete') {
          window.Store.removeReport(report.id);
          toast('ลบรายงานแล้ว');
        } else {
          window.Store.vote(report.id, act === 'up' ? 'up' : 'down');
        }
      });
    });
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
    $('#settingsSheet').hidden = false;
    requestAnimationFrame(() => $('#settingsSheet').classList.add('is-open'));
  }

  function closeSettings() {
    const sheet = $('#settingsSheet');
    sheet.classList.remove('is-open');
    setTimeout(() => { sheet.hidden = true; }, 200);
  }

  /* ---------- แผงบนมือถือ ---------- */

  function toggleMobilePanel() {
    $('#sidebar').classList.toggle('is-open');
  }

  function closeMobilePanel() {
    if (window.matchMedia('(max-width: 860px)').matches) {
      $('#sidebar').classList.remove('is-open');
    }
  }

  /* ---------- สถานะปุ่มติดตาม ---------- */

  function syncStatusButtons() {
    const s = window.Store.state;
    const trackBtn = $('#btnTrack');
    const tracking = window.Alerts.isTracking || s.simulating;
    trackBtn.classList.toggle('is-live', tracking);
    $('#trackLabel').textContent = tracking
      ? s.simulating ? 'กำลังจำลองการขับ' : 'กำลังติดตามตำแหน่ง'
      : 'เริ่มติดตามตำแหน่ง';
    $('#btnSim').classList.toggle('is-active', s.simulating);
  }

  function setNearby(list) {
    nearbyCache = list;
  }

  /* ---------- ผูกเหตุการณ์ ---------- */

  function bind() {
    renderFilters();
    renderTypeGrid();

    $('#filterAll').addEventListener('click', () => window.Store.setAllTypes(true));
    $('#filterNone').addEventListener('click', () => window.Store.setAllTypes(false));
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
      toast('บันทึกตำแหน่งแล้ว');
    };

    $$('#severityGroup button').forEach((btn) => {
      btn.addEventListener('click', () => {
        formSeverity = btn.dataset.severity;
        syncSeverity();
      });
    });

    $('#btnSettings').addEventListener('click', openSettings);
    $('#settingsClose').addEventListener('click', closeSettings);
    $('#settingsSheet').addEventListener('click', (e) => {
      if (e.target.id === 'settingsSheet') closeSettings();
    });
    $('#setSound').addEventListener('change', (e) => {
      window.Alerts.setSetting('sound', e.target.checked);
      if (e.target.checked) window.Alerts.ensureAudio();
    });
    $('#setVoice').addEventListener('change', (e) => window.Alerts.setSetting('voice', e.target.checked));
    $('#setVibrate').addEventListener('change', (e) => window.Alerts.setSetting('vibrate', e.target.checked));

    $('#alertClose').addEventListener('click', hideAlert);
    $('#btnPanel').addEventListener('click', toggleMobilePanel);

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#reportSheet').hidden) closeReportSheet();
      else if (!$('#settingsSheet').hidden) closeSettings();
      else if (window.Store.state.selectedId) window.Store.select(null);
    });
  }

  return {
    bind,
    renderList,
    renderDetail,
    renderFilters,
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
