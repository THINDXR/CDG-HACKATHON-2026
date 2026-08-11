/* แผนที่ 3 มิติ (MapLibre GL) — มุมกล้องเอียง อาคาร 3D ภูมิประเทศ และท้องฟ้า */
window.MapView = (function () {
  const CFG = window.APP_CONFIG;
  const U = window.Utils;

  let map = null;
  let ready = false;
  const readyQueue = [];
  let styleMode = 'vector';
  let markers = new Map(); // id -> maplibregl.Marker
  let userMarker = null;
  let pulseFrame = null;
  let onMarkerClick = () => {};
  let onMapClick = () => {};
  let pickMode = false;

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
      style: CFG.STYLE_VECTOR,
      center: CFG.DEFAULT_CENTER,
      zoom: CFG.DEFAULT_ZOOM,
      pitch: CFG.DEFAULT_PITCH,
      bearing: CFG.DEFAULT_BEARING,
      maxPitch: 85,
      antialias: true,
      attributionControl: { compact: true },
      hash: false,
    });

    map.on('style.load', () => {
      applySceneEnhancements();
      addHazardLayers();
      refreshHazards();
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
        'sky-color': '#8ec5ff',
        'sky-horizon-blend': 0.6,
        'horizon-color': '#dfeeff',
        'horizon-fog-blend': 0.7,
        'fog-color': '#e9f1fb',
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
            0, '#e6e6ec',
            40, '#eeeef3',
            120, '#f7f7fb',
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

  function addHazardLayers() {
    if (!map.getSource('hazard-zones')) {
      map.addSource('hazard-zones', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
    if (!map.getLayer('hazard-zone-fill')) {
      map.addLayer({
        id: 'hazard-zone-fill',
        type: 'fill',
        source: 'hazard-zones',
        paint: {
          'fill-color': ['get', 'color'],
          'fill-opacity': ['case', ['get', 'selected'], 0.22, 0.1],
        },
      });
    }
    if (!map.getLayer('hazard-zone-line')) {
      map.addLayer({
        id: 'hazard-zone-line',
        type: 'line',
        source: 'hazard-zones',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['case', ['get', 'selected'], 2.5, 1.2],
          'line-opacity': ['case', ['get', 'selected'], 0.9, 0.45],
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
  }

  /** วาดหมุดและวงรัศมีใหม่ทั้งหมดตามข้อมูลปัจจุบัน */
  function refreshHazards() {
    if (!map || !map.isStyleLoaded()) return;

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
    const src = map.getSource('hazard-zones');
    if (src) src.setData(zones);
  }

  function buildMarkerElement(report) {
    const def = CFG.HAZARD_TYPES[report.type];
    const wrap = U.el('div', 'hazard-marker');
    wrap.style.setProperty('--pin-color', def.color);
    wrap.dataset.id = report.id;

    const pin = U.el('div', 'hazard-marker__pin');
    pin.appendChild(U.el('span', 'hazard-marker__icon', def.icon));
    const stem = U.el('div', 'hazard-marker__stem');
    const shadow = U.el('div', 'hazard-marker__shadow');

    wrap.append(pin, stem, shadow);
    wrap.addEventListener('click', (e) => {
      e.stopPropagation();
      onMarkerClick(report.id);
    });
    return wrap;
  }

  /* ---------- วงคลื่นเตือน (แอนิเมชัน) ---------- */

  function startPulse() {
    const period = 2200;
    function tick(t) {
      pulseFrame = requestAnimationFrame(tick);
      if (!map || !map.isStyleLoaded()) return;
      const src = map.getSource('pulse-ring');
      if (!src) return;

      const targets = window.Store
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

  function setUserPuck(coord, heading) {
    if (!map || !coord) return;
    if (!userMarker) {
      const wrap = U.el('div', 'user-puck');
      wrap.append(
        U.el('div', 'user-puck__cone'),
        U.el('div', 'user-puck__dot'),
        U.el('div', 'user-puck__halo')
      );
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
  }

  function followUser(coord, heading) {
    if (!map || !coord) return;
    map.easeTo({
      center: coord,
      bearing: typeof heading === 'number' ? heading : map.getBearing(),
      pitch: Math.max(map.getPitch(), 60),
      zoom: Math.max(map.getZoom(), 16.5),
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
    map.easeTo({ bearing: 0, duration: 600 });
  }

  function zoomBy(delta) {
    map.easeTo({ zoom: map.getZoom() + delta, duration: 300 });
  }

  function updateCompass() {
    const needle = document.getElementById('compassNeedle');
    if (needle) needle.style.transform = `rotate(${-map.getBearing()}deg)`;
    const btn = document.getElementById('btn3D');
    if (btn) btn.classList.toggle('is-active', map.getPitch() > 20);
  }

  /* ---------- โหมดสไตล์ ---------- */

  function setStyleMode(mode) {
    if (!map || mode === styleMode) return;
    styleMode = mode;
    markers.forEach((m) => m.remove());
    markers.clear();
    map.setStyle(mode === 'satellite' ? satelliteStyle() : CFG.STYLE_VECTOR, {
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
    flyToReport,
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
