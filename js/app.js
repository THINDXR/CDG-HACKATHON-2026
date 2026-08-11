/* จุดเริ่มต้นแอป: ประกอบ Store + MapView + Alerts + UI เข้าด้วยกัน */
(function () {
  const U = window.Utils;
  const { $ } = U;

  // ตำแหน่งอัปเดตถี่มาก (โดยเฉพาะโหมดจำลอง) จึงหน่วงการวาดรายการไว้
  let lastListRender = 0;
  const LIST_RENDER_MS = 2000;

  function boot() {
    window.Store.load();
    window.MapView.init('map');
    window.UI.bind();
    window.UI.renderList();
    window.UI.syncStatusButtons();

    wireStore();
    wireAlerts();
    wireMapControls();

    window.MapView.onMarkerClick = (id) => {
      window.Store.select(id);
      const r = window.Store.state.reports.find((x) => x.id === id);
      if (r) window.MapView.flyToReport(r, { zoom: Math.max(window.MapView.instance.getZoom(), 16.5) });
    };

    window.MapView.onReady(() => {
      window.MapView.refreshHazards();
      window.UI.toast('ลากด้วยสองนิ้ว (หรือกดขวาแล้วลาก) เพื่อหมุนและเอียงแผนที่');
    });

    // อัปเดตเวลา "กี่นาทีที่แล้ว" และล้างรายงานหมดอายุ
    setInterval(() => {
      window.Store.prune();
      window.UI.renderList();
    }, 60 * 1000);
  }

  /* ---------- เชื่อม Store กับหน้าจอ ---------- */

  function wireStore() {
    window.Store.subscribe((state, reason) => {
      if (reason === 'filter') window.UI.syncFilters();

      if (reason !== 'position') {
        window.MapView.refreshHazards();
        window.UI.renderList();
        window.UI.renderDetail();
      }

      if (reason === 'position') {
        window.MapView.setUserPuck(state.userPosition, state.userHeading);
        if (state.following) window.MapView.followUser(state.userPosition, state.userHeading);
        window.Alerts.check(state.userPosition, state.userHeading);
        if (Date.now() - lastListRender > LIST_RENDER_MS) {
          lastListRender = Date.now();
          window.UI.renderList();
        }
      }

      if (reason === 'following' || reason === 'simulating') window.UI.syncStatusButtons();
    });
  }

  /* ---------- เชื่อมระบบเตือน ---------- */

  function wireAlerts() {
    window.Alerts.onAlert = (item) => {
      window.UI.showAlert(item);
      window.UI.toast(`${item.def.icon} ${item.message}`, 'warn');
    };
    window.Alerts.onNearbyChange = (list) => window.UI.setNearby(list);

    $('#btnTrack').addEventListener('click', () => {
      window.Alerts.ensureAudio();
      if (window.Alerts.isTracking) {
        window.Alerts.stopTracking();
        window.Store.setFollowing(false);
        window.UI.syncStatusButtons();
        window.UI.toast('หยุดติดตามตำแหน่งแล้ว');
        return;
      }
      window.Alerts.startTracking((msg) => {
        window.UI.toast(msg, 'warn');
        window.UI.syncStatusButtons();
      });
      window.Store.setFollowing(true);
      window.UI.syncStatusButtons();
      window.UI.toast('กำลังขอตำแหน่งจากอุปกรณ์…');
    });

    $('#btnSim').addEventListener('click', () => {
      window.Alerts.ensureAudio();
      const running = window.Alerts.toggleSimulation();
      window.Store.setFollowing(running);
      window.UI.syncStatusButtons();
      window.UI.toast(running ? 'เริ่มจำลองการขับตามเส้นทางสาธิต' : 'หยุดจำลองการขับแล้ว');
    });
  }

  /* ---------- ปุ่มควบคุมแผนที่ ---------- */

  function wireMapControls() {
    $('#btnCompass').addEventListener('click', () => window.MapView.resetNorth());
    $('#btn3D').addEventListener('click', () => window.MapView.toggle3D());
    $('#btnZoomIn').addEventListener('click', () => window.MapView.zoomBy(1));
    $('#btnZoomOut').addEventListener('click', () => window.MapView.zoomBy(-1));

    $('#btnLayers').addEventListener('click', (e) => {
      const next = window.MapView.getStyleMode() === 'vector' ? 'satellite' : 'vector';
      window.MapView.setStyleMode(next);
      e.currentTarget.classList.toggle('is-active', next === 'satellite');
      window.UI.toast(next === 'satellite' ? 'มุมมองดาวเทียม' : 'มุมมองแผนที่ 3 มิติ');
    });

    $('#btnLocate').addEventListener('click', () => {
      const pos = window.Store.state.userPosition;
      if (!pos) {
        window.UI.toast('ยังไม่ทราบตำแหน่ง — กด “เริ่มติดตามตำแหน่ง” ก่อน', 'warn');
        return;
      }
      window.Store.setFollowing(true);
      window.MapView.followUser(pos, window.Store.state.userHeading);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
