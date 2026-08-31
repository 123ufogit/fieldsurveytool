/* =========================================================================
   石川県林業試験場 現地調査 WebGIS - メインスクリプト
   =========================================================================
   構成:
     A. 地図・タイルレイヤ初期化
     B. 樹種カラーパレット定義
     C. GeoJSONレイヤ読み込み（trees / zoning / codrat）
     D. GeoJSONレイヤ 表示制御・透過率スライダー
     E. GPS機能
     F. トラック記録
     G. POI登録
     H. GeoJSON出力
     I. レイヤパネル・タイルオーバーレイ制御
     J. UI ユーティリティ・ボタンイベント
   ========================================================================= */

/* =========================================================================
   A. 地図・タイルレイヤ初期化
   ========================================================================= */

/** 初期中心：石川県林業試験場付近 */
const INITIAL_CENTER = [37.396, 137.247];
const INITIAL_ZOOM   = 13;

const map = L.map('map', {
  center:             INITIAL_CENTER,
  zoom:               INITIAL_ZOOM,
  zoomControl:        true,
  attributionControl: true,
  maxZoom: 36,
  minZoom: 5,
});

/* ズームコントロールを左下に配置 */
map.zoomControl.setPosition('bottomleft');

/* スケールバー（メートル単位） */
L.control.scale({
  position: 'bottomleft',
  imperial: false,
  maxWidth: 120,
}).addTo(map);

/* ---- ベースマップ：国土地理院 標準地図 ---- */
L.tileLayer(
  'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
  {
    attribution:
      '<a href="https://maps.gsi.go.jp/development/ichiran.html"' +
      ' target="_blank">国土地理院</a>',
    maxZoom: 36,
    maxNativeZoom: 18,
  }
).addTo(map);

/* ---- オーバーレイ1：CS立体図（初期透過率50%） ---- */
const csLayer = L.tileLayer(
  'https://rinya-tiles.geospatial.jp/csmap_r06eq_2025/{z}/{x}/{y}.webp',
  {
    attribution:
      '<a href="https://www.rinya.maff.go.jp/" target="_blank">' +
      '林野庁 CS立体図</a>',
    maxZoom: 36,
    maxNativeZoom: 18,
    opacity: 0.5,
  }
).addTo(map);

/* ---- オーバーレイ2：森林資源20mメッシュ（初期非表示・透過率70%） ---- */
const frLayer = L.tileLayer(
  'https://rinya-tiles.geospatial.jp/fr_mesh20m_webp_2025/{z}/{x}/{y}.webp',
  {
    attribution:
      '<a href="https://www.rinya.maff.go.jp/" target="_blank">' +
      '林野庁 森林資源メッシュ</a>',
    maxZoom: 36,
    maxNativeZoom: 18,
    opacity: 0.3, // 透過率70% → opacity = (100-70)/100
  }
); // 初期非表示のため addTo しない

/* =========================================================================
   B. 樹種カラーパレット定義
   ========================================================================= */

/** 樹種 → 色 マッピング（屋外高コントラスト対応） */
const SPECIES_COLOR = {
  'スギ':     '#2e7d32',
  'ヒノキ':   '#66bb6a',
  'マツ':     '#f9a825',
  'アカマツ': '#ff8f00',
  'クロマツ': '#6d4c41',
  'ナラ':     '#8d6e63',
  'ブナ':     '#a5d6a7',
  'カシ':     '#00897b',
  'サクラ':   '#f48fb1',
  'ケヤキ':   '#ffcc02',
  'コナラ':   '#bcaaa4',
  '広葉樹':   '#26a69a',
  '針葉樹':   '#1565c0',
  '竹':       '#c6ff00',
  '未立木':   '#757575',
};

/* 自動生成カラー（SPECIES_COLOR にない樹種用） */
const AUTO_COLORS = [
  '#e41a1c','#377eb8','#4daf4a','#984ea3','#ff7f00',
  '#ffff33','#a65628','#f781bf','#999999'
];

/* 自動割り当て用キャッシュ */
const autoColorMap = {};
let autoColorIndex = 0;


const DEFAULT_SPECIES_COLOR = '#9e9e9e';

/**
 * species 属性値から色を返す（完全一致 → 部分一致）
 * @param {string} species
 * @returns {string} カラーコード
 */
function getSpeciesColor(species) {
  if (!species) return DEFAULT_SPECIES_COLOR;

  // 完全一致
  if (SPECIES_COLOR[species]) return SPECIES_COLOR[species];

  // 部分一致（例：スギ（成木）など）
  for (const key of Object.keys(SPECIES_COLOR)) {
    if (species.includes(key)) return SPECIES_COLOR[key];
  }

  // 自動色割り当て（trees.geojson に含まれるが SPECIES_COLOR にない樹種）
  if (!autoColorMap[species]) {
    autoColorMap[species] = AUTO_COLORS[autoColorIndex % AUTO_COLORS.length];
    autoColorIndex++;
  }

  return autoColorMap[species];
}

function getTreeRadius(dbh) {
  dbh = Number(dbh) || 0;

  return Math.max(
    4,
    Math.min(
      18,
      Math.sqrt(dbh) * 1.5
    )
  );
}

/* =========================================================================
   C. GeoJSONレイヤ読み込み
   =========================================================================
   index.html と同じフォルダに配置すること：
     trees.geojson / zoning.geojson / codrat.geojson
   ========================================================================= */

/* 各レイヤを格納する LayerGroup */
const treesLayerGroup  = L.layerGroup().addTo(map);
const codratLayerGroup = L.layerGroup().addTo(map);
const zoningLayerGroup = L.layerGroup().addTo(map);

/* GeoJSON レイヤの実体（透過率制御用に参照を保持） */
let treesGeoJSON  = null;
let zoningGeoJSON = null;
let codratGeoJSON = null;
let mesh20Layer = null;

/* 実データから検出した樹種リスト（凡例生成用） */
const detectedSpecies = new Set();

/* ------------------------------------------------------------------
   C-1. 樹木データ（trees.geojson）
   ------------------------------------------------------------------ */
fetch('trees.geojson')
  .then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
  .then(data => {
    treesGeoJSON = L.geoJSON(data, {

      /* ポイント：species で色分けした円マーカー */
      pointToLayer: function (feature, latlng) {
        const sp    = feature.properties && feature.properties.species;
        const color = getSpeciesColor(sp);
        if (sp) detectedSpecies.add(sp);
        const marker = L.circleMarker(latlng, {
  radius: getTreeRadius(feature.properties.DBH),
  fillColor: color,
  color: '#ffffff',
  weight: 1.5,
  opacity: 1,
  fillOpacity: 1.0,
});

const id = feature.properties.ID;

if (id !== undefined && id !== null) {
  marker.bindTooltip(
    String(id),
    {
      permanent: true,
      direction: 'right',
      offset: [8, 0],
      className: 'tree-id-label'
    }
  );
}

return marker;
        return L.circleMarker(latlng, {
          radius: getTreeRadius(feature.properties.DBH), fillColor: color,
          color: '#ffffff', weight: 1.5,
          opacity: 1, fillOpacity: 1.0,
        });
      },

      /* ポリゴン・ライン：species で塗り色を変える */
      style: function (feature) {
        const sp    = feature.properties && feature.properties.species;
        const color = getSpeciesColor(sp);
        if (sp) detectedSpecies.add(sp);
        return {
          fillColor: color, color: '#ffffff',
          weight: 1, fillOpacity: 0.75,
        };
      },

      /* ツールチップ：species + 他属性（最大3件） */
      onEachFeature: function (feature, layer) {
        const p  = feature.properties || {};
        const sp = p.species || '不明';
        const lines = [`<b>🌳 ${sp}</b>`];
        let n = 0;
        for (const [k, v] of Object.entries(p)) {
          if (k === 'species') continue;
          if (n++ >= 3) break;
          lines.push(`${k}: ${v}`);
        }
        layer.bindTooltip(lines.join('<br>'),
          { sticky: true, direction: 'top' });
      },
    });

    treesLayerGroup.addLayer(treesGeoJSON);
    treesGeoJSON.bringToFront(); 
    buildTreesLegend();
    showToast(`🌳 樹木データ読み込み完了（${data.features
      ? data.features.length : '?'}件）`);
  })
  .catch(err => {
    console.warn('trees.geojson 読み込み失敗:', err);
    showToast('⚠ trees.geojson が見つかりません');
  });

/* ------------------------------------------------------------------
   C-2. ゾーニングデータ（zoning.geojson）
   ------------------------------------------------------------------ */

/* ゾーニング用カラーパレット */
const ZONE_COLORS = [
  '#e53935','#1e88e5','#43a047','#fb8c00',
  '#8e24aa','#00acc1','#f4511e','#6d4c41',
];
const zoneColorCache = {};
let   zoneColorIndex = 0;

/**
 * ゾーンフィーチャーの色を返す
 * zone / name / type 属性を優先参照
 */
function getZoneColor(properties) {
  const key = properties.zone || properties.name
            || properties.type || null;
  if (!key) {
    return ZONE_COLORS[zoneColorIndex++ % ZONE_COLORS.length];
  }
  if (!zoneColorCache[key]) {
    zoneColorCache[key] =
      ZONE_COLORS[Object.keys(zoneColorCache).length
                  % ZONE_COLORS.length];
  }
  return zoneColorCache[key];
}

fetch('zoning.geojson')
  .then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
  .then(data => {
    zoningGeoJSON = L.geoJSON(data, {

      /* ポリゴン：ゾーン属性で色分け・初期透過率50% */
      style: function (feature) {
        const color = getZoneColor(feature.properties || {});
        return {
          fillColor: color, color: color,
          weight: 2, opacity: 0.9, fillOpacity: 0.15,
        };
      },

      /* ツールチップ：ゾーン名と属性 */
      onEachFeature: function (feature, layer) {
        const p    = feature.properties || {};
        const name = p.zone || p.name || p.type || 'ゾーン';
        const lines = [`<b>📦 ${name}</b>`];
        for (const [k, v] of Object.entries(p)) {
          if (['zone','name','type'].includes(k)) continue;
          lines.push(`${k}: ${v}`);
        }
        layer.bindTooltip(lines.join('<br>'),
          { sticky: true, direction: 'top' });
        layer.on('click', function (e) {
          e.originalEvent.stopPropagation();
        });
        layer.interactive = false;
      },
    });

    zoningLayerGroup.addLayer(zoningGeoJSON);
    zoningGeoJSON.bringToBack();
    buildZoningLegend(); 
    showToast(`📦 ゾーニング読み込み完了（${data.features
      ? data.features.length : '?'}件）`);
  })
  .catch(err => {
    console.warn('zoning.geojson 読み込み失敗:', err);
    showToast('⚠ zoning.geojson が見つかりません');
  });

/* ------------------------------------------------------------------
   C-3. 調査点データ（codrat.geojson）
   ------------------------------------------------------------------ */

/* 赤いピンアイコン */
const codratIcon = L.divIcon({
  className: '',
  html: `<div style="position:relative;width:24px;height:32px;">
    <div style="width:24px;height:24px;background:#e53935;
      border:2.5px solid #ffffff;border-radius:50% 50% 50% 0;
      transform:rotate(-45deg);
      box-shadow:2px 2px 6px rgba(0,0,0,0.55);"></div>
    <div style="position:absolute;top:6px;left:6px;
      width:8px;height:8px;background:#ffffff;
      border-radius:50%;"></div>
  </div>`,
  iconSize:    [24, 32],
  iconAnchor:  [12, 32],
  popupAnchor: [0, -32],
});

fetch('codrat.geojson')
  .then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
  .then(data => {
    codratGeoJSON = L.geoJSON(data, {

      /* ポイントに赤いピンを設定 */
      pointToLayer: function (feature, latlng) {
        return L.marker(latlng, { icon: codratIcon });
      },

      /* ツールチップ：調査点の属性（最大4件） */
      onEachFeature: function (feature, layer) {
        const p    = feature.properties || {};
        const name = p.name || p.id || p.no || '調査点';
        const lines = [`<b>📍 ${name}</b>`];
        let n = 0;
        for (const [k, v] of Object.entries(p)) {
          if (['name','id','no'].includes(k)) continue;
          if (n++ >= 4) break;
          lines.push(`${k}: ${v}`);
        }
        layer.bindTooltip(lines.join('<br>'),
          { sticky: true, direction: 'top' });
      },
    });

    codratLayerGroup.addLayer(codratGeoJSON);
    showToast(`📍 調査点読み込み完了（${data.features
      ? data.features.length : '?'}件）`);
  })
  .catch(err => {
    console.warn('codrat.geojson 読み込み失敗:', err);
    showToast('⚠ codrat.geojson が見つかりません');
  });

/* ------------------------------------------------------------------
   C-4. 20m メッシュデータ（20mesh.geojson）
   ------------------------------------------------------------------ */
fetch('20mesh.geojson')
  .then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
  .then(data => {
    mesh20Layer = L.geoJSON(data, {
      style: function (feature) {
        return {
          color: '#888888',
          weight: 1,
          opacity: 0.5
        };
      }
    });

    // 初期表示：ズーム19以上のときのみ
    if (map.getZoom() >= 19) {
      mesh20Layer.addTo(map);
    }

    showToast(`🧵 20mメッシュ読み込み完了（${data.features
      ? data.features.length : '?'}件）`);
  })
  .catch(err => {
    console.warn('20mesh.geojson 読み込み失敗:', err);
    showToast('⚠ 20mesh.geojson が見つかりません');
  });


/* =========================================================================
   D. GeoJSONレイヤ 表示制御・透過率スライダー
   ========================================================================= */

/* 樹木データ ON/OFF */
document.getElementById('toggle-trees')
  .addEventListener('change', function () {
    this.checked
      ? map.addLayer(treesLayerGroup)
      : map.removeLayer(treesLayerGroup);
  });

/* ゾーニング ON/OFF */
document.getElementById('toggle-zoning')
  .addEventListener('change', function () {
    this.checked
      ? map.addLayer(zoningLayerGroup)
      : map.removeLayer(zoningLayerGroup);
  });

/* ゾーニング 透過率スライダー */
document.getElementById('slider-zoning')
  .addEventListener('input', function () {
    const t = parseInt(this.value);
    const fo = (100 - t) / 100;
    document.getElementById('val-zoning').textContent = `${t}%`;
    if (zoningGeoJSON) {
      zoningGeoJSON.setStyle(feature => {
        const color = getZoneColor(feature.properties || {});
        return {
          fillColor: color, color: color,
          weight: 2, opacity: 0.9, fillOpacity: fo,
        };
      });
    }
  });

/* 調査点 ON/OFF */
document.getElementById('toggle-codrat')
  .addEventListener('change', function () {
    this.checked
      ? map.addLayer(codratLayerGroup)
      : map.removeLayer(codratLayerGroup);
  });

/* =========================================================================
   凡例生成：樹種別カラー
   ========================================================================= */

/** 樹種別カラー凡例を動的生成（trees.geojson 読み込み完了後に呼ぶ） */
function buildTreesLegend() {
  const container = document.getElementById('legend-trees');
  container.innerHTML = '';
   
/** ゾーン凡例を動的生成（zoning.geojson 読み込み完了後に呼ぶ） */
function buildZoningLegend() {
  const container = document.getElementById('legend-zoning');
  if (!container) return;
  container.innerHTML = '';

  // zoneColorCache に登録されたキーごとに凡例を作成
  const keys = Object.keys(zoneColorCache).sort();
  keys.forEach(key => {
    const color = zoneColorCache[key];
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML =
      `<div class="legend-color"
            style="background:${color};"></div>
       <span>${key}</span>`;
    container.appendChild(item);
  });
}
  // trees.geojson に登場した樹種のみを凡例に表示
  const sorted = [...detectedSpecies].sort();

  sorted.forEach(sp => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML =
      `<div class="legend-color"
            style="background:${getSpeciesColor(sp)};"></div>
       <span>${sp}</span>`;
    container.appendChild(item);
  });

  // その他（分類不能・未分類）
  const other = document.createElement('div');
  other.className = 'legend-item';
  other.innerHTML =
    `<div class="legend-color"
          style="background:${DEFAULT_SPECIES_COLOR};"></div>
     <span>その他</span>`;
  container.appendChild(other);
}


/* 凡例の折りたたみ開閉 */
document.getElementById('btn-legend-toggle')
  .addEventListener('click', function () {
    const isOpen =
      document.getElementById('legend-trees').classList.toggle('show');
    this.textContent = isOpen ? '▲ 樹種別の色' : '▼ 樹種別の色';
  });

// ★ 新しい凡例パネルの開閉ボタン
const legendToggleBtn = document.getElementById('legend-toggle-btn');
const legendContent   = document.getElementById('legend-content');

if (legendToggleBtn && legendContent) {
  legendToggleBtn.addEventListener('click', () => {
    const isOpen = legendContent.classList.toggle('show');
    legendToggleBtn.textContent = isOpen ? '凡例 ▲' : '凡例 ▼';
  });
}

/* =========================================================================
   E. GPS機能
   ========================================================================= */

const gpsState = {
  watching:       false,
  watchId:        null,
  following:      false,
  lastPosition:   null,
  currentMarker:  null,
  accuracyCircle: null,
  lastHeading:    null, 
};

/* 現在地マーカーアイコン（青い丸） */
const gpsIcon = L.divIcon({
  className: '',
  html: `<div style="width:18px;height:18px;background:#1e90ff;
    border:3px solid #ffffff;border-radius:50%;
    box-shadow:0 0 8px rgba(30,144,255,0.8);"></div>`,
  iconSize:   [18, 18],
  iconAnchor: [9, 9],
});

/** GPS監視を開始する */
function startGpsWatch() {
  if (!navigator.geolocation || gpsState.watching) return;
  gpsState.watchId = navigator.geolocation.watchPosition(
    onGpsSuccess, onGpsError,
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
  gpsState.watching = true;
  updateStatusText('GPS監視中...');
}

/** GPS取得成功コールバック */
function onGpsSuccess(pos) {
  const { latitude: lat, longitude: lng,
          accuracy: acc, heading: hdg } = pos.coords;
  gpsState.lastPosition = pos;

  const latlng = L.latLng(lat, lng);
  if (!gpsState.currentMarker) {
    gpsState.currentMarker = L.marker(latlng,
      { icon: gpsIcon, zIndexOffset: 1000 }).addTo(map);
    gpsState.accuracyCircle = L.circle(latlng, {
      radius: acc, color: '#1e90ff',
      fillColor: '#1e90ff', fillOpacity: 0.12,
      weight: 1, dashArray: '4,4',
    }).addTo(map);
  } else {
    gpsState.currentMarker.setLatLng(latlng);
    gpsState.accuracyCircle.setLatLng(latlng);
    gpsState.accuracyCircle.setRadius(acc);
  }

  if (gpsState.following)
    map.panTo(latlng, { animate: true, duration: 0.5 });

  document.getElementById('disp-lat').textContent = lat.toFixed(6);
  document.getElementById('disp-lng').textContent = lng.toFixed(6);
  if (hdg !== null && !isNaN(hdg)) updateCompass(hdg);
  if (trackState.recording) addTrackPoint(lat, lng);
  updateStatusText(`GPS精度: ±${Math.round(acc)}m`);
}

/** GPS取得失敗コールバック */
function onGpsError(err) {
  const msgs = {
    1: '⚠ GPS許可が必要です',
    2: '⚠ GPS信号が取得できません',
    3: '⚠ GPS取得タイムアウト',
  };
  const msg = msgs[err.code] || 'GPS取得エラー';
  showToast(msg);
  updateStatusText(msg);
}

/** コンパス表示を更新する */
function updateCompass(deg) {
  gpsState.lastHeading = deg; // ★ 方位を保存

  const dirs = ['↑N','↗NE','→E','↘SE','↓S','↙SW','←W','↖NW'];
  document.getElementById('compass-display').textContent =
    dirs[Math.round(deg / 45) % 8];
  document.getElementById('compass-deg').textContent =
    `${Math.round(deg)}°`;
  updateCrosshair(); // ★ 赤ライン更新
}

/** ズーム19以上＋特定方位で赤い縦横ラインを表示 */
function updateCrosshair() {
  const z = map.getZoom();
  const deg = gpsState.lastHeading;

  // 条件：ズーム19以上＋方位が指定範囲
  if (z < 19 || deg === null || isNaN(deg)) {
    if (crosshairLayer) {
      map.removeLayer(crosshairLayer);
      crosshairLayer = null;
    }
    return;
  }

  const d = (deg + 360) % 360;
  const ok =
    (d >= 358 || d <= 2) ||
    (d >= 88 && d <= 92) ||
    (d >= 178 && d <= 182) ||
    (d >= 268 && d <= 272);

  if (!ok) {
    if (crosshairLayer) {
      map.removeLayer(crosshairLayer);
      crosshairLayer = null;
    }
    return;
  }

  const center = map.getCenter();
  const bounds = map.getBounds();

  const lat1 = bounds.getNorth();
  const lat2 = bounds.getSouth();
  const lng1 = bounds.getWest();
  const lng2 = bounds.getEast();

  const vertical = L.polyline([[lat1, center.lng], [lat2, center.lng]], {
    color: '#ff0000',
    weight: 2,
    opacity: 0.9,
  });

  const horizontal = L.polyline([[center.lat, lng1], [center.lat, lng2]], {
    color: '#ff0000',
    weight: 2,
    opacity: 0.9,
  });

  if (crosshairLayer) {
    map.removeLayer(crosshairLayer);
  }
  crosshairLayer = L.layerGroup([vertical, horizontal]).addTo(map);
}


/* =========================================================================
   F. トラック記録
   ========================================================================= */

const trackState = { recording: false, pointCount: 0, startTime: null };
let trackCoords   = [];
const trackLayer  = L.layerGroup().addTo(map);
let trackPolyline = null;
let crosshairLayer = null;

/** トラック記録を開始する */
function startTracking() {
  if (trackState.recording) {
    showToast('⚠ 既に記録中です'); return;
  }
  trackState.recording  = true;
  trackState.pointCount = 0;
  trackState.startTime  = new Date();
  trackCoords = [];
  if (trackPolyline) {
    trackLayer.removeLayer(trackPolyline);
    trackPolyline = null;
  }
  document.getElementById('btn-track-start').classList.add('recording');
  document.getElementById('btn-track-stop').disabled = false;
  startGpsWatch();
  updateStatusText('⏺ トラック記録中');
  showToast('⏺ トラック記録を開始しました');
  updateTrackInfo();
}

/** トラック記録を停止する */
function stopTracking() {
  if (!trackState.recording) return;
  trackState.recording = false;
  document.getElementById('btn-track-start')
    .classList.remove('recording');
  document.getElementById('btn-track-stop').disabled = true;
  showToast(`⏹ 記録停止: ${trackState.pointCount}点`);
  updateStatusText(`トラック停止（${trackState.pointCount}点）`);
  updateTrackInfo();
}

/** トラックに座標点を追加する */
function addTrackPoint(lat, lng) {
  trackCoords.push([lat, lng]);
  trackState.pointCount++;
  if (trackPolyline) {
    trackPolyline.setLatLngs(trackCoords);
  } else {
    trackPolyline = L.polyline(trackCoords, {
      color: '#ff4444', weight: 4, opacity: 0.85,
      lineJoin: 'round', lineCap: 'round',
    }).addTo(trackLayer);
  }
  updateTrackInfo();
}

/** トラック情報表示を更新する */
function updateTrackInfo() {
  document.getElementById('track-info').textContent =
    `トラック: ${trackState.pointCount}点`;
}

/* =========================================================================
   G. POI登録
   ========================================================================= */

let poiList = [];
const poiLayer = L.layerGroup().addTo(map);

/** POI登録モーダルを開く */
function openPoiModal() {
  if (!gpsState.lastPosition) startGpsWatch();
  const src = gpsState.lastPosition
    ? `📍 ${gpsState.lastPosition.coords.latitude.toFixed(6)},` +
      ` ${gpsState.lastPosition.coords.longitude.toFixed(6)}`
    : `📍 ${map.getCenter().lat.toFixed(6)},` +
      ` ${map.getCenter().lng.toFixed(6)} (地図中心)`;
  document.getElementById('poi-coords-display').textContent = src;
  document.getElementById('poi-name').value = '';
  document.getElementById('poi-note').value = '';
  document.getElementById('poi-modal').classList.add('show');
  setTimeout(() => document.getElementById('poi-name').focus(), 100);
}

/** POIを登録する */
function registerPoi() {
  const name = document.getElementById('poi-name').value.trim()
             || '調査地点';
  const note = document.getElementById('poi-note').value.trim();
  let lat, lng;
  if (gpsState.lastPosition) {
    lat = gpsState.lastPosition.coords.latitude;
    lng = gpsState.lastPosition.coords.longitude;
  } else {
    const c = map.getCenter(); lat = c.lat; lng = c.lng;
  }
  const poi = {
    id: poiList.length + 1, name, note, lat, lng,
    timestamp: new Date().toISOString(),
  };
  poiList.push(poi);
  addPoiMarker(poi);
  document.getElementById('poi-modal').classList.remove('show');
  showToast(`📌 POI登録: ${name}`);
  updateStatusText(`POI ${poiList.length}件登録済`);
}

/** POIマーカーを地図上に追加する */
function addPoiMarker(poi) {
  const icon = L.divIcon({
    className: '',
    html: `<div style="position:relative;width:28px;height:36px;">
      <div style="width:28px;height:28px;background:#ffcc00;
        border:3px solid #333;border-radius:50% 50% 50% 0;
        transform:rotate(-45deg);
        box-shadow:2px 2px 6px rgba(0,0,0,0.5);"></div>
      <div style="position:absolute;top:4px;left:6px;
        color:#333;font-size:11px;font-weight:bold;">
        ${poi.id}</div>
    </div>`,
    iconSize: [28, 36], iconAnchor: [14, 36], popupAnchor: [0, -36],
  });
  L.marker([poi.lat, poi.lng], { icon })
    .bindTooltip(
      `<b>${poi.name}</b>${poi.note ? '<br>' + poi.note : ''}`,
      { permanent: false, direction: 'top' }
    )
    .addTo(poiLayer);
}

/* =========================================================================
   H. GeoJSON出力
   ========================================================================= */

/** トラック＋POIを GeoJSON ファイルとして出力する */
function exportGeoJSON() {
  const features = [];

  /* トラック → LineString */
  if (trackCoords.length >= 2) {
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: trackCoords.map(c => [c[1], c[0]]),
      },
      properties: {
        type: 'track', name: 'トラック',
        pointCount: trackCoords.length,
        startTime: trackState.startTime
          ? trackState.startTime.toISOString() : null,
        exportTime: new Date().toISOString(),
      },
    });
  }

  /* POI → Point */
  poiList.forEach(poi => {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [poi.lng, poi.lat] },
      properties: {
        type: 'poi', id: poi.id, name: poi.name,
        note: poi.note, timestamp: poi.timestamp,
      },
    });
  });

  if (features.length === 0) {
    showToast('⚠ 出力するデータがありません'); return;
  }

  const geojson = {
    type: 'FeatureCollection',
    features,
    metadata: {
      title:      '林業試験場 現地調査データ',
      exportTime: new Date().toISOString(),
      trackCount: trackCoords.length,
      poiCount:   poiList.length,
    },
  };

  const blob = new Blob(
    [JSON.stringify(geojson, null, 2)],
    { type: 'application/geo+json' }
  );
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  const now = new Date();
  const dt  = `${now.getFullYear()}`
    + `${String(now.getMonth()+1).padStart(2,'0')}`
    + `${String(now.getDate()).padStart(2,'0')}_`
    + `${String(now.getHours()).padStart(2,'0')}`
    + `${String(now.getMinutes()).padStart(2,'0')}`;
  a.download = `survey_${dt}.geojson`;
  a.href = url;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`💾 GeoJSON出力完了（トラック${trackCoords.length}点`
    + ` / POI${poiList.length}件）`);
}

/* =========================================================================
   I. レイヤパネル・タイルオーバーレイ制御
   ========================================================================= */

function openLayerPanel() {
  document.getElementById('layer-panel').classList.add('open');
  document.getElementById('panel-overlay').classList.add('show');
}
function closeLayerPanel() {
  document.getElementById('layer-panel').classList.remove('open');
  document.getElementById('panel-overlay').classList.remove('show');
}

/* CS立体図 ON/OFF */
document.getElementById('toggle-cs')
  .addEventListener('change', function () {
    this.checked ? map.addLayer(csLayer) : map.removeLayer(csLayer);
  });
/* CS立体図 透過率スライダー */
document.getElementById('slider-cs')
  .addEventListener('input', function () {
    const t = parseInt(this.value);
    csLayer.setOpacity((100 - t) / 100);
    document.getElementById('val-cs').textContent = `${t}%`;
  });

/* 森林資源 ON/OFF */
document.getElementById('toggle-fr')
  .addEventListener('change', function () {
    this.checked ? map.addLayer(frLayer) : map.removeLayer(frLayer);
  });
/* 森林資源 透過率スライダー */
document.getElementById('slider-fr')
  .addEventListener('input', function () {
    const t = parseInt(this.value);
    frLayer.setOpacity((100 - t) / 100);
    document.getElementById('val-fr').textContent = `${t}%`;
  });

/* トラックレイヤ ON/OFF */
document.getElementById('toggle-track')
  .addEventListener('change', function () {
    this.checked
      ? map.addLayer(trackLayer)
      : map.removeLayer(trackLayer);
  });

/* POIレイヤ ON/OFF */
document.getElementById('toggle-poi')
  .addEventListener('change', function () {
    this.checked
      ? map.addLayer(poiLayer)
      : map.removeLayer(poiLayer);
  });

/* トラッククリア */
document.getElementById('btn-clear-track')
  .addEventListener('click', function () {
    if (trackState.recording) {
      showToast('⚠ 記録停止後にクリアしてください'); return;
    }
    if (trackCoords.length === 0) {
      showToast('クリアするトラックがありません'); return;
    }
    if (!confirm(`トラック（${trackCoords.length}点）をクリアしますか？`))
      return;
    trackCoords = []; trackState.pointCount = 0;
    if (trackPolyline) {
      trackLayer.removeLayer(trackPolyline);
      trackPolyline = null;
    }
    updateTrackInfo();
    showToast('🗑 トラックをクリアしました');
  });

/* POIクリア */
document.getElementById('btn-clear-poi')
  .addEventListener('click', function () {
    if (poiList.length === 0) {
      showToast('クリアするPOIがありません'); return;
    }
    if (!confirm(`POI（${poiList.length}件）をクリアしますか？`))
      return;
    poiList = []; poiLayer.clearLayers();
    showToast('🗑 POIをクリアしました');
    updateStatusText('待機中');
  });

/* =========================================================================
   J. UI ユーティリティ・ボタンイベント
   ========================================================================= */

/** ステータステキストを更新する */
function updateStatusText(text) {
  document.getElementById('status-text').textContent = text;
}

/** トースト通知を表示する */
let toastTimer = null;
function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

/* 地図移動時：緯度経度更新 */
map.on('move', function () {
  if (!gpsState.following || !gpsState.lastPosition) {
    const c = map.getCenter();
    document.getElementById('disp-lat').textContent =
      c.lat.toFixed(6);
    document.getElementById('disp-lng').textContent =
      c.lng.toFixed(6);
  }
});

/* ズーム変更時：ズームレベル更新 */
map.on('zoomend', function () {
  const z = map.getZoom();
  document.getElementById('disp-zoom').textContent = z;

  // ★ 20mメッシュの表示制御
  if (mesh20Layer) {
    if (z >= 19) {
      map.addLayer(mesh20Layer);
    } else {
      map.removeLayer(mesh20Layer);
    }
  }

  // ★ 赤ラインの更新（後述の crosshair 用）
  updateCrosshair();
});
document.getElementById('disp-zoom').textContent = map.getZoom();


/* 地図ドラッグでGPS追尾OFF */
map.on('dragstart', function () {
  if (gpsState.following) {
    gpsState.following = false;
    const btn = document.getElementById('btn-follow');
    btn.classList.remove('active');
    btn.textContent = '🔒';
  }
});

/* デバイスコンパス */
if (typeof DeviceOrientationEvent !== 'undefined') {
  window.addEventListener('deviceorientation', function (e) {
    if (e.alpha !== null) updateCompass(e.alpha);
  }, true);
}

/* ---- ボタンイベント ---- */

/* 現在地へ移動 */
document.getElementById('btn-locate')
  .addEventListener('click', function () {
    if (!navigator.geolocation) {
      showToast('⚠ GPS非対応ブラウザです'); return;
    }
    showToast('📍 現在地を取得中...');
    navigator.geolocation.getCurrentPosition(
      pos => {
        map.flyTo(
          [pos.coords.latitude, pos.coords.longitude], 16,
          { animate: true, duration: 1.0 }
        );
        showToast('📍 現在地取得完了');
        startGpsWatch();
      },
      () => showToast('⚠ 現在地を取得できません'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });

/* GPS追尾 ON/OFF */
document.getElementById('btn-follow')
  .addEventListener('click', function () {
    gpsState.following = !gpsState.following;
    if (gpsState.following) {
      this.classList.add('active');
      this.textContent = '🔓';
      showToast('🔒 GPS追尾: ON');
      startGpsWatch();
      if (gpsState.lastPosition) {
        map.flyTo(
          [gpsState.lastPosition.coords.latitude,
           gpsState.lastPosition.coords.longitude],
          map.getZoom(), { animate: true, duration: 0.5 }
        );
      }
    } else {
      this.classList.remove('active');
      this.textContent = '🔒';
      showToast('🔓 GPS追尾: OFF');
    }
  });

document.getElementById('btn-track-start')
  .addEventListener('click', startTracking);
document.getElementById('btn-track-stop')
  .addEventListener('click', stopTracking);
document.getElementById('btn-poi')
  .addEventListener('click', openPoiModal);
document.getElementById('btn-export')
  .addEventListener('click', exportGeoJSON);
document.getElementById('btn-layers')
  .addEventListener('click', openLayerPanel);
document.getElementById('btn-close-panel')
  .addEventListener('click', closeLayerPanel);
document.getElementById('panel-overlay')
  .addEventListener('click', closeLayerPanel);
document.getElementById('btn-poi-ok')
  .addEventListener('click', registerPoi);
document.getElementById('btn-poi-cancel')
  .addEventListener('click', () => {
    document.getElementById('poi-modal').classList.remove('show');
  });
document.getElementById('poi-name')
  .addEventListener('keydown', e => {
    if (e.key === 'Enter') registerPoi();
  });

/* 起動完了メッセージ */
showToast('🌲 林業試験場 現地調査アプリ 起動完了', 3000);
updateStatusText('待機中 - 📍で現在地取得');
