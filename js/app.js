/* จุดเริ่มต้นแอป: ประกอบ Store + MapView + Alerts + UI เข้าด้วยกัน */
(function () {
  const U = window.Utils;
  const { $ } = U;

  // ตำแหน่งอัปเดตถี่มาก (โดยเฉพาะโหมดจำลอง) จึงหน่วงการวาดรายการไว้
  let lastListRender = 0;
  const LIST_RENDER_MS = 2000;

  function boot() {
    // เติมไอคอน SVG ให้ element ที่ประกาศ data-icon ไว้ในหน้า HTML
    window.Icons.paint();

    window.Store.load();
    window.MapView.init('map');
    window.UI.bind();
    window.UI.renderList();
    window.UI.syncStatusButtons();

    wireStore();
    wireAlerts();
    wireMapControls();
    wireNavigation();

    /*
     * ประเมินความเสี่ยงของวันนี้ทันที ไม่รอ GPS
     *
     * โมเดลทำนายระดับจังหวัด จึงต้องอิงจังหวัดที่ผู้ใช้อยู่จริง ถ้ายังไม่รู้ตำแหน่ง
     * ใช้จุดกึ่งกลางแผนที่แทน — ซึ่งก็คือบริเวณที่ผู้ใช้กำลังดูอยู่
     * พอ GPS มาหรือผู้ใช้เลื่อนแผนที่ข้ามจังหวัด การ์ดจะอัปเดตตาม
     */
    window.AIUI.updateFor(forecastOrigin());

    window.MapView.onMarkerClick = (id) => {
      window.Store.select(id);
      // กดหมุดบนแผนที่ก็ให้แผ่นเปิดมาแสดงรายละเอียดเช่นเดียวกับกดจากรายการ
      // ต้องกางแผ่นก่อนบิน กล้องจะได้เล็งหมุดไว้เหนือแผ่น ไม่ใช่ไปอยู่หลังมัน
      window.UI.showDetailSheet();
      const r = window.Store.state.reports.find((x) => x.id === id);
      if (r) window.MapView.flyToReport(r, { zoom: Math.max(window.MapView.instance.getZoom(), 16.5) });
    };

    window.MapView.onReady(() => {
      window.MapView.refreshHazards();
      // เปิดมาให้เห็นหมุดภัยทันที ไม่ต้องเลื่อนหาเอง
      window.MapView.fitToHazards();
      window.UI.renderList();
      initHotspots();
      locateOnStart();

      /*
       * ยังไม่รู้ตำแหน่งจริง = ผู้ใช้กำลังสำรวจด้วยการเลื่อนแผนที่
       * ทั้งความเสี่ยงรอบตัวและโมเดลพยากรณ์จึงต้องตามจุดที่กำลังดูอยู่
       * (ถ้าเปิด GPS แล้ว ปล่อยให้สัญญาณตำแหน่งเป็นตัวสั่งแทน จะได้ไม่ตีกัน)
       */
      window.MapView.instance.on('moveend', () => {
        if (window.Store.state.userPosition) return;
        window.UI.renderList();
        window.AIUI.updateFor(forecastOrigin());
      });
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
        window.Store.setUserPosition(coord, pos.coords.heading, pos.coords.speed);
        window.MapView.setUserPuck(coord, pos.coords.heading);
        window.MapView.followUser(coord, pos.coords.heading);
        warnIfFarFromData(coord);
      },
      () => {
        window.UI.toast('ยังไม่ได้เปิดตำแหน่ง — แตะปุ่มตำแหน่งทางขวาของแผนที่ เพื่อดูภัยรอบตัวคุณ');
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
    // เส้นทางล่าสุดที่ตั้งตัวกรองไว้ ใช้เช็คว่าต้องคำนวณชุดหมุดใหม่หรือยัง
    let filteredForRoute = null;

    window.Navigate.onChange = () => {
      window.UI.renderNav();

      /*
       * onChange ยิงทุกครั้งที่ตำแหน่งขยับ แต่ทั้งเส้นทางบนแผนที่และชุดจุดเสี่ยง
       * เปลี่ยนเฉพาะตอนเส้นทางเปลี่ยน (เริ่มนำทาง / คำนวณใหม่ / จบ)
       * จึงเทียบตัวเส้นทางก่อน แล้วค่อยวาดใหม่ทีเดียว
       */
      const route = window.Navigate.route;
      if (route === filteredForRoute) return;
      filteredForRoute = route;

      const analysis = window.Navigate.analysis;

      // เส้นทางระบายสีตามความเสี่ยงของแต่ละช่วงถนน
      window.MapView.setNavRoute(
        route ? route.coordinates : null,
        route ? window.RouteRisk.segments(analysis) : null
      );

      // และแผนที่โชว์เฉพาะจุดเสี่ยงที่อยู่บนเส้นทางที่จะวิ่งผ่านจริง
      // จุดอื่นทั้งเมืองไม่เกี่ยวกับการขับตอนนี้ มีแต่จะรกและดึงสายตา
      window.Store.setRouteFilter(
        route && analysis?.points ? analysis.points.map((p) => p.report.id) : null
      );

      // จุดเสี่ยงจากสถิติก็ต้องกรองด้วยเกณฑ์เดียวกัน ไม่งั้นซ่อนหมุดรายงานไปแล้ว
      // แต่ยังมีวงจุดสถิติเต็มเมืองค้างอยู่ ซึ่งรกกว่าเดิมอีก
      window.Hotspots.setRouteFilter(route ? route.coordinates : null);
    };

    window.Navigate.onFinish = (dest) => {
      window.UI.stopNavigation();
      window.UI.toast(`ถึง${dest?.label || 'จุดหมาย'}แล้ว 🏁`, 'success');
    };

    // จุดเสี่ยงที่อยู่บนเส้นทางข้างหน้า (null = ไม่มีจุดไหนใกล้แล้ว)
    window.Navigate.onHazard = (hit) => window.UI.showNavHazard(hit);
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
          window.Navigate.update(state.userPosition);
          /*
           * มาตรวัดความเร็วต้องเดินตามตำแหน่งเสมอ ไม่ใช่ตามความคืบหน้าของเส้นทาง
           * เพราะ Navigate.update() จะไม่ยิง onChange ตอนหลุดเส้นทาง (มันไปเข้า
           * recalculate แทน) ถ้าพึ่ง onChange อย่างเดียว เข็มจะค้างอยู่ที่ค่าเดิม
           */
          window.UI.renderNavStatus();
          // กล้องเกาะลูกศรเฉพาะตอนที่ยังล็อกอยู่ ถ้าผู้ใช้เลื่อนแผนที่เองจะปล่อยให้ดูอิสระ
          if (state.following) {
            window.MapView.navCamera(state.userPosition, state.userHeading);
          }
        } else if (state.following) {
          window.MapView.followUser(state.userPosition, state.userHeading);
        }

        window.Alerts.check(state.userPosition, state.userHeading);
        if (Date.now() - lastListRender > LIST_RENDER_MS) {
          lastListRender = Date.now();
          window.UI.renderList();
        }

        // โมเดลทำนายระดับจังหวัด เรียกทุกครั้งได้ มันจะข้ามเองถ้ายังอยู่จังหวัดเดิม
        window.AIUI.updateFor(state.userPosition);
      }

      if (reason === 'following' || reason === 'simulating') {
        window.UI.syncStatusButtons();
        // เลิก/กลับมาล็อกกล้อง มีผลกับปุ่ม "กลับไปตำแหน่งฉัน"
        if (window.Navigate.isActive) window.UI.renderNav();
      }
    });
  }

  /* ---------- เชื่อมระบบเตือน ---------- */

  function wireAlerts() {
    window.Alerts.onAlert = (item) => {
      // แบนเนอร์มีไอคอนอยู่แล้ว ส่วน toast รับได้แค่ข้อความล้วน
      // (ถ้าใส่ item.def.icon ซึ่งเป็นมาร์กอัป SVG จะกลายเป็นโค้ดโผล่บนจอ)
      window.UI.showAlert(item);
      window.UI.toast(item.message, 'warn');
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

    // เปิดโหมดจำลอง = เข้าหน้านำทางไปเลย (UI เป็นคนจัดเส้นทาง กล้อง และแผ่นให้)
    $('#setSim').addEventListener('change', () => window.UI.toggleSimulationDrive());
  }

  /* ---------- ปุ่มควบคุมแผนที่ ---------- */

  function wireMapControls() {
    // ปุ่มซูม +/- แบบเดียวกับ Google Maps (นิ้วหุบ-กางก็ยังใช้ได้ตามเดิม)
    $('#btnZoomIn').addEventListener('click', () => window.MapView.zoomBy(1));
    $('#btnZoomOut').addEventListener('click', () => window.MapView.zoomBy(-1));

    // ปุ่มพากลับไปที่หัวลูกศรของเรา ใช้ได้ทั้งหน้าแผนที่และระหว่างนำทาง
    $('#btnMyLocation').addEventListener('click', () => window.UI.goToMyLocation());

    $('#btnCompass').addEventListener('click', () => {
      window.MapView.resetNorth();
      window.UI.toast('หันกลับไปทางทิศเหนือแล้ว');
    });

  }

  /*
   * จุดอ้างอิงของโมเดลพยากรณ์ — ตำแหน่งจริงมาก่อนเสมอ
   * ถ้ายังไม่รู้ ใช้กลางแผนที่ซึ่งคือพื้นที่ที่ผู้ใช้กำลังสนใจอยู่
   */
  function forecastOrigin() {
    const s = window.Store.state;
    if (s.userPosition) return s.userPosition;
    const map = window.MapView.instance;
    if (map) {
      const c = map.getCenter();
      return [c.lng, c.lat];
    }
    return window.APP_CONFIG.DEFAULT_CENTER;
  }

  /* ---------- จุดเสี่ยงจากสถิติจริง ---------- */

  /*
   * เปิดชั้นนี้ให้ตั้งแต่แรก เพราะเป็นข้อมูลจริงที่มีค่าที่สุดในแอป
   * (อุบัติเหตุจริง 100,056 เหตุการณ์ ปี 2565-2569) ถ้าซ่อนไว้หลังปุ่ม
   * ผู้ใช้ส่วนใหญ่จะไม่มีวันกดเจอ แล้วเห็นแต่รายงานตัวอย่างไม่กี่จุด
   *
   * ล้มเหลวก็แค่ไม่มีชั้นนี้ ปุ่มดับลง แอปอื่น ๆ ทำงานตามปกติ
   */
  function initHotspots() {
    window.Hotspots.onSelect = (h) => window.UI.showHotspot(h);

    /*
     * ให้ Store คิดคะแนน "ความปลอดภัยรอบตัว" จากจุดเสี่ยงจริงด้วย
     *
     * ก่อนหน้านี้คิดจากรายงานของผู้ใช้อย่างเดียว ซึ่งเป็นข้อมูลตัวอย่างในกรุงเทพฯ
     * ใครอยู่นอกนั้นจะเห็น "ปลอดภัย 100% · 0 จุดใกล้เคียง" ตลอด ทั้งที่ไม่จริง
     * จุดสถิติมีครบทั้งประเทศ จึงตอบได้ทุกที่ที่ผู้ใช้ยืนอยู่
     */
    window.Store.setHotspotProvider((origin, radius) =>
      window.Hotspots.near(origin, radius, 40),
    );

    window.Hotspots.enable()
      .then(() => {
        const meta = window.Hotspots.meta();
        window.UI.toast(
          `จุดเสี่ยงจากสถิติจริง ${meta.count.toLocaleString('th-TH')} จุด ` +
            `(${meta.range.from.slice(0, 4)}–${meta.range.to.slice(0, 4)})`,
        );
        // ข้อมูลเพิ่งมาถึง คะแนนรอบตัวเปลี่ยนแล้ว ต้องวาดใหม่
        window.UI.renderList();
      })
      .catch((err) => {
        // ไม่มีปุ่มให้ผู้ใช้เปิดเองแล้ว ล้มก็แค่ไม่มีชั้นนี้ ไม่ต้องแจ้งอะไร
        console.warn('ชั้นจุดเสี่ยงใช้งานไม่ได้:', err.message);
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
