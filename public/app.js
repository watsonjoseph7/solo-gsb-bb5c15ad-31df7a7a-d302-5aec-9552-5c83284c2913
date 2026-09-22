/* 临时施工区域冲突分析台 - 前端逻辑 */
'use strict';

// ---------- 状态 ----------
const state = {
  zones: [],
  layers: [],
  selectedLayers: new Set(),
  lastResult: null,
  typeFilter: 'all',
  lastPrecheck: null,   // 最近一次质量预检结果
  selectedClusterId: null, // 当前选中的冲突协调集群（null = 全量视图）
  analyses: [],         // 已保存分析列表（对比选择器复用）
  lastComparison: null, // 最近一次分析对比结果
  compareCat: 'all',    // 对比结果分类筛选
};

// 冲突类型展示配置
const CONFLICT_TYPES = {
  spatial: { label: '空间冲突', color: '#d0000b' },
  resource: { label: '资源冲突', color: '#e8590c' },
  both: { label: '空间+资源冲突', color: '#9c36b5' },
};
function typeLabel(t) {
  return (CONFLICT_TYPES[t] || {}).label || t || '空间冲突';
}

// 关键区域（集群割点）地图样式：金色虚线描边 + 菱形标记
const CRITICAL_STYLE = { color: '#f59f00', weight: 3.5, dashArray: '8 4', fillColor: '#f59f00', fillOpacity: 0.22 };
const DIMMED_STYLE = { color: '#bbb', weight: 1, fillColor: '#bbb', fillOpacity: 0.05 };

// ---------- 地图 ----------
const map = L.map('map').setView([31.23, 121.47], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

const zonesLayer = L.layerGroup().addTo(map);
const conflictsLayer = L.layerGroup().addTo(map);
const criticalMarkersLayer = L.layerGroup().addTo(map);
const zoneGeoLayers = new Map(); // zoneId -> Leaflet 图层（便于按集群切换样式）

const LAYER_COLORS = ['#2b8a3e', '#1971c2', '#e8590c', '#9c36b5', '#c2255c', '#0b7285', '#5f3dc4', '#a61e4d'];
function layerColor(layer) {
  const idx = Math.max(0, state.layers.indexOf(layer));
  return LAYER_COLORS[idx % LAYER_COLORS.length];
}

// ---------- 工具 ----------
const $ = (id) => document.getElementById(id);

function fmtArea(m2) {
  return m2 >= 10000 ? `${(m2 / 10000).toFixed(2)} 公顷` : `${m2.toLocaleString('zh-CN')} m²`;
}
function fmtDate(iso) {
  return iso ? iso.slice(0, 10) : '-';
}
function showMsg(el, text, ok) {
  el.textContent = text;
  el.className = `msg ${ok ? 'ok' : 'err'}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    let msg = `请求失败 (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

// ---------- 区域渲染 ----------
function renderZones() {
  $('zoneCount').textContent = state.zones.length;
  const list = $('zoneList');
  list.innerHTML = '';

  zonesLayer.clearLayers();
  zoneGeoLayers.clear();
  const bounds = [];

  for (const z of state.zones) {
    const li = document.createElement('li');
    const resTags = (z.resources || []).length
      ? `<div class="meta">资源：${z.resources.map(escapeHtml).join('、')}</div>`
      : '';
    li.innerHTML = `
      <span>
        <span class="badge" style="background:${layerColor(z.layer)};color:#fff">${escapeHtml(z.layer)}</span>
        <strong>${escapeHtml(z.name)}</strong>
        <div class="meta">${fmtDate(z.start)} ~ ${fmtDate(z.end)}</div>
        ${resTags}
      </span>`;
    const del = document.createElement('button');
    del.className = 'danger small';
    del.textContent = '删除';
    del.onclick = () => deleteZone(z.id);
    li.appendChild(del);
    list.appendChild(li);

    const popupHtml =
      `<b>${escapeHtml(z.name)}</b><br>图层：${escapeHtml(z.layer)}<br>${fmtDate(z.start)} ~ ${fmtDate(z.end)}` +
      ((z.resources || []).length ? `<br>资源：${z.resources.map(escapeHtml).join('、')}` : '');
    const geo = L.geoJSON(
      { type: 'Feature', geometry: z.geometry, properties: z },
      {
        style: { color: layerColor(z.layer), weight: 2, fillOpacity: 0.15 },
        onEachFeature: (f, l) => l.bindPopup(popupHtml),
      }
    );
    geo._defaultPopupHtml = popupHtml; // 恢复全量视图时还原弹窗内容
    geo.addTo(zonesLayer);
    zoneGeoLayers.set(z.id, geo);
    try { bounds.push(geo.getBounds()); } catch { /* ignore */ }
  }

  if (bounds.length) {
    const b = bounds.reduce((acc, cur) => acc.extend(cur));
    map.fitBounds(b.pad(0.1));
  }

  // 区域库变化后重新套用集群样式（如集群中的区域被删除，退回全量视图）
  if (state.selectedClusterId && state.lastResult) {
    const stillExists = (state.lastResult.clusters || []).some((cl) => cl.id === state.selectedClusterId)
      && clusterZoneIds(state.selectedClusterId).every((id) => zoneGeoLayers.has(id));
    if (stillExists) {
      applyClusterZoneStyles(state.selectedClusterId);
    } else {
      resetClusterView();
    }
  }
}

function renderLayerFilters() {
  const box = $('layerFilters');
  box.innerHTML = '';
  if (!state.layers.length) {
    box.innerHTML = '<em>暂无图层</em>';
    return;
  }
  for (const layer of state.layers) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selectedLayers.has(layer);
    cb.onchange = () => {
      cb.checked ? state.selectedLayers.add(layer) : state.selectedLayers.delete(layer);
    };
    const swatch = document.createElement('span');
    swatch.style.cssText = `display:inline-block;width:12px;height:12px;border-radius:2px;background:${layerColor(layer)}`;
    label.append(cb, swatch, document.createTextNode(` ${layer}`));
    box.appendChild(label);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- 数据加载 ----------
async function refreshZones() {
  const [{ zones }, { layers }] = await Promise.all([api('/api/zones'), api('/api/layers')]);
  state.zones = zones;
  state.layers = layers;
  layers.forEach((l) => state.selectedLayers.add(l)); // 新图层默认勾选
  renderZones();
  renderLayerFilters();
}

// ---------- 质量预检与规范化导入 ----------
async function runPrecheck(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    showMsg($('importMsg'), 'JSON 解析失败，请检查格式', false);
    return;
  }
  try {
    const result = await api('/api/zones/precheck', { method: 'POST', body: JSON.stringify(data) });
    state.lastPrecheck = result;
    renderPrecheck(result);
    $('precheckModal').hidden = false;
    if (result.summary.blocked === 0) {
      showMsg($('importMsg'), `预检完成：${result.summary.passed} 个要素全部可导入（${result.summary.withWarnings} 个含可自动修复的警告）`, true);
    } else {
      showMsg($('importMsg'), `预检完成：${result.summary.passed} 个可导入，${result.summary.blocked} 个存在错误需处理`, false);
    }
  } catch (err) {
    showMsg($('importMsg'), err.message, false);
  }
}

const QC_STATUS = {
  pass: { label: '通过', cls: 'pass' },
  warning: { label: '可导入（已规范化）', cls: 'warn' },
  error: { label: '错误，不可导入', cls: 'err' },
};

function renderPrecheck(result) {
  const s = result.summary;
  $('precheckSummary').innerHTML = `
    <span class="qc-stat total">共 ${s.total} 个要素</span>
    <span class="qc-stat pass">✓ 通过 ${s.passed}</span>
    <span class="qc-stat warn">⚠ 警告 ${s.warningCount} 条（涉及 ${s.withWarnings} 个要素，自动修复 ${s.fixedWarningCount} 处）</span>
    <span class="qc-stat err">✕ 错误 ${s.errorCount} 条（涉及 ${s.blocked} 个要素）</span>`;

  const list = $('precheckReportList');
  list.innerHTML = '';
  result.reports.forEach((r) => {
    const card = document.createElement('div');
    card.className = `qc-item qc-${r.status}`;
    const st = QC_STATUS[r.status];

    const head = document.createElement('div');
    head.className = 'qc-item-head';
    const canImport = r.status !== 'error';
    head.innerHTML = `
      <label class="qc-pick">
        <input type="checkbox" data-index="${r.index}" ${canImport ? '' : 'disabled'} ${canImport ? 'checked' : ''} />
      </label>
      <span class="qc-status qc-badge-${r.status}">${st.label}</span>
      <strong>#${r.index + 1} ${escapeHtml(r.name)}</strong>
      <code class="qc-path">${escapeHtml(r.sourcePath)}</code>`;
    card.appendChild(head);

    const issues = [...r.errors, ...r.warnings];
    if (issues.length) {
      const ul = document.createElement('ul');
      ul.className = 'qc-issues';
      for (const it of issues) {
        const li = document.createElement('li');
        const tag = it.severity === 'error'
          ? '<span class="qc-tag qc-tag-err">错误</span>'
          : `<span class="qc-tag qc-tag-warn">警告${it.fixed ? '·已修复' : ''}</span>`;
        li.innerHTML = `${tag} ${escapeHtml(it.message)} <code class="qc-path">${escapeHtml(it.path)}</code>`;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    if (canImport && r.normalized) {
      const det = document.createElement('details');
      const p = r.normalized.properties;
      det.innerHTML = `<summary>规范化预览</summary>
        <div class="qc-preview">
          <div>start：<code>${escapeHtml(p.start)}</code></div>
          <div>end：<code>${escapeHtml(p.end)}</code></div>
          <div>layer：<code>${escapeHtml(p.layer)}</code></div>
          <div>resources：<code>${escapeHtml((p.resources || []).join('、') || '（无）')}</code></div>
          <div>geometry：${r.normalized.geometry.type}，${countPositions(r.normalized.geometry)} 个位置（已显式闭合、去除重复点）</div>
        </div>`;
      card.appendChild(det);
    }

    list.appendChild(card);
  });

  syncSelectAll();
}

function countPositions(geometry) {
  let n = 0;
  (function walk(c) {
    if (typeof c[0] === 'number') { n += 1; } else { c.forEach(walk); }
  })(geometry.coordinates);
  return n;
}

/** 当前弹窗中勾选的要素原始索引 */
function selectedIndexes() {
  return [...document.querySelectorAll('#precheckReportList input[type=checkbox]:checked')]
    .map((cb) => Number(cb.dataset.index));
}

function syncSelectAll() {
  const cb = $('selectAllPassed');
  const enabled = [...document.querySelectorAll('#precheckReportList input[type=checkbox]:not(:disabled)')];
  const checked = [...document.querySelectorAll('#precheckReportList input[type=checkbox]:checked')];
  cb.checked = enabled.length > 0 && enabled.length === checked.length;
}

async function commitImport() {
  const result = state.lastPrecheck;
  if (!result) return;
  const indexes = selectedIndexes();
  if (!indexes.length) {
    alert('请至少勾选一个无错误的要素');
    return;
  }
  try {
    // 以预检返回的规范化集合为提交内容，服务端会再次复检
    const selectedSet = new Set(indexes);
    const selectedReports = result.reports
      .filter((r) => selectedSet.has(r.index) && r.normalized);
    const fixedInSelection = selectedReports.reduce(
      (n, r) => n + r.warnings.filter((w) => w.fixed).length, 0
    );
    const geojson = {
      type: 'FeatureCollection',
      features: selectedReports.map((r) => r.normalized),
    };
    const res = await api('/api/zones/commit', {
      method: 'POST',
      body: JSON.stringify({ geojson }),
    });
    $('precheckModal').hidden = true;
    showMsg($('importMsg'),
      `已导入 ${res.imported} 个区域` + (fixedInSelection ? `（导入前自动规范化 ${fixedInSelection} 处）` : ''),
      true);
    $('geojsonInput').value = '';
    state.lastPrecheck = null;
    await refreshZones();
  } catch (err) {
    alert(`导入失败：${err.message}`);
  }
}

function downloadNormalized() {
  const result = state.lastPrecheck;
  if (!result) return;
  const indexes = selectedIndexes();
  const selectedSet = new Set(indexes);
  // 勾选了要素时只下载勾选项；无勾选则下载全部通过项
  const features = indexes.length
    ? result.reports.filter((r) => selectedSet.has(r.index) && r.normalized).map((r) => r.normalized)
    : result.normalized.features;
  if (!features.length) {
    alert('没有可下载的规范化要素（均存在错误）');
    return;
  }
  const geojson = {
    type: 'FeatureCollection',
    metadata: {
      generatedAt: result.generatedAt,
      source: 'quality-precheck',
      total: result.summary.total,
      passed: features.length,
      blocked: result.summary.blocked,
      warningsFixed: result.summary.fixedWarningCount,
    },
    features,
  };
  const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `normalized-${new Date().toISOString().slice(0, 10)}.geojson`;
  a.click();
  URL.revokeObjectURL(url);
}

async function deleteZone(id) {
  await api(`/api/zones/${id}`, { method: 'DELETE' });
  await refreshZones();
}

// ---------- 分析 ----------
async function runAnalysis() {
  const layers = state.layers.filter((l) => state.selectedLayers.has(l));
  const body = {
    layers,
    start: $('rangeStart').value || undefined,
    end: $('rangeEnd').value || undefined,
  };
  try {
    const result = await api('/api/analyze', { method: 'POST', body: JSON.stringify(body) });
    state.lastResult = result;
    resetClusterView();
    renderConflicts(result);
  } catch (err) {
    alert(`分析失败：${err.message}`);
  }
}

// ---------- 冲突协调集群 ----------

function getCluster(id) {
  return (state.lastResult?.clusters || []).find((cl) => cl.id === id) || null;
}

function clusterZoneIds(id) {
  const cl = getCluster(id);
  return cl ? cl.zoneIds : [];
}

function renderClusters(result) {
  const box = $('clusterList');
  box.innerHTML = '';
  const clusters = result.clusters || [];
  $('clusterSummary').textContent = clusters.length
    ? `${clusters.length} 个集群 · ${result.conflictCount} 处冲突`
    : result.conflicts.length
      ? '0 个集群（冲突未形成多区域连通分量）'
      : '0 个集群';

  if (!clusters.length) {
    box.innerHTML = '<em>本次分析没有形成含两个及以上区域的冲突集群。</em>';
    return;
  }

  for (const cl of clusters) {
    const card = document.createElement('div');
    card.className = 'cluster-item' + (cl.id === state.selectedClusterId ? ' active' : '');
    card.onclick = () => selectCluster(cl.id === state.selectedClusterId ? null : cl.id);

    const t = cl.conflictCountByType || {};
    const criticalSet = new Set(cl.criticalZones);
    const zoneTags = cl.zones
      .map((z) => `<span class="cluster-zone${criticalSet.has(z.id) ? ' critical' : ''}" title="${criticalSet.has(z.id) ? '关键区域：移除后集群将分裂' : ''}">${criticalSet.has(z.id) ? '◆ ' : ''}${escapeHtml(z.name)}</span>`)
      .join(' ');
    card.innerHTML = `
      <div class="cluster-title">
        <strong>${escapeHtml(cl.id.replace('cluster-', '集群 '))}</strong>
        <span class="cluster-metric">${cl.conflictCount} 处冲突 · ${cl.zoneIds.length} 个区域 · 累计重叠 ${cl.totalOverlapDays} 天</span>
      </div>
      <div class="cluster-types">
        <span class="ct-tag spatial">空间 ${t.spatial || 0}</span>
        <span class="ct-tag resource">资源 ${t.resource || 0}</span>
        <span class="ct-tag both">空间+资源 ${t.both || 0}</span>
        ${cl.criticalZones.length ? `<span class="ct-tag critical">◆ 关键区域 ${cl.criticalZones.length}</span>` : '<span class="ct-tag none">无关键区域</span>'}
      </div>
      <div class="cluster-zones">${zoneTags}</div>`;
    box.appendChild(card);
  }
}

function selectCluster(id) {
  state.selectedClusterId = id;
  renderClusters(state.lastResult);
  renderConflicts(state.lastResult);
  if (id) {
    applyClusterZoneStyles(id);
    fitCluster(id);
  } else {
    resetClusterView();
  }
}

function resetClusterView() {
  state.selectedClusterId = null;
  criticalMarkersLayer.clearLayers();
  for (const [zoneId, geo] of zoneGeoLayers) {
    const z = state.zones.find((zz) => zz.id === zoneId);
    const color = z ? layerColor(z.layer) : '#666';
    geo.setStyle({ color, weight: 2, fillColor: color, fillOpacity: 0.15, dashArray: null });
    if (geo._defaultPopupHtml !== undefined) geo.setPopupContent(geo._defaultPopupHtml);
  }
  $('resetClusterBtn').hidden = true;
  $('clusterScope').hidden = true;
}

/** 按集群过滤区域样式：集群内区域保留图层色并加粗，关键区域金色虚线，其余区域淡出 */
function applyClusterZoneStyles(id) {
  const cl = getCluster(id);
  $('resetClusterBtn').hidden = !cl;
  criticalMarkersLayer.clearLayers();
  if (!cl) {
    $('clusterScope').hidden = true;
    return;
  }
  $('clusterScope').hidden = false;
  $('clusterScope').textContent =
    `已按 ${cl.id.replace('cluster-', '集群 ')} 过滤（${cl.conflictCount} 处冲突）`;

  const memberIds = new Set(cl.zoneIds);
  const criticalSet = new Set(cl.criticalZones);
  for (const [zoneId, geo] of zoneGeoLayers) {
    const z = state.zones.find((zz) => zz.id === zoneId);
    const color = z ? layerColor(z.layer) : '#666';
    if (criticalSet.has(zoneId)) {
      geo.setStyle(CRITICAL_STYLE);
      geo.setPopupContent(
        `◆ <b>关键区域：${escapeHtml(z?.name || zoneId)}</b><br>移除该区域将导致「${cl.id.replace('cluster-', '集群 ')}」分裂` +
        (z ? `<br>图层：${escapeHtml(z.layer)}<br>${fmtDate(z.start)} ~ ${fmtDate(z.end)}` : '')
      );
      addCriticalMarker(geo);
    } else if (memberIds.has(zoneId)) {
      geo.setStyle({ color, weight: 3, fillColor: color, fillOpacity: 0.2, dashArray: null });
    } else {
      geo.setStyle(DIMMED_STYLE);
    }
  }
}

/** 在关键区域质心放置金色菱形标记（使用区域几何质心，不依赖额外坐标字段） */
function addCriticalMarker(geo) {
  try {
    const center = geo.getBounds().getCenter();
    const icon = L.divIcon({
      className: 'critical-marker',
      html: '◆',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
    L.marker(center, { icon, interactive: false, keyboard: false }).addTo(criticalMarkersLayer);
  } catch { /* ignore */ }
}

/** 地图视角缩放到集群内区域（区域不在当前区域库时不调整视角） */
function fitCluster(id) {
  const cl = getCluster(id);
  if (!cl) return;
  const bounds = [];
  for (const zoneId of cl.zoneIds) {
    const geo = zoneGeoLayers.get(zoneId);
    if (geo) { try { bounds.push(geo.getBounds()); } catch { /* ignore */ } }
  }
  if (bounds.length) {
    map.fitBounds(bounds.reduce((acc, cur) => acc.extend(cur)).pad(0.15));
  }
}

function renderConflicts(result) {
  const counts = result.conflictCountByType || {
    spatial: result.conflicts.filter((c) => c.conflictType === 'spatial').length,
    resource: result.conflicts.filter((c) => c.conflictType === 'resource').length,
    both: result.conflicts.filter((c) => c.conflictType === 'both').length,
  };
  $('conflictSummary').textContent =
    `${result.conflictCount} 处冲突（空间 ${counts.spatial} / 资源 ${counts.resource} / 空间+资源 ${counts.both}）` +
    ` · 重叠面积共 ${fmtArea(result.totalConflictAreaM2)}`;

  renderClusters(result);
  const selectedCluster = state.selectedClusterId ? getCluster(state.selectedClusterId) : null;
  if (selectedCluster) {
    $('resetClusterBtn').hidden = false;
    $('clusterScope').hidden = false;
    $('clusterScope').textContent =
      `已按 ${selectedCluster.id.replace('cluster-', '集群 ')} 过滤（${selectedCluster.conflictCount} 处冲突）`;
  }

  conflictsLayer.clearLayers();
  const list = $('conflictList');
  list.innerHTML = '';

  // 先按选中集群过滤冲突，再按冲突类型筛选
  let visible = result.conflicts;
  if (selectedCluster) {
    const idSet = new Set(selectedCluster.conflictIds);
    visible = visible.filter((c) => idSet.has(c.id));
  }
  const filtered = state.typeFilter === 'all'
    ? visible
    : visible.filter((c) => c.conflictType === state.typeFilter);

  if (!result.conflicts.length) {
    list.innerHTML = '<em>未发现时空重叠或共享资源冲突。</em>';
    return;
  }
  if (selectedCluster && !visible.length) {
    list.innerHTML = '<em>该集群下没有冲突。</em>';
    return;
  }
  if (!filtered.length) {
    list.innerHTML = '<em>当前筛选条件下没有冲突，请切换筛选条件或恢复全量视图。</em>';
    return;
  }

  const clusterOfConflict = new Map();
  (result.clusters || []).forEach((cl) => cl.conflictIds.forEach((cid) => clusterOfConflict.set(cid, cl)));

  filtered.forEach((c) => {
    const idx = result.conflicts.indexOf(c); // 保持完整结果中的编号稳定
    const typeInfo = CONFLICT_TYPES[c.conflictType] || CONFLICT_TYPES.spatial;
    const ownerCluster = clusterOfConflict.get(c.id);

    // 地图高亮相交区域（纯资源冲突无空间相交，不上图）
    let geo = null;
    if (c.geometry) {
      geo = L.geoJSON(
        { type: 'Feature', geometry: c.geometry, properties: c },
        { style: { color: typeInfo.color, weight: 2, fillColor: typeInfo.color, fillOpacity: 0.45 } }
      );
      geo.bindPopup(
        `<b>冲突 ${idx + 1}（${typeLabel(c.conflictType)}）</b><br>` +
        `${escapeHtml(c.zones.map((z) => z.name).join(' ∩ '))}<br>` +
        `重叠面积：${fmtArea(c.areaM2)}<br>重叠期：${fmtDate(c.overlapStart)} ~ ${fmtDate(c.overlapEnd)}（${c.overlapDays} 天）` +
        ((c.sharedResources || []).length ? `<br>共享资源：${c.sharedResources.map(escapeHtml).join('、')}` : '')
      );
      geo.addTo(conflictsLayer);
    }

    // 列表项
    const item = document.createElement('div');
    item.className = 'conflict-item';
    item.style.borderLeftColor = typeInfo.color;
    const zoneTags = c.zones
      .map((z) => `<span class="tag">${escapeHtml(z.name)}（${escapeHtml(z.layer)}）</span>`)
      .join(' ');
    const resTags = (c.sharedResources || []).length
      ? `<br>共享资源：${c.sharedResources.map((r) => `<span class="tag resource">${escapeHtml(r)}</span>`).join(' ')}`
      : '';
    const areaLine = c.geometry ? `重叠面积 ${fmtArea(c.areaM2)}` : '无空间相交（仅资源冲突）';
    const clusterLine = ownerCluster
      ? `<span class="tag cluster-tag" title="所属冲突协调集群">🔗 ${escapeHtml(ownerCluster.id.replace('cluster-', '集群 '))}</span>`
      : '';
    const suggestions = c.suggestions.map((s) => `<li>${escapeHtml(s.text)}</li>`).join('');
    item.innerHTML = `
      <h3>
        <span class="type-badge" style="background:${typeInfo.color}">${typeLabel(c.conflictType)}</span>
        #${idx + 1} ${areaLine}
      </h3>
      <div class="stats">
        ${zoneTags}${resTags}<br>
        重叠时段：${fmtDate(c.overlapStart)} ~ ${fmtDate(c.overlapEnd)}（${c.overlapDays} 天）
        ${clusterLine ? `<br>${clusterLine}` : ''}
      </div>
      <details>
        <summary>错峰建议（${c.suggestions.length} 条）</summary>
        <ul class="suggestions">${suggestions}</ul>
      </details>`;
    if (geo) {
      item.onclick = () => {
        map.fitBounds(geo.getBounds().pad(0.3));
        geo.openPopup();
      };
    } else {
      item.classList.add('no-geometry');
    }
    list.appendChild(item);
  });
}

// ---------- 已保存分析 ----------
async function refreshAnalyses() {
  const { analyses } = await api('/api/analyses');
  state.analyses = analyses;
  const list = $('analysisList');
  list.innerHTML = '';
  if (!analyses.length) {
    list.innerHTML = '<li><em>暂无已保存分析</em></li>';
  }
  for (const a of analyses) {
    const li = document.createElement('li');
    const typeInfo = a.conflictCountByType
      ? `（空间 ${a.conflictCountByType.spatial} / 资源 ${a.conflictCountByType.resource} / 空间+资源 ${a.conflictCountByType.both}）`
      : '';
    const clusterInfo = a.clusterCount ? ` · ${a.clusterCount} 个协调集群` : '';
    li.innerHTML = `
      <span>
        <strong>${escapeHtml(a.name)}</strong>
        <div class="meta">${new Date(a.savedAt).toLocaleString('zh-CN')} · ${a.conflictCount} 处冲突${typeInfo}${clusterInfo} · ${fmtArea(a.totalConflictAreaM2)}</div>
      </span>`;
    const btns = document.createElement('span');
    btns.className = 'row';
    btns.style.marginBottom = '0';

    const view = document.createElement('button');
    view.className = 'small';
    view.textContent = '查看';
    view.onclick = async () => {
      const record = await api(`/api/analyses/${a.id}`);
      state.lastResult = record.result;
      resetClusterView();
      renderConflicts(record.result);
    };

    const exp = document.createElement('button');
    exp.className = 'small';
    exp.textContent = '导出';
    exp.onclick = () => { window.location.href = `/api/analyses/${a.id}/export`; };

    const del = document.createElement('button');
    del.className = 'danger small';
    del.textContent = '删除';
    del.onclick = async () => {
      await api(`/api/analyses/${a.id}`, { method: 'DELETE' });
      await refreshAnalyses();
    };

    btns.append(view, exp, del);
    li.appendChild(btns);
    list.appendChild(li);
  }

  renderCompareSelectors();
}

// ---------- 分析对比 ----------
function analysisOptionLabel(a) {
  const t = new Date(a.savedAt).toLocaleString('zh-CN');
  return `${a.name}（${t} · ${a.conflictCount} 处冲突）`;
}

/** 刷新对比下拉框，尽量保留已选；默认按保存时间把较早的选为基线、较晚的选为对照 */
function renderCompareSelectors() {
  const baselineSel = $('compareBaseline');
  const comparisonSel = $('compareComparison');
  const prevBase = baselineSel.value;
  const prevCmp = comparisonSel.value;
  const analyses = [...state.analyses].sort(
    (a, b) => Date.parse(a.savedAt) - Date.parse(b.savedAt)
  );

  for (const sel of [baselineSel, comparisonSel]) {
    sel.innerHTML = '';
    if (analyses.length < 2) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = analyses.length ? '还需再保存一条分析' : '暂无已保存分析';
      sel.appendChild(opt);
      sel.disabled = true;
    } else {
      sel.disabled = false;
      for (const a of analyses) {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = analysisOptionLabel(a);
        sel.appendChild(opt);
      }
    }
  }

  if (analyses.length >= 2) {
    baselineSel.value = analyses.some((a) => a.id === prevBase)
      ? prevBase
      : analyses[0].id;
    comparisonSel.value = analyses.some((a) => a.id === prevCmp)
      ? prevCmp
      : analyses[analyses.length - 1].id;
    // 两条恰好相同时，把对照切到另一条
    if (baselineSel.value === comparisonSel.value) {
      const other = analyses.find((a) => a.id !== baselineSel.value);
      if (other) comparisonSel.value = other.id;
    }
  }
  $('compareBtn').disabled = analyses.length < 2;
}

async function runComparison() {
  const baselineId = $('compareBaseline').value;
  const comparisonId = $('compareComparison').value;
  const msg = $('compareMsg');
  if (!baselineId || !comparisonId) {
    showMsg(msg, '请选择两条已保存分析', false);
    return;
  }
  if (baselineId === comparisonId) {
    showMsg(msg, '基线与对照不能是同一条分析，请重新选择', false);
    return;
  }
  try {
    const result = await api('/api/analyses/compare', {
      method: 'POST',
      body: JSON.stringify({ baselineId, comparisonId }),
    });
    state.lastComparison = result;
    state.compareCat = 'all';
    msg.textContent = '';
    msg.className = 'msg';
    renderComparison(result);
  } catch (err) {
    state.lastComparison = null;
    $('compareResultCard').hidden = true;
    showMsg(msg, err.message, false);
  }
}

const COMPARE_CATS = {
  added: { label: '新增冲突', cls: 'added' },
  resolved: { label: '已解决', cls: 'resolved' },
  persistent: { label: '持续冲突', cls: 'persistent' },
};

function renderComparison(result) {
  const card = $('compareResultCard');
  card.hidden = false;
  const s = result.summary;
  $('compareSummary').textContent =
    `${s.beforeConflictCount} → ${s.afterConflictCount} 处冲突`;
  $('compareMeta').innerHTML =
    `基线：<strong>${escapeHtml(result.baseline.name)}</strong>（${fmtDate(result.baseline.savedAt)}）` +
    ` ➜ 对照：<strong>${escapeHtml(result.comparison.name)}</strong>（${fmtDate(result.comparison.savedAt)}）` +
    ` · 共 ${result.zoneCount} 个相同区域`;

  const counts = {
    all: s.added + s.resolved + s.persistent,
    added: s.added,
    resolved: s.resolved,
    persistent: s.persistent,
    changed: s.persistentChanged,
  };
  document.querySelectorAll('#compareTabs .tab-count').forEach((el) => {
    el.textContent = counts[el.dataset.count];
  });
  document.querySelectorAll('#compareTabs .compare-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.cat === state.compareCat);
  });

  renderComparisonList();
}

function comparisonEntries(result) {
  const all = [
    ...result.added.map((e) => ({ cat: 'added', ...e })),
    ...result.resolved.map((e) => ({ cat: 'resolved', ...e })),
    ...result.persistent.map((e) => ({ cat: 'persistent', ...e })),
  ];
  if (state.compareCat === 'changed') {
    return all.filter((e) => e.cat === 'persistent' && e.changed);
  }
  return state.compareCat === 'all' ? all : all.filter((e) => e.cat === state.compareCat);
}

function zonePairHtml(zones) {
  return (zones || [])
    .filter(Boolean)
    .map((z) => `<span class="tag">${escapeHtml(z.name)}${z.layer ? `（${escapeHtml(z.layer)}）` : ''}</span>`)
    .join(' <span class="pair-x">×</span> ');
}

function conflictBriefHtml(c) {
  const typeTag = `<span class="type-badge" style="background:${(CONFLICT_TYPES[c.conflictType] || {}).color || '#777'}">${typeLabel(c.conflictType)}</span>`;
  const res = (c.sharedResources || []).length
    ? `共享资源：${c.sharedResources.map((r) => `<span class="tag resource">${escapeHtml(r)}</span>`).join(' ')}<br>`
    : '';
  const area = c.geometry ? fmtArea(c.areaM2) : '无空间相交（仅资源冲突）';
  return `${typeTag}<br>${res}重叠时段：${fmtDate(c.overlapStart)} ~ ${fmtDate(c.overlapEnd)}（${c.overlapDays ?? '-'} 天）<br>重叠面积：${area}`;
}

function changeRowsHtml(changes) {
  return changes.map((ch) => {
    if (ch.field === 'conflictType') {
      return `<li>冲突类型：<span class="cmp-before">${escapeHtml(typeLabel(ch.before))}</span> → <span class="cmp-after">${escapeHtml(typeLabel(ch.after))}</span></li>`;
    }
    if (ch.field === 'overlap') {
      const b = ch.before;
      const a = ch.after;
      return `<li>重叠起止/天数：` +
        `<span class="cmp-before">${fmtDate(b.start)} ~ ${fmtDate(b.end)}（${b.days ?? '-'} 天）</span> → ` +
        `<span class="cmp-after">${fmtDate(a.start)} ~ ${fmtDate(a.end)}（${a.days ?? '-'} 天）</span></li>`;
    }
    if (ch.field === 'sharedResources') {
      const added = ch.added.length ? `新增 ${ch.added.map((r) => `<span class="tag resource cmp-add">${escapeHtml(r)}</span>`).join(' ')}` : '';
      const removed = ch.removed.length ? `移除 ${ch.removed.map((r) => `<span class="tag resource cmp-rm">${escapeHtml(r)}</span>`).join(' ')}` : '';
      return `<li>共享资源变化：${added}${added && removed ? '；' : ''}${removed}</li>`;
    }
    return '';
  }).join('');
}

function renderComparisonList() {
  const result = state.lastComparison;
  const box = $('compareList');
  box.innerHTML = '';
  if (!result) return;

  const entries = comparisonEntries(result);
  if (!entries.length) {
    const emptyText = {
      added: '该分类下没有新增冲突。',
      resolved: '该分类下没有已解决冲突。',
      persistent: '该分类下没有持续冲突。',
      changed: '持续冲突均无属性变化。',
      all: '两次分析完全一致，没有任何差异。',
    }[state.compareCat];
    box.innerHTML = `<em>${emptyText}</em>`;
    return;
  }

  for (const e of entries) {
    const item = document.createElement('div');
    item.className = `compare-item cmp-${e.cat}`;
    const cat = COMPARE_CATS[e.cat];
    let body = '';

    if (e.cat === 'added') {
      body = `
        <div class="cmp-zones">${zonePairHtml(e.zones)}</div>
        <div class="cmp-detail"><span class="cmp-side-label cmp-after">新增（仅对照分析存在）</span><br>${conflictBriefHtml(e.conflict)}</div>`;
    } else if (e.cat === 'resolved') {
      body = `
        <div class="cmp-zones">${zonePairHtml(e.zones)}</div>
        <div class="cmp-detail"><span class="cmp-side-label cmp-before">已解决（仅基线分析存在）</span><br>${conflictBriefHtml(e.conflict)}</div>`;
    } else {
      const changeBadge = e.changed
        ? '<span class="cmp-status changed">⚠ 属性变化</span>'
        : '<span class="cmp-status unchanged">属性未变</span>';
      const changes = e.changed
        ? `<ul class="cmp-changes">${changeRowsHtml(e.changes)}</ul>`
        : '';
      const areaLine = e.beforeAreaM2 !== e.afterAreaM2
        ? `<li class="cmp-area-note">重叠面积：${fmtArea(e.beforeAreaM2)} → ${fmtArea(e.afterAreaM2)}</li>`
        : '';
      body = `
        <div class="cmp-zones">${zonePairHtml(e.zones)} ${changeBadge}</div>
        ${changes}${areaLine}
        <details>
          <summary>查看两侧冲突详情</summary>
          <div class="cmp-sides">
            <div class="cmp-side"><div class="cmp-side-label cmp-before">基线</div>${conflictBriefHtml(e.before)}</div>
            <div class="cmp-side"><div class="cmp-side-label cmp-after">对照</div>${conflictBriefHtml(e.after)}</div>
          </div>
        </details>`;
    }

    item.innerHTML = `<h3><span class="cmp-cat-tag cmp-tag-${e.cat}">${cat.label}</span></h3>${body}`;
    box.appendChild(item);
  }
}

// ---------- 事件绑定 ----------
$('precheckBtn').onclick = () => runPrecheck($('geojsonInput').value.trim());

$('fileInput').onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { $('geojsonInput').value = reader.result; };
  reader.readAsText(file);
};

$('loadSampleBtn').onclick = async () => {
  const res = await fetch('/sample.geojson');
  $('geojsonInput').value = JSON.stringify(await res.json(), null, 2);
};

$('loadIssuesSampleBtn').onclick = async () => {
  const res = await fetch('/sample-issues.geojson');
  $('geojsonInput').value = JSON.stringify(await res.json(), null, 2);
};

// 预检结果弹窗
$('precheckCloseBtn').onclick = () => { $('precheckModal').hidden = true; };
$('precheckModal').onclick = (e) => {
  if (e.target.id === 'precheckModal') $('precheckModal').hidden = true;
};
$('commitImportBtn').onclick = commitImport;
$('downloadNormalizedBtn').onclick = downloadNormalized;
$('selectAllPassed').onchange = (e) => {
  document.querySelectorAll('#precheckReportList input[type=checkbox]:not(:disabled)')
    .forEach((cb) => { cb.checked = e.target.checked; });
};
document.addEventListener('change', (e) => {
  if (e.target.matches('#precheckReportList input[type=checkbox]')) syncSelectAll();
});

$('clearBtn').onclick = async () => {
  if (!confirm('确定清空全部已导入区域？')) return;
  await api('/api/zones', { method: 'DELETE' });
  state.selectedLayers.clear();
  conflictsLayer.clearLayers();
  criticalMarkersLayer.clearLayers();
  state.lastResult = null;
  state.selectedClusterId = null;
  $('conflictList').innerHTML = '<em>运行分析后在此展示，按重叠面积降序排列。</em>';
  $('conflictSummary').textContent = '未运行';
  $('clusterSummary').textContent = '未运行';
  $('clusterList').innerHTML = '<em>运行分析后在此展示协调集群（仅含两个及以上区域的连通分量）。</em>';
  $('resetClusterBtn').hidden = true;
  $('clusterScope').hidden = true;
  $('typeFilter').value = 'all';
  state.typeFilter = 'all';
  await refreshZones();
};

$('analyzeBtn').onclick = runAnalysis;

$('resetClusterBtn').onclick = () => {
  if (state.lastResult) selectCluster(null);
};

$('typeFilter').onchange = (e) => {
  state.typeFilter = e.target.value;
  if (state.lastResult) renderConflicts(state.lastResult);
};

$('saveAnalysisBtn').onclick = async () => {
  if (!state.lastResult) {
    alert('请先运行一次分析');
    return;
  }
  try {
    await api('/api/analyses', {
      method: 'POST',
      body: JSON.stringify({
        name: $('analysisName').value || undefined,
        params: state.lastResult.params,
        result: state.lastResult,
      }),
    });
    $('analysisName').value = '';
    await refreshAnalyses();
  } catch (err) {
    alert(`保存失败：${err.message}`);
  }
};

$('compareBtn').onclick = runComparison;
document.querySelectorAll('#compareTabs .compare-tab').forEach((btn) => {
  btn.onclick = () => {
    state.compareCat = btn.dataset.cat;
    if (state.lastComparison) renderComparison(state.lastComparison);
  };
});

// ---------- 启动 ----------
(async function init() {
  try {
    await Promise.all([refreshZones(), refreshAnalyses()]);
  } catch (err) {
    console.error('初始化失败', err);
  }
})();
