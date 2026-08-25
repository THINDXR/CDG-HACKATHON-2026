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
    wireNavigation();

    window.MapView.onMarkerClick = (id) => {
      window.Store.select(id);
      const r = window.Store.state.reports.find((x) => x.id === id);
      if (r) window.MapView.flyToReport(r, { zoom: Math.max(window.MapView.instance.getZoom(), 16.5) });
      // กดหมุดบนแผนที่ก็ให้แผ่นเปิดมาแสดงรายละเอียดเช่นเดียวกับกดจากรายการ
      window.UI.showDetailSheet();
    };

    window.MapView.onReady(() => {
      window.MapView.refreshHazards();
      // เปิดมาให้เห็นหมุดภัยทันที ไม่ต้องเลื่อนหาเอง
      window.MapView.fitToHazards();
      window.UI.renderList();
      locateOnStart();
    });

    // อัปเดตเวลา "กี่นาทีที่แล้ว" และล้างรายงานหมดอายุ
    setInterval(() => {
      window.Store.prune();
      window.UI.renderList();
    }, 60 * 1000);
  }

  /* ---------- หาตำแหน่งตอนเปิดแอป ---------- */

  // ไกลกว่านี้ถือว่าข้อมูลตัวอย่างไม่เกี่ยวกับผู้ใช้เลย (เมตร)
  const FAR_FROM_DATA = 50000;

  /**
   * ขอตำแหน่งครั้งเดียวตอนเปิด เพื่อให้แผนที่เริ่มที่ "รอบตัวคุณ"
   * ไม่ใช่พิกัดตายตัว ถ้าผู้ใช้ปฏิเสธก็ยังใช้มุมกล้องจากข้อมูลภัยตามเดิม
   */
  function locateOnStart() {
    if (!navigator.geolocation) {
      window.UI.toast('เบราว์เซอร์นี้ไม่รองรับการหาตำแหน่ง — เลื่อนแผนที่เองได้');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coord = [pos.coords.longitude, pos.coords.latitude];
        window.Store.setUserPosition(coord, pos.coords.heading);
        window.MapView.setUserPuck(coord, pos.coords.heading);
        window.MapView.followUser(coord, pos.coords.heading);
        warnIfFarFromData(coord);
      },
      () => {
        window.UI.toast('ยังไม่ได้เปิดตำแหน่ง — แตะปุ่ม 📍 เพื่อดูภัยรอบตัวคุณ');
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  }

  /** ข้อมูลตัวอย่างอยู่ในกรุงเทพฯ ถ้าผู้ใช้อยู่ไกลจะไม่เห็นอะไรเลย จึงบอกให้ชัด */
  function warnIfFarFromData(coord) {
    const reports = window.Store.state.reports;
    if (!reports.length) return;
    const nearest = Math.min(
      ...reports.map((r) => U.distance(coord, [r.lng, r.lat]))
    );
    if (nearest > FAR_FROM_DATA) {
      window.UI.toast('ยังไม่มีรายงานใกล้คุณ — กด “แจ้งเหตุ” เพื่อเพิ่มจุดแรก', 'warn');
    }
  }

  /* ---------- เชื่อม Store กับหน้าจอ ---------- */

  function wireNavigation() {
    window.Navigate.onChange = () => {
      window.UI.renderNav();
      const route = window.Navigate.route;
      window.MapView.setNavRoute(route ? route.coordinates : null);
    };

    window.Navigate.onFinish = (dest) => {
      window.UI.stopNavigation();
      window.UI.toast(`ถึง${dest?.label || 'จุดหมาย'}แล้ว 🏁`, 'success');
    };
  }

  function wireStore() {
    window.Store.subscribe((state, reason) => {
      if (reason === 'filter') window.UI.syncFilters();
      if (reason === 'load' || reason === 'reset') window.UI.syncFilters();

      if (reason !== 'position') {
        window.MapView.refreshHazards();
        window.UI.renderList();
        window.UI.renderDetail();
      }

      if (reason === 'position') {
        window.MapView.setUserPuck(state.userPosition, state.userHeading);

        if (window.Navigate.isActive) {
          // ขณะนำทาง กล้องเกาะรถและหันตามทิศเสมอ ไม่ต้องรอโหมดตามตำแหน่ง
          window.Navigate.update(state.userPosition);
          window.MapView.navCamera(state.userPosition, state.userHeading);
        } else if (state.following) {
          window.MapView.followUser(state.userPosition, state.userHeading);
        }

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
        const pos = window.Store.state.userPosition;
        // กำลังติดตามแต่เลื่อนแผนที่ออกไปแล้ว — แตะครั้งแรกให้กลับมาที่ตัวเอง
        if (pos && !window.Store.state.following) {
          window.Store.setFollowing(true);
          window.MapView.followUser(pos, window.Store.state.userHeading);
          return;
        }
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

    $('#setSim').addEventListener('change', () => {
      window.Alerts.ensureAudio();
      const running = window.Alerts.toggleSimulation();
      window.Store.setFollowing(running);
      window.UI.syncStatusButtons();
      window.UI.toast(running ? 'เริ่มจำลองการขับตามเส้นทางสาธิต' : 'หยุดจำลองการขับแล้ว');
    });
  }

  /* ---------- ปุ่มควบคุมแผนที่ ---------- */

  function wireMapControls() {
    $('#btnZoomIn').addEventListener('click', () => window.MapView.zoomBy(1));
    $('#btnZoomOut').addEventListener('click', () => window.MapView.zoomBy(-1));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
