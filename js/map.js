/* แผนที่ (MapLibre GL) — ค่าเริ่มต้นเป็น 2 มิติพื้นทึบ สลับดูแผนที่จริง/ดาวเทียมได้ */
window.MapView = (function () {
  const CFG = window.APP_CONFIG;
  const U = window.Utils;

  let map = null;
  let ready = false;
  const readyQueue = [];
  // vector = แผนที่จริง (ค่าเริ่มต้น), plain = พื้นทึบไม่มี tile, satellite = ภาพถ่าย
  let styleMode = 'vector';
  let markers = new Map(); // id -> maplibregl.Marker
  let userMarker = null;
  let destMarker = null;
  let pulseFrame = null;
  let onMarkerClick = () => {};
  let onMapClick = () => {};
  let pickMode = false;

  /**
   * สไตล์พื้นทึบ — ไม่มี tile ถนน แม่น้ำ หรือชื่อสถานที่เลย
   * เหลือแต่พื้นสีเดียวให้หมุดแจ้งเหตุลอยอยู่ตามพิกัดจริง ตามดีไซน์ที่ต้องการ
   */
  function plainStyle() {
    return {
      version: 8,
      sources: {},
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#151a21' } },
      ],
    };
  }

  function styleFor(mode) {
    if (mode === 'satellite') return satelliteStyle();
    if (mode === 'vector') return CFG.STYLE_VECTOR;
    return plainStyle();
  }

  /* ---------- สร้างสไตล์ดาวเทียม (raster ล้วน) ---------- */
  function satelliteStyle() {
    return {
      version: 8,
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      sources: {
        satellite: {
          type: 'raster',
          tiles: [CFG.SATELLITE_TILES],
          tileSize: 256,
          maxzoom: 19,
          attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
        },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#0b1120' } },
        { id: 'satellite', type: 'raster', source: 'satellite' },
      ],
    };
  }

  /* ---------- init ---------- */

  function init(containerId) {
    map = new maplibregl.Map({
      container: containerId,
      style: styleFor(styleMode),
      center: CFG.DEFAULT_CENTER,
      zoom: CFG.DEFAULT_ZOOM,
      // ดีไซน์เป็นแผนที่ 2 มิติ จึงไม่เอียงกล้องและไม่หมุน
      pitch: 0,
      bearing: 0,
      maxPitch: 85,
      antialias: true,
      attributionControl: false,
      hash: false,
    });

    // มุมขวาล่างมีปุ่มแจ้งเหตุอยู่แล้ว จึงย้ายที่มาข้อมูลไปมุมซ้ายล่าง
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

    map.on('style.load', () => {
      applySceneEnhancements();
      addHazardLayers();
      refreshHazards();
      // ตอน style.load บางครั้ง source ยังไม่พร้อม วงรัศมีจึงยังว่าง — วาดซ้ำเมื่อนิ่งแล้ว
      map.once('idle', refreshHazards);
      if (!ready) {
        ready = true;
        readyQueue.splice(0).forEach((fn) => fn());
      }
    });

    map.on('click', (e) => {
      if (pickMode) {
        onMapClick([e.lngLat.lng, e.lngLat.lat]);
      }
    });

    map.on('rotate', updateCompass);
    map.on('pitch', updateCompass);
    map.on('move', updateMarkerView);
    map.on('zoom', updateMarkerView);

    // ผู้ใช้ลากแผนที่เอง = เลิกโหมดตามตำแหน่ง
    map.on('dragstart', () => {
      if (window.Store.state.following) window.Store.setFollowing(false);
    });

    startPulse();
    return map;
  }

  function onReady(fn) {
    if (ready) fn();
    else readyQueue.push(fn);
  }

  /* ---------- ฉากสามมิติ ---------- */

  function applySceneEnhancements() {
    // มุมมองเป็น 2 มิติมองจากด้านบน จึงไม่ต้องมีภูมิประเทศ ท้องฟ้า หรืออาคาร 3 มิติ
    try { map.setTerrain(null); } catch (_) { /* ไม่มี terrain อยู่แล้ว */ }
    return;

    // ภูมิประเทศจากข้อมูลความสูงแบบเปิด
    try {
      if (!map.getSource('terrain-dem')) {
        map.addSource('terrain-dem', {
          type: 'raster-dem',
          tiles: [CFG.TERRAIN_TILES],
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 14,
          attribution: 'Elevation © Mapzen / AWS Terrain Tiles',
        });
      }
      map.setTerrain({ source: 'terrain-dem', exaggeration: 1.15 });
    } catch (_) {
      /* ถ้าโหลด DEM ไม่ได้ ให้ใช้แผนที่แบบราบต่อไปได้ */
    }

    // ท้องฟ้าและหมอกระยะไกล ให้ความรู้สึกลึกแบบแผนที่ 3 มิติ
    try {
      map.setSky({
        'sky-color': '#111a2c',
        'sky-horizon-blend': 0.6,
        'horizon-color': '#243247',
        'horizon-fog-blend': 0.7,
        'fog-color': '#0b0f18',
        'fog-ground-blend': 0.05,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 12, 0.4, 16, 0.1],
      });
    } catch (_) {
      /* สไตล์เก่าอาจไม่รองรับ sky */
    }

    if (styleMode === 'vector') add3DBuildings();
  }

  function add3DBuildings() {
    if (map.getLayer('roadwarn-3d-buildings')) return;
    if (!map.getSource('openmaptiles')) return;

    // แทรกใต้เลเยอร์ตัวอักษร เพื่อให้ชื่อถนนยังอ่านออก
    let firstSymbol;
    for (const layer of map.getStyle().layers) {
      if (layer.type === 'symbol') { firstSymbol = layer.id; break; }
    }

    map.addLayer(
      {
        id: 'roadwarn-3d-buildings',
        source: 'openmaptiles',
        'source-layer': 'building',
        type: 'fill-extrusion',
        minzoom: 13,
        paint: {
          'fill-extrusion-color': [
            'interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 10],
            0, '#232b3d',
            40, '#2e384e',
            120, '#3b475f',
          ],
          'fill-extrusion-height': [
            'interpolate', ['linear'], ['zoom'],
            13, 0,
            15.5, ['coalesce', ['get', 'render_height'], 10],
          ],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.92,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      firstSymbol
    );
  }

  /* ---------- เลเยอร์ภัย ---------- */

  // ต่ำกว่านี้วงรัศมีเล็กจนไม่สื่อความหมาย มีแต่ทำให้จอรก จึงซ่อนไปเลย
  const ZONE_MIN_ZOOM = 12.5;

  function addHazardLayers() {
    if (!map.getSource('hazard-zones')) {
      map.addSource('hazard-zones', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    // แสงเรืองรอบขอบเขตพื้นที่เสี่ยง — ติดอยู่กับพื้นแผนที่ ไม่เลื่อนตามจอ
    // ความหนาต้องผูกกับระดับซูม ไม่งั้นตอนซูมออกวงจะกลายเป็นก้อนเบลอเต็มจอ
    if (!map.getLayer('hazard-zone-glow')) {
      map.addLayer({
        id: 'hazard-zone-glow',
        type: 'line',
        source: 'hazard-zones',
        minzoom: ZONE_MIN_ZOOM,
        paint: {
          'line-color': ['get', 'color'],
          // ซูมใกล้มาก วงจะใหญ่จนแสงเรืองกลายเป็นแผ่นแดงทับทั้งจอ จึงบางลงอีกครั้ง
          'line-width': [
            'interpolate', ['linear'], ['zoom'],
            ZONE_MIN_ZOOM, 3,
            15, ['case', ['get', 'selected'], 18, 10],
            17.5, ['case', ['get', 'selected'], 7, 4],
          ],
          'line-blur': [
            'interpolate', ['linear'], ['zoom'],
            ZONE_MIN_ZOOM, 2,
            15, ['case', ['get', 'selected'], 14, 9],
            17.5, ['case', ['get', 'selected'], 5, 3],
          ],
          'line-opacity': [
            'interpolate', ['linear'], ['zoom'],
            ZONE_MIN_ZOOM, 0,
            14, ['case', ['get', 'selected'], 0.55, 0.34],
            17.5, ['case', ['get', 'selected'], 0.28, 0.16],
          ],
        },
      });
    }
    if (!map.getLayer('hazard-zone-fill')) {
      map.addLayer({
        id: 'hazard-zone-fill',
        type: 'fill',
        source: 'hazard-zones',
        minzoom: ZONE_MIN_ZOOM,
        paint: {
          'fill-color': ['get', 'color'],
          // ซูมใกล้ วงรัศมีจะกินทั้งจอ จึงจางลงตามระดับซูม
          'fill-opacity': [
            'interpolate', ['linear'], ['zoom'],
            ZONE_MIN_ZOOM, 0,
            13.5, ['case', ['get', 'selected'], 0.22, 0.12],
            16.5, ['case', ['get', 'selected'], 0.07, 0.035],
            18, ['case', ['get', 'selected'], 0.04, 0.02],
          ],
        },
      });
    }
    if (!map.getLayer('hazard-zone-line')) {
      map.addLayer({
        id: 'hazard-zone-line',
        type: 'line',
        source: 'hazard-zones',
        minzoom: ZONE_MIN_ZOOM,
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['get', 'selected'], 2.5, 1.2],
          'line-opacity': [
            'interpolate', ['linear'], ['zoom'],
            ZONE_MIN_ZOOM, 0,
            13.5, ['case', ['get', 'selected'], 0.9, 0.45],
          ],
        },
      });
    }

    if (!map.getSource('pulse-ring')) {
      map.addSource('pulse-ring', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getLayer('pulse-ring-line')) {
      map.addLayer({
        id: 'pulse-ring-line',
        type: 'line',
        source: 'pulse-ring',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 3,
          'line-opacity': ['get', 'opacity'],
        },
      });
    }

    if (!map.getSource('sim-route')) {
      map.addSource('sim-route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getLayer('sim-route-line')) {
      map.addLayer({
        id: 'sim-route-line',
        type: 'line',
        source: 'sim-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#0a84ff',
          'line-width': 7,
          'line-opacity': 0.75,
          'line-blur': 0.5,
        },
      });
    }

    addNavRouteLayers();
  }

  /* ---------- เส้นทางนำทาง ---------- */

  /** เส้นทางแบบ Waze: เส้นขอบเข้มด้านล่าง ทับด้วยเส้นม่วงสว่างด้านบน */
  function addNavRouteLayers() {
    if (!map.getSource('nav-route')) {
      map.addSource('nav-route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getLayer('nav-route-casing')) {
      map.addLayer({
        id: 'nav-route-casing',
        type: 'line',
        source: 'nav-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#2a1a55',
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 8, 16, 20, 18, 30],
          'line-opacity': 0.9,
        },
      });
    }
    if (!map.getLayer('nav-route-line')) {
      map.addLayer({
        id: 'nav-route-line',
        type: 'line',
        source: 'nav-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          /*
           * สีตามระดับความเสี่ยงของช่วงถนนนั้น (คล้ายเส้นสีของ Google Maps
           * แต่ของเราหมายถึง "ช่วงนี้อันตราย" ไม่ใช่ "ช่วงนี้รถติด")
           * ช่วงที่ไม่มีจุดเสี่ยงใช้สีม่วงประจำโหมดนำทางตามเดิม
           */
          'line-color': [
            'match', ['get', 'level'],
            'high', '#ff3b30',
            'medium', '#ff9f0a',
            '#8b5cf6',
          ],
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 5, 16, 14, 18, 22],
        },
      });
    }
  }

  /** วาด/ลบเส้นทางนำทาง — ส่ง null เพื่อล้าง */
  /**
   * @param {Array} coordinates พิกัดตลอดเส้นทาง
   * @param {Array} [segments] ช่วงถนนพร้อมระดับความเสี่ยง จาก RouteRisk.segments()
   *   ถ้าไม่ส่งมา จะวาดเป็นเส้นม่วงเส้นเดียวตามเดิม
   */
  function setNavRoute(coordinates, segments) {
    if (!map) return;
    addNavRouteLayers();
    const src = map.getSource('nav-route');
    if (!src) return;

    const empty = { type: 'FeatureCollection', features: [] };
    const plain = coordinates && coordinates.length
      ? {
          type: 'FeatureCollection',
          features: [{
            type: 'Feature',
            properties: { level: 'low' },
            geometry: { type: 'LineString', coordinates },
          }],
        }
      : empty;

    src.setData(
      segments && segments.length
        ? {
            type: 'FeatureCollection',
            features: segments.map((s) => ({
              type: 'Feature',
              properties: { level: s.level },
              geometry: { type: 'LineString', coordinates: s.coordinates },
            })),
          }
        : plain
    );

    if (destMarker) {
      destMarker.remove();
      destMarker = null;
    }
    if (coordinates && coordinates.length) {
      const node = U.el('div', 'dest-marker');
      node.appendChild(U.el('span', 'dest-marker__pin', '🏁'));
      destMarker = new maplibregl.Marker({ element: node, anchor: 'bottom' })
        .setLngLat(coordinates[coordinates.length - 1])
        .addTo(map);
    }
  }

  /** ปรับกล้องให้เห็นเส้นทางทั้งเส้น ใช้ตอนเริ่มนำทาง */
  function fitRoute(coordinates) {
    if (!map || !coordinates?.length) return;
    const lngs = coordinates.map((c) => c[0]);
    const lats = coordinates.map((c) => c[1]);
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: { top: 170, bottom: 210, left: 50, right: 50 }, maxZoom: 16, duration: 900 }
    );
  }

  /**
   * มุมกล้องแบบนำทาง: หันจอไปตามทิศที่รถวิ่ง เพื่อให้ "ขึ้นบนจอ = ข้างหน้ารถ"
   *
   * ตำแหน่งอัปเดตถี่กว่าความยาวอนิเมชัน ถ้าใช้ easeTo ยาว ๆ ทุกครั้ง
   * กล้องจะถูกสั่งใหม่ก่อนหมุนถึงเป้า ทำให้ bearing ตามหลัง heading ตลอด
   * และหัวลูกศรจะเอียงไม่ตรงกับทิศจอ จึงใช้อนิเมชันสั้นให้ไล่ทัน
   *
   * @param {boolean} [snap] true = เข้าโหมดนำทางครั้งแรก ให้จัดซูม/มุมทีเดียว
   */
  function navCamera(coord, heading, snap = false) {
    if (!map || !coord) return;

    const target = typeof heading === 'number' ? heading : map.getBearing();
    const camera = {
      center: coord,
      bearing: target,
      // เลื่อนจุดศูนย์กลางลงล่าง ให้เห็นถนนข้างหน้ามากกว่าข้างหลัง
      padding: { top: 240, bottom: 0, left: 0, right: 0 },
    };

    if (snap) {
      // ครั้งแรกค่อยจัดซูมกับมุมก้ม หลังจากนั้นปล่อยให้ผู้ใช้ซูมเองได้
      camera.zoom = 17;
      camera.pitch = 0;
      camera.duration = 700;
    } else {
      camera.duration = 300;
    }

    map.easeTo(camera);
  }

  /**
   * วาดหมุดและวงรัศมีใหม่ทั้งหมดตามข้อมูลปัจจุบัน
   *
   * หมุดเป็น DOM overlay จึงวาดได้ทันทีโดยไม่ต้องรอสไตล์
   * มีแต่วงรัศมี (GeoJSON source) ที่ต้องรอ ถ้ารอทั้งฟังก์ชันจะเจอกรณี
   * isStyleLoaded() ยังเป็น false ตอนเรียกครั้งแรก แล้วหมุดไม่ขึ้นเลยจนกว่าจะมีอะไรเปลี่ยน
   */
  function refreshHazards() {
    if (!map) return;

    const reports = window.Store.visibleReports();
    const selectedId = window.Store.state.selectedId;
    const seen = new Set();

    for (const r of reports) {
      seen.add(r.id);
      let marker = markers.get(r.id);
      if (!marker) {
        const node = buildMarkerElement(r);
        marker = new maplibregl.Marker({
          element: node,
          anchor: 'bottom',
          pitchAlignment: 'viewport',
          rotationAlignment: 'viewport',
        })
          .setLngLat([r.lng, r.lat])
          .addTo(map);
        markers.set(r.id, marker);
      } else {
        marker.setLngLat([r.lng, r.lat]);
      }
      marker.getElement().classList.toggle('is-selected', r.id === selectedId);
      marker.getElement().dataset.severity = r.severity;
    }

    for (const [id, marker] of markers) {
      if (!seen.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    }

    const zones = {
      type: 'FeatureCollection',
      features: reports.map((r) => ({
        type: 'Feature',
        properties: {
          color: CFG.HAZARD_TYPES[r.type].color,
          selected: r.id === selectedId,
        },
        geometry: U.circlePolygon([r.lng, r.lat], r.radius),
      })),
    };
    // ต้องอัปเดตทุกครั้งที่ source มีอยู่ ไม่ผูกกับ isStyleLoaded()
    // ไม่งั้นตอนลบรายงานแล้วสไตล์ยังโหลดไม่นิ่ง วงรัศมีของจุดที่ลบไปจะค้างบนแผนที่
    const src = map.getSource('hazard-zones');
    if (src) {
      try {
        src.setData(zones);
      } catch (_) {
        // สไตล์กำลังสลับอยู่ — เดี๋ยว style.load จะเรียก refreshHazards ให้เอง
      }
    }

    updateMarkerView();
  }

  /**
   * ซ่อนหมุดที่ไม่ได้อยู่ในกรอบแผนที่ และปรับขนาดตามระดับซูม
   *
   * บนแผนที่เอียง จุดที่อยู่ "หลังกล้อง" จะถูกฉายกลับเข้ามาในจอ
   * ทำให้หมุดที่อยู่ไกลหลายสิบกิโลเมตรโผล่ลอยอยู่กลางจอและดูเหมือนเลื่อนตามผู้ใช้
   */
  function updateMarkerView() {
    if (!map || !markers.size) return;

    const zoom = map.getZoom();
    const canvas = map.getCanvas();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const margin = 130; // เผื่อขอบ ไม่ให้หมุดโผล่/หายกะทันหันตอนลากแผนที่

    const c = map.getCenter();
    const center = [c.lng, c.lat];
    // เมตรต่อพิกเซลคร่าว ๆ → ประเมินว่าจอครอบคลุมพื้นที่กว้างแค่ไหน
    const mpp = (156543.03392 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** zoom;
    // จำกัดเพดานไว้ ไม่ให้ตอนซูมออกสุดกลายเป็นไม่ตัดอะไรเลย
    const maxDistance = Math.min(mpp * Math.max(w, h) * 2, 200000);

    // ซูมเข้า = หมุดใหญ่ขึ้น อ่านง่ายขึ้น / ซูมออก = เล็กลงมาก ไม่ให้ทับกันจนรก
    const scale = Math.max(0.55, Math.min(1.45, 0.55 + (zoom - 10) * 0.13));

    const centerPt = map.project(center);
    const bearing = map.getBearing();

    for (const marker of markers.values()) {
      const node = marker.getElement();
      const ll = marker.getLngLat();
      const coord = [ll.lng, ll.lat];
      const pt = map.project(ll);

      // อยู่ในกรอบจอไหม (เผื่อขอบไว้กันหมุดกระพริบตอนลาก)
      const inFrame =
        pt.x >= -margin && pt.x <= w + margin && pt.y >= -margin && pt.y <= h + margin;

      const inRange = U.distance(center, coord) < maxDistance;

      /*
       * จุดที่อยู่เลยเส้นขอบฟ้าจะถูกฉายกลับด้านเข้ามาในจอ กลายเป็นหมุดเรียงกลางจอ
       * ตรวจโดยเทียบ "ทิศจริงบนพื้นโลก" กับ "ทิศบนจอ" ถ้าชี้กลับทางแปลว่าถูกฉายกลับ
       * (ใช้ทิศแทนการแปลงพิกัดกลับ เพราะ terrain ทำให้การแปลงกลับคลาดเคลื่อน)
       */
      const vx = pt.x - centerPt.x;
      const vy = pt.y - centerPt.y;
      const len = Math.hypot(vx, vy);
      let inFront = true;
      if (len > 1) {
        const rad = ((U.bearing(center, coord) - bearing) * Math.PI) / 180;
        inFront = (vx * Math.sin(rad) + vy * -Math.cos(rad)) / len > 0;
      }

      node.classList.toggle('is-offscreen', !(inFrame && inRange && inFront));
      node.style.setProperty('--marker-scale', scale.toFixed(2));
    }

    // ลูกศรตำแหน่งผู้ใช้ต้องโตตามซูมด้วย ไม่งั้นซูมเข้าไปแล้วจะดูเล็กจนหาไม่เจอ
    if (userMarker) {
      userMarker.getElement().style.setProperty('--puck-scale', scale.toFixed(2));
    }
  }

  function buildMarkerElement(report) {
    const def = CFG.HAZARD_TYPES[report.type];
    const wrap = U.el('div', 'hazard-marker');
    wrap.style.setProperty('--pin-color', def.color);
    wrap.dataset.id = report.id;
    // แยกให้เห็นชัดว่าเป็นรายงานจากคน หรือจุดที่ระบบคาดการณ์ไว้
    wrap.dataset.source = report.source || 'user';

    const pin = U.el('div', 'hazard-marker__pin');
    // def.icon เป็นมาร์กอัป SVG ต้องใช้ innerHTML ไม่ใช่ U.el(...) ที่ตั้ง textContent
    // ไม่งั้นหมุดจะกลายเป็นข้อความ "<svg class=..." กองอยู่บนแผนที่
    const icon = U.el('span', 'hazard-marker__icon');
    icon.innerHTML = def.icon;
    pin.appendChild(icon);

    // ป้ายบอกที่มา: คนแจ้งเอง vs ระบบคาดการณ์
    const badge = U.el('span', 'hazard-marker__badge');
    badge.innerHTML = window.Icons.get(
      (report.source || 'user') === 'predicted' ? 'spark' : 'person'
    );
    pin.appendChild(badge);

    const shadow = U.el('div', 'hazard-marker__shadow');
    wrap.append(pin, shadow);
    wrap.addEventListener('click', (e) => {
      e.stopPropagation();
      onMarkerClick(report.id);
    });
    return wrap;
  }

  /**
   * ขยับกล้องให้เห็นหมุดภัยทั้งหมดที่ผ่านตัวกรอง
   * ใช้ตอนเปิดแอป เพราะมุมกล้อง 3 มิติเริ่มต้นแคบจนหมุดมักหลุดออกนอกจอ
   */
  function fitToHazards({ duration = 0 } = {}) {
    if (!map) return false;
    const reports = window.Store.visibleReports();
    if (!reports.length) return false;

    const lngs = reports.map((r) => r.lng);
    const lats = reports.map((r) => r.lat);
    const camera = map.cameraForBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      // เผื่อที่ให้แถบค้นหาด้านบนกับแผ่นความปลอดภัยด้านล่างที่บังแผนที่อยู่จริง
      { padding: insetPadding({ left: 45, right: 45 }) }
    );
    if (!camera) return false;

    // รายงานอาจกระจายทั้งเมือง ถ้าย่อจนพอดีทุกจุดหมุดจะเล็กและอาคาร 3 มิติหาย
    // จึงตรึงระดับซูมไว้ในช่วงที่ยังเห็นหมุดชัดและยังเป็นมุมมองสามมิติ
    // พื้นทึบไม่มีถนนให้ดู จึงย่อได้มากกว่าเพื่อให้เห็นจุดแจ้งเหตุครบ ๆ
    const minZoom = styleMode === 'plain' ? 11.5 : 13.5;
    const zoom = Math.max(minZoom, Math.min(15.2, camera.zoom));
    // ดูภาพรวมทั้งเมืองต้องหันทิศเหนือ ถึงจะอ่านแผนที่ได้ตามปกติ
    headingUp = false;
    map.easeTo({
      center: camera.center,
      zoom,
      pitch: 0,
      bearing: 0,
      padding: insetPadding({ left: 45, right: 45 }),
      duration,
    });
    updateCompass();
    return true;
  }

  /* ---------- วงคลื่นเตือน (แอนิเมชัน) ---------- */

  function startPulse() {
    const period = 2200;
    function tick(t) {
      pulseFrame = requestAnimationFrame(tick);
      if (!map || !map.isStyleLoaded()) return;
      const src = map.getSource('pulse-ring');
      if (!src) return;

      // ซูมออกมากแล้ว คลื่นกระเพื่อมจะกลายเป็นจุดรก ๆ เต็มจอ จึงหยุดวาด
      const targets = map.getZoom() < ZONE_MIN_ZOOM
        ? []
        : window.Store
          .visibleReports()
          .filter((r) => r.severity === 'high' || r.id === window.Store.state.selectedId);

      if (!targets.length) {
        src.setData({ type: 'FeatureCollection', features: [] });
        return;
      }

      const phase = (t % period) / period;
      const features = targets.map((r) => ({
        type: 'Feature',
        properties: {
          color: CFG.HAZARD_TYPES[r.type].color,
          opacity: 0.75 * (1 - phase),
        },
        geometry: U.circlePolygon([r.lng, r.lat], Math.max(20, r.radius * phase), 48),
      }));
      src.setData({ type: 'FeatureCollection', features });
    }
    pulseFrame = requestAnimationFrame(tick);
  }

  /* ---------- ตำแหน่งผู้ใช้ ---------- */

  /*
   * ส่วนของจอที่ถูก UI อื่นบังอยู่ (แถบค้นหาด้านบน แผ่นความปลอดภัยด้านล่าง)
   *
   * แผนที่กินพื้นที่เต็มจอ ถ้าสั่งให้กล้อง "เล็งกลาง" ตรง ๆ จุดที่เล็งจะไปตกกลางจอจริง
   * ซึ่งอาจอยู่หลังแผ่นความปลอดภัย — หัวลูกศรของผู้ใช้เลยโดนแผ่นทับ
   * ใส่ค่านี้เป็น padding ให้ MapLibre กล้องจะเล็งกลาง "พื้นที่ที่มองเห็นจริง" แทน
   */
  let viewInsets = { top: 0, bottom: 0 };

  function setViewInsets(insets) {
    viewInsets = { top: 0, bottom: 0, ...insets };
  }

  /** padding สำหรับกล้อง คิดจากส่วนที่ UI บังอยู่ตอนนี้ */
  function insetPadding(extra = {}) {
    return {
      top: viewInsets.top,
      bottom: viewInsets.bottom,
      left: 0,
      right: 0,
      ...extra,
    };
  }

  function setUserPuck(coord, heading) {
    if (!map || !coord) return;
    if (!userMarker) {
      // หัวลูกศรชี้ไปตามทิศที่กำลังมุ่งหน้า พร้อมวงเรืองรอบ ๆ ให้หาเจอง่าย
      // ห้ามแตะ transform ของ .user-puck เพราะ MapLibre ใช้วางตำแหน่ง/หมุนตามทิศ
      // การย่อ-ขยายตามซูมจึงทำที่ชั้นลูก (.user-puck__inner) แทน
      const wrap = U.el('div', 'user-puck');
      wrap.innerHTML =
        '<div class="user-puck__inner">' +
        '<div class="user-puck__halo"></div>' +
        '<svg class="user-puck__arrow" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">' +
        '<path d="M16 3.5l9.5 22a1 1 0 0 1-1.4 1.2L16 22.4l-8.1 4.3a1 1 0 0 1-1.4-1.2z"/>' +
        '</svg></div>';
      userMarker = new maplibregl.Marker({
        element: wrap,
        pitchAlignment: 'map',
        rotationAlignment: 'map',
      })
        .setLngLat(coord)
        .addTo(map);
    }
    userMarker.setLngLat(coord);
    if (typeof heading === 'number') {
      userMarker.setRotation(heading);
      userMarker.getElement().classList.add('has-heading');
    }
    updateMarkerView();
  }

  /*
   * นอกโหมดนำทาง แผนที่จะหันทิศไหน มีสองแบบให้เลือก
   *
   *  - หันตามหัวลูกศร (headingUp) — เปิดเมื่อผู้ใช้กดปุ่มตำแหน่งของฉัน
   *    ลูกศรจะชี้ตรงขึ้นเสมอ ขนานกับถนนที่กำลังมุ่งหน้าไป
   *  - หันทิศเหนือ — กดปุ่มเข็มทิศเพื่อกลับมาโหมดนี้ อ่านชื่อถนนง่ายกว่า
   *
   * ระหว่างที่ตามตำแหน่งอยู่ต้องจำโหมดไว้ ไม่งั้นพอ GPS ขยับครั้งถัดไป
   * กล้องจะเด้งกลับไปทิศเดิมทันทีที่ผู้ใช้เพิ่งสั่งให้หัน
   */
  let headingUp = false;

  function followUser(coord, heading, opts = {}) {
    if (!map || !coord) return;
    if (typeof opts.headingUp === 'boolean') headingUp = opts.headingUp;

    const aligned = headingUp && typeof heading === 'number' && !Number.isNaN(heading);

    map.easeTo({
      center: coord,
      bearing: aligned ? heading : map.getBearing(),
      pitch: 0, // มุมมอง 2 มิติเสมอ
      zoom: Math.max(map.getZoom(), 16),
      // เล็งกลางพื้นที่ที่มองเห็น ไม่ใช่กลางจอ ไม่งั้นลูกศรไปอยู่หลังแผ่นความปลอดภัย
      padding: insetPadding(),
      duration: 900,
      easing: (t) => t * (2 - t),
    });
  }

  /* ---------- การควบคุมกล้อง ---------- */

  function flyToReport(report, opts = {}) {
    if (!map) return;
    map.flyTo({
      center: [report.lng, report.lat],
      zoom: opts.zoom ?? 17,
      pitch: opts.pitch ?? 65,
      bearing: opts.bearing ?? map.getBearing(),
      // หมุดต้องอยู่เหนือแผ่นรายละเอียดที่กำลังจะกางขึ้นมา ไม่ใช่ถูกมันบัง
      padding: insetPadding(),
      duration: 1200,
      essential: true,
    });
  }

  function toggle3D() {
    if (!map) return;
    const flat = map.getPitch() < 20;
    map.easeTo({ pitch: flat ? CFG.DEFAULT_PITCH : 0, duration: 700 });
    return flat;
  }

  function resetNorth() {
    // กดเข็มทิศ = เลิกหันตามหัวลูกศร ไม่งั้น GPS ขยับทีเดียวก็หมุนกลับไปอีก
    headingUp = false;
    map.easeTo({ bearing: 0, duration: 600 });
  }

  function zoomBy(delta) {
    map.easeTo({ zoom: map.getZoom() + delta, duration: 300 });
  }

  /**
   * เข็มทิศจะโผล่เฉพาะตอนแผนที่ถูกหมุนออกจากทิศเหนือ (เช่นระหว่างนำทาง)
   * เข็มหมุนสวนทางกับแผนที่ เพื่อให้ยังชี้ทิศเหนือจริงเสมอ
   */
  function updateCompass() {
    if (!map) return;
    const btn = document.getElementById('btnCompass');
    if (!btn) return;

    const bearing = map.getBearing();
    btn.hidden = Math.abs(bearing) < 1;

    const needle = btn.querySelector('.map-btn__needle');
    if (needle) needle.style.transform = `rotate(${-bearing}deg)`;
  }

  /* ---------- โหมดสไตล์ ---------- */

  function setStyleMode(mode) {
    if (!map || mode === styleMode) return;
    styleMode = mode;
    markers.forEach((m) => m.remove());
    markers.clear();
    map.setStyle(styleFor(mode), {
      diff: false,
    });
  }

  function getStyleMode() {
    return styleMode;
  }

  /* ---------- โหมดเลือกจุดบนแผนที่ ---------- */

  function setPickMode(on) {
    pickMode = on;
    if (map) map.getCanvas().style.cursor = on ? 'crosshair' : '';
    document.body.classList.toggle('picking', on);
  }

  function setSimRoute(coords) {
    if (!map || !map.getSource('sim-route')) return;
    map.getSource('sim-route').setData(
      coords && coords.length
        ? {
            type: 'FeatureCollection',
            features: [
              { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } },
            ],
          }
        : { type: 'FeatureCollection', features: [] }
    );
  }

  return {
    init,
    onReady,
    refreshHazards,
    fitToHazards,
    flyToReport,
    setNavRoute,
    fitRoute,
    navCamera,
    setViewInsets,
    setUserPuck,
    followUser,
    toggle3D,
    resetNorth,
    zoomBy,
    setStyleMode,
    getStyleMode,
    setPickMode,
    setSimRoute,
    get instance() { return map; },
    set onMarkerClick(fn) { onMarkerClick = fn; },
    set onMapClick(fn) { onMapClick = fn; },
  };
})();
