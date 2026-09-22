'use strict';

const pc = require('polygon-clipping');
const { multiPolygonArea, centroidOfCoords } = require('./geo');
const { buildClusters } = require('./clusters');

const DAY_MS = 24 * 60 * 60 * 1000;

/** 冲突类型：空间冲突 / 资源冲突 / 空间+资源冲突（两者同时满足时合并为一条） */
const CONFLICT_TYPES = { SPATIAL: 'spatial', RESOURCE: 'resource', BOTH: 'both' };

/** 解析时间字符串为毫秒时间戳；非法返回 null */
function parseTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * 规范化 properties.resources 为去重后的字符串数组。
 * 兼容：字符串数组（标准）、逗号/顿号分隔的单个字符串、缺省。
 */
function normalizeResources(value) {
  const parts = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,，、;；]/)
      : [];
  return [...new Set(
    parts
      .filter((r) => typeof r === 'string' || typeof r === 'number')
      .map((r) => String(r).trim())
      .filter(Boolean)
  )];
}

function toISO(ms) {
  return new Date(ms).toISOString();
}

/**
 * 规范化一个导入的 GeoJSON Feature 为内部区域对象。
 * 必填：Polygon/MultiPolygon 几何、properties.start、properties.end。
 */
function normalizeZone(feature, index) {
  if (!feature || feature.type !== 'Feature' || !feature.geometry) {
    throw new Error(`第 ${index + 1} 个要素不是有效的 GeoJSON Feature`);
  }
  const { type, coordinates } = feature.geometry;
  if (type !== 'Polygon' && type !== 'MultiPolygon') {
    throw new Error(`第 ${index + 1} 个要素几何类型为 ${type}，仅支持 Polygon / MultiPolygon`);
  }
  const props = feature.properties || {};
  const start = parseTime(props.start || props.startTime || props.from);
  const end = parseTime(props.end || props.endTime || props.to);
  if (start === null || end === null) {
    throw new Error(`第 ${index + 1} 个要素缺少有效的生效起止时间（properties.start / properties.end）`);
  }
  if (end <= start) {
    throw new Error(`第 ${index + 1} 个要素的结束时间必须晚于开始时间`);
  }
  return {
    name: String(props.name || props.id || `区域 ${index + 1}`),
    layer: String(props.layer || props.group || '默认图层'),
    start: toISO(start),
    end: toISO(end),
    resources: normalizeResources(props.resources),
    geometry: { type, coordinates },
    properties: props,
  };
}

/** 两段时间窗口的重叠区间，无重叠返回 null */
function timeOverlap(a, b) {
  const start = Math.max(a.startMs, b.startMs);
  const end = Math.min(a.endMs, b.endMs);
  return end > start ? { start, end } : null;
}

/**
 * 为一对冲突区域生成错峰建议。
 * 思路：把"开始更晚"的一方整体顺延到另一方结束之后；
 * 同时给出"提前收工"的备选方案（把先结束的一方压缩到另一方开工前）。
 * 若双方存在共享资源，额外给出资源错峰/增配建议。
 */
function buildSuggestions(zoneA, zoneB, overlap, sharedResources = []) {
  const suggestions = [];
  const overlapDays = (overlap.end - overlap.start) / DAY_MS;

  // 方案一：后开工的一方顺延
  const later = zoneA.startMs >= zoneB.startMs ? zoneA : zoneB;
  const earlier = later === zoneA ? zoneB : zoneA;
  const laterDuration = later.endMs - later.startMs;
  const newStart = earlier.endMs;
  const newEnd = newStart + laterDuration;
  suggestions.push({
    type: 'postpone',
    zone: later.name,
    shiftDays: round1((newStart - later.startMs) / DAY_MS),
    newStart: toISO(newStart),
    newEnd: toISO(newEnd),
    text: `将「${later.name}」整体顺延 ${round1((newStart - later.startMs) / DAY_MS)} 天，` +
      `调整为 ${fmtDate(newStart)} ~ ${fmtDate(newEnd)}，待「${earlier.name}」完工后进场。`,
  });

  // 方案二：先完工的一方提前（仅当可以提前到对方开工前且不早于当前时间窗口起点太多时给出）
  const first = zoneA.endMs <= zoneB.endMs ? zoneA : zoneB;
  const second = first === zoneA ? zoneB : zoneA;
  const firstDuration = first.endMs - first.startMs;
  const pulledEnd = second.startMs;
  const pulledStart = pulledEnd - firstDuration;
  if (pulledStart > 0 && pulledEnd > pulledStart) {
    suggestions.push({
      type: 'advance',
      zone: first.name,
      shiftDays: round1((first.startMs - pulledStart) / DAY_MS),
      newStart: toISO(pulledStart),
      newEnd: toISO(pulledEnd),
      text: `或将「${first.name}」提前 ${round1((first.startMs - pulledStart) / DAY_MS)} 天，` +
        `调整为 ${fmtDate(pulledStart)} ~ ${fmtDate(pulledEnd)}，在「${second.name}」开工前完成。`,
    });
  }

  // 资源错峰建议：共享资源在重叠期内被双方同时占用
  if (sharedResources.length) {
    const resText = sharedResources.map((r) => `「${r}」`).join('、');
    suggestions.push({
      type: 'resource-stagger',
      resources: sharedResources,
      zone: later.name,
      text: `资源错峰：重叠期 ${round1(overlapDays)} 天内 ${resText} 被双方同时占用，` +
        `建议优先保障先开工的「${earlier.name}」，「${later.name}」待对方释放资源后再使用` +
        `（可结合上方顺延/提前方案调整工期）。`,
    });
    suggestions.push({
      type: 'resource-timeshare',
      resources: sharedResources,
      text: `分时复用：若工期无法错开，可将 ${resText} 按班次或日时段在双方间轮换` +
        `（如「${earlier.name}」白天使用、「${later.name}」夜间使用），并建立交接台账。`,
    });
    suggestions.push({
      type: 'resource-add',
      resources: sharedResources,
      text: `增配资源：评估为 ${resText} 增租或从其他标段调拨同类资源，避免因等资源造成窝工。`,
    });
  }

  // 方案三：若重叠期相对工期较短，提示可考虑工序穿插
  const shorterDuration = Math.min(zoneA.endMs - zoneA.startMs, zoneB.endMs - zoneB.startMs);
  if (overlap.end - overlap.start <= shorterDuration * 0.25) {
    suggestions.push({
      type: 'note',
      text: `重叠期仅 ${round1(overlapDays)} 天，占较短工期比例不足 25%，` +
        '也可考虑工序穿插（如分幅施工、夜间作业）并加强现场协调。',
    });
  }

  return suggestions;
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function fmtDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 核心分析：对给定区域集合做两两时间+空间/资源冲突检测。
 * - 时间重叠 + 空间相交 → 空间冲突（spatial）
 * - 时间重叠 + 使用同一资源 → 资源冲突（resource）
 * - 两者同时满足 → 合并为一条（both），标注共享资源与重叠时段
 * @param {Array} zones 规范化后的区域（含 start/end ISO 字符串、resources 字符串数组）
 * @param {Object} options { layers?: string[], start?: string, end?: string }
 */
function analyze(zones, options = {}) {
  const rangeStart = parseTime(options.start);
  const rangeEnd = parseTime(options.end);
  const layerFilter = Array.isArray(options.layers) && options.layers.length
    ? new Set(options.layers)
    : null;

  // 过滤 + 预处理
  let fallbackSeq = 0;
  const candidates = zones
    .map((z) => ({
      ...z,
      startMs: parseTime(z.start),
      endMs: parseTime(z.end),
      resources: normalizeResources(z.resources),
    }))
    .filter((z) => z.startMs !== null && z.endMs !== null)
    .filter((z) => !layerFilter || layerFilter.has(z.layer))
    .filter((z) => (rangeStart === null || z.endMs > rangeStart) && (rangeEnd === null || z.startMs < rangeEnd))
    .map((z) => {
      // 正常导入的区域均带 uuid；测试/直调场景缺失时给稳定回退 id，保证集群建图可引用节点
      if (z.id === undefined || z.id === null || String(z.id) === '') {
        z.id = `zone-${fallbackSeq + 1}`;
        fallbackSeq += 1;
      }
      return z;
    });

  const conflicts = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];

      // 时间重叠（再与分析时段求交）
      let overlap = timeOverlap(a, b);
      if (!overlap) continue;
      if (rangeStart !== null) overlap.start = Math.max(overlap.start, rangeStart);
      if (rangeEnd !== null) overlap.end = Math.min(overlap.end, rangeEnd);
      if (overlap.end <= overlap.start) continue;

      // 共享资源（时间重叠 + 使用同一资源 → 资源冲突）
      const sharedResources = a.resources.filter((r) => b.resources.includes(r));

      // 空间相交（polygon-clipping 真实求交）
      let intersection = null;
      let areaM2 = 0;
      try {
        const raw = pc.intersection(a.geometry.coordinates, b.geometry.coordinates);
        if (raw && raw.length) {
          const [refLon, refLat] = centroidOfCoords(raw);
          const area = multiPolygonArea(raw, refLon, refLat);
          if (area >= 0.01) { // 忽略仅边界相接的零面积接触
            intersection = raw;
            areaM2 = area;
          }
        }
      } catch (err) {
        // 个别退化几何不中断整体分析，仅视为无空间相交
      }

      const hasSpatial = intersection !== null;
      const hasResource = sharedResources.length > 0;
      if (!hasSpatial && !hasResource) continue;

      // 两者同时满足时合并为一条，标注 conflictType / sharedResources / 重叠时段
      const conflictType = hasSpatial && hasResource
        ? CONFLICT_TYPES.BOTH
        : hasSpatial ? CONFLICT_TYPES.SPATIAL : CONFLICT_TYPES.RESOURCE;

      conflicts.push({
        id: `conflict-${conflicts.length + 1}`,
        conflictType,
        zones: [
          { id: a.id, name: a.name, layer: a.layer, start: a.start, end: a.end, resources: a.resources },
          { id: b.id, name: b.name, layer: b.layer, start: b.start, end: b.end, resources: b.resources },
        ],
        sharedResources,
        overlapStart: toISO(overlap.start),
        overlapEnd: toISO(overlap.end),
        overlapDays: round1((overlap.end - overlap.start) / DAY_MS),
        areaM2: Math.round(areaM2 * 100) / 100,
        areaHectares: Math.round(areaM2 / 100) / 100, // 公顷，保留两位
        geometry: hasSpatial ? { type: 'MultiPolygon', coordinates: intersection } : null,
        suggestions: buildSuggestions(a, b, overlap, sharedResources),
      });
    }
  }

  // 按重叠面积降序（纯资源冲突面积为 0，按重叠时长次排序）
  conflicts.sort((x, y) => (y.areaM2 - x.areaM2) || (y.overlapDays - x.overlapDays));
  conflicts.forEach((c, idx) => { c.id = `conflict-${idx + 1}`; });

  const conflictCountByType = { spatial: 0, resource: 0, both: 0 };
  conflicts.forEach((c) => { conflictCountByType[c.conflictType] += 1; });

  // 参与本次分析的区域摘要（按 id 升序）：供「分析对比」核对两次分析的区域集合是否一致，
  // 也用于旧版结果缺少该字段时从冲突记录回退恢复
  const zoneSummaries = candidates
    .map((z) => ({ id: String(z.id), name: z.name, layer: z.layer }))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  // 冲突协调集群：区域为节点、冲突为无向边的连通分量（≥2 个区域），含 Tarjan 关键区域
  const clusters = buildClusters(conflicts);

  return {
    generatedAt: new Date().toISOString(),
    params: {
      layers: options.layers || null,
      start: options.start || null,
      end: options.end || null,
    },
    zoneCount: candidates.length,
    zoneSummaries,
    conflictCount: conflicts.length,
    conflictCountByType,
    clusterCount: clusters.length,
    clusters,
    totalConflictAreaM2: Math.round(conflicts.reduce((s, c) => s + c.areaM2, 0) * 100) / 100,
    conflicts,
  };
}

module.exports = { analyze, normalizeZone, normalizeResources, parseTime, CONFLICT_TYPES };
