'use strict';

/**
 * GeoJSON 导入质量预检与规范化（独立于分析流程，只检不写）。
 *
 * 逐要素检查：
 *  - 环闭合（未闭合 / 多余闭合点 / 连续重复顶点）
 *  - 顶点数量（线性环至少 3 个不重复顶点、4 个位置）
 *  - 自相交（非相邻边相交 / 接触、非相邻顶点重合）
 *  - 时间字段（缺失 / 非法 / 起止倒置 / 别名键 / 非标准格式）
 *  - 资源字段（分隔字符串拆分 / 去重 / 非法条目 / 非法类型）
 *
 * 结论分 error（不可导入）与 warning（可导入，部分可自动规范化），
 * 每条问题带 JSONPath（如 $.features[0].geometry.coordinates[0][3]）。
 * 可修复问题在 normalized 预览中统一修复：闭合环、去重复点、资源去重、日期统一为 ISO。
 */

const { normalizeResources } = require('./analysis');

const START_KEYS = ['start', 'startTime', 'from'];
const END_KEYS = ['end', 'endTime', 'to'];

const EPS = 1e-12; // 经纬度坐标下的浮点容差

// ---------- 基础工具 ----------

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPosition(p) {
  return Array.isArray(p) && p.length >= 2 && isFiniteNumber(p[0]) && isFiniteNumber(p[1]);
}

function samePosition(a, b) {
  return Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS;
}

function issue(severity, code, message, path, fixable = false) {
  return { severity, code, message, path, fixable, fixed: false };
}

// ---------- 时间解析（比 Date.parse 更宽松，兼容 2026/10/01、2026.10.01、2026年10月1日） ----------

function toISO(ms) {
  return new Date(ms).toISOString();
}

function parseTimeLoose(value) {
  if (value === undefined || value === null || value === '') return null;
  if (isFiniteNumber(value)) {
    const ms = value < 1e12 ? value * 1000 : value; // 兼容秒级/毫秒级时间戳
    return Number.isNaN(new Date(ms).getTime()) ? null : ms;
  }
  let s = String(value).trim();
  const m = s.match(/^(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?(?:[\sT]+(.+))?$/);
  if (m) s = `${m[1]}/${m[2]}/${m[3]}${m[4] ? ` ${m[4].trim()}` : ''}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** 时间格式归类：date/iso 为文档约定的标准写法，其余（斜杠、点号、中文、本地时间、时间戳）需统一 */
function timeFormatKind(raw) {
  if (isFiniteNumber(raw)) return 'other';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'date';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return 'iso';
  return 'other';
}

function pickPresentKey(obj, keys) {
  return keys.find((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== '');
}

// ---------- 自相交检测 ----------

function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(px, py, ax, ay, bx, by) {
  return px >= Math.min(ax, bx) - EPS && px <= Math.max(ax, bx) + EPS
    && py >= Math.min(ay, by) - EPS && py <= Math.max(ay, by) + EPS;
}

/** 两条线段是否相交（含端点接触、共线重叠） */
function segmentsIntersect(a, b, c, d) {
  const o1 = orient(a[0], a[1], b[0], b[1], c[0], c[1]);
  const o2 = orient(a[0], a[1], b[0], b[1], d[0], d[1]);
  const o3 = orient(c[0], c[1], d[0], d[1], a[0], a[1]);
  const o4 = orient(c[0], c[1], d[0], d[1], b[0], b[1]);
  // 共线且落在线段上
  if (Math.abs(o1) <= EPS && onSegment(c[0], c[1], a[0], a[1], b[0], b[1])) return true;
  if (Math.abs(o2) <= EPS && onSegment(d[0], d[1], a[0], a[1], b[0], b[1])) return true;
  if (Math.abs(o3) <= EPS && onSegment(a[0], a[1], c[0], c[1], d[0], d[1])) return true;
  if (Math.abs(o4) <= EPS && onSegment(b[0], b[1], c[0], c[1], d[0], d[1])) return true;
  // 一般情况：互相跨立
  return ((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS))
    && ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS));
}

/**
 * 检测单个环（隐式闭合、已去连续重复点）是否自相交。
 * 任两条非相邻边相交/接触，或非相邻顶点重合，即判定自相交。
 */
function ringSelfIntersection(verts) {
  const m = verts.length;
  for (let i = 0; i < m; i++) {
    for (let j = i + 2; j < m; j++) {
      if (i === 0 && j === m - 1) continue; // 首尾相邻
      if (samePosition(verts[i], verts[j])) return true;
    }
  }
  const edgeOf = (i) => [verts[i], verts[(i + 1) % m]];
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      if (j === i + 1 || (i === 0 && j === m - 1)) continue; // 相邻边共享端点，正常
      const [a, b] = edgeOf(i);
      const [c, d] = edgeOf(j);
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

// ---------- 单个环的预检与规范化 ----------

/**
 * @returns {{ok: boolean, ring?: number[][]}} 规范化后的闭合环（保留第三维）；
 *   结构/顶点硬错误时 ok=false（问题已写入 collected）
 */
function inspectRing(rawRing, ringPath, collected) {
  if (!Array.isArray(rawRing) || rawRing.length === 0) {
    collected.push(issue('error', 'ring-not-array', '环坐标必须是非空数组', ringPath));
    return { ok: false };
  }
  const badIdx = rawRing.findIndex((p) => !isPosition(p));
  if (badIdx !== -1) {
    collected.push(issue('error', 'ring-invalid-position',
      `第 ${badIdx + 1} 个顶点不是有效的 [经度, 纬度] 数值坐标（不允许 NaN/Infinity/空值）`,
      `${ringPath}[${badIdx}]`));
    return { ok: false };
  }

  const n = rawRing.length;
  const first = rawRing[0];

  // 经纬度范围（坐标本身有效时检查，路径指向原始顶点）
  rawRing.forEach((p, i) => {
    if (p[0] < -180 - EPS || p[0] > 180 + EPS || p[1] < -90 - EPS || p[1] > 90 + EPS) {
      collected.push(issue('warning', 'ring-coordinate-out-of-range',
        `顶点 (${p[0]}, ${p[1]}) 超出经纬度有效范围（经度 ±180、纬度 ±90），请确认坐标参考系为 WGS84`,
        `${ringPath}[${i}]`));
    }
  });

  // 去掉尾部所有与首点重复的闭合点
  let end = n;
  while (end > 1 && samePosition(rawRing[end - 1], first)) end -= 1;
  const trailingClosures = n - end;
  const closed = trailingClosures > 0;
  const base = rawRing.slice(0, end);

  // 压缩连续重复顶点
  const verts = [base[0]];
  let consecutiveDup = 0;
  for (let k = 1; k < base.length; k++) {
    if (samePosition(base[k], verts[verts.length - 1])) consecutiveDup += 1;
    else verts.push(base[k]);
  }

  if (!closed) {
    const w = issue('warning', 'ring-not-closed',
      `环未闭合：首点 (${first[0]}, ${first[1]}) 与尾点不一致，已自动补点闭合`,
      ringPath, true);
    w.fixed = true;
    collected.push(w);
  } else if (trailingClosures > 1) {
    // 标准闭合环（1 个闭合点）不算问题；多于 1 个才是多余重复
    const w = issue('warning', 'ring-duplicate-closure',
      `环存在 ${trailingClosures} 个与首点重复的闭合点，已删除多余重复点`,
      ringPath, true);
    w.fixed = true;
    collected.push(w);
  }
  if (consecutiveDup > 0) {
    const w = issue('warning', 'ring-duplicate-vertex',
      `环存在 ${consecutiveDup} 个连续重复顶点，已去重`, ringPath, true);
    w.fixed = true;
    collected.push(w);
  }

  if (n < 4) {
    collected.push(issue('error', 'ring-too-few-vertices',
      `线性环至少需要 4 个位置（3 个不重复顶点 + 闭合点），当前仅 ${n} 个位置`, ringPath));
    return { ok: false };
  }
  if (verts.length < 3) {
    collected.push(issue('error', 'ring-degenerate',
      `环有效顶点不足 3 个（去重后 ${verts.length} 个），几何退化无法成面`, ringPath));
    return { ok: false };
  }

  if (ringSelfIntersection(verts)) {
    collected.push(issue('error', 'ring-self-intersection',
      '环存在自相交（非相邻边交叉/接触或顶点重合，如"蝴蝶结"），无法可靠参与空间分析，请人工修复',
      ringPath));
    return { ok: false };
  }

  // 规范化结果：显式闭合（补回首点），保留原始第三维
  const ring = verts.map((p) => p.slice());
  ring.push(ring[0].slice());
  return { ok: true, ring };
}

/** 预检一个 Polygon（环数组），返回规范化环数组；结构非法返回 null */
function inspectPolygonRings(polygon, polygonPath, collected) {
  if (!Array.isArray(polygon) || polygon.length === 0) {
    collected.push(issue('error', 'polygon-invalid',
      'Polygon 坐标必须是至少含一个外环的非空数组', polygonPath));
    return null;
  }
  const rings = [];
  let ok = true;
  polygon.forEach((rawRing, ri) => {
    const { ok: ringOk, ring } = inspectRing(rawRing, `${polygonPath}[${ri}]`, collected);
    if (ringOk) rings.push(ring);
    else ok = false;
  });
  return ok ? rings : null;
}

// ---------- 几何 ----------

function inspectGeometry(geometry, geomPath, collected) {
  if (!geometry || typeof geometry !== 'object' || Array.isArray(geometry)) {
    collected.push(issue('error', 'geometry-missing', '缺少 geometry 或不是对象', geomPath));
    return { ok: false };
  }
  const { type, coordinates } = geometry;
  if (type !== 'Polygon' && type !== 'MultiPolygon') {
    collected.push(issue('error', 'geometry-type-unsupported',
      `几何类型为 ${type || '未知'}，仅支持 Polygon / MultiPolygon`, `${geomPath}.type`));
    return { ok: false };
  }
  const coordsPath = `${geomPath}.coordinates`;
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    collected.push(issue('error', 'geometry-coordinates-invalid',
      'geometry.coordinates 必须是非空数组', coordsPath));
    return { ok: false };
  }

  if (type === 'Polygon') {
    const rings = inspectPolygonRings(coordinates, coordsPath, collected);
    return rings ? { ok: true, geometry: { type, coordinates: rings } } : { ok: false };
  }

  // MultiPolygon
  const normalized = [];
  let ok = true;
  coordinates.forEach((polygon, pi) => {
    const rings = inspectPolygonRings(polygon, `${coordsPath}[${pi}]`, collected);
    if (rings) normalized.push(rings);
    else ok = false;
  });
  return ok ? { ok: true, geometry: { type, coordinates: normalized } } : { ok: false };
}

// ---------- properties：时间 / 资源 / 名称 / 图层 ----------

function inspectTimeField(props, keys, canonical, label, featurePath, collected) {
  const propPath = `${featurePath}.properties`;
  const foundKey = pickPresentKey(props, keys);
  if (!foundKey) {
    collected.push(issue('error', 'time-missing',
      `缺少${label}时间（properties.${canonical}${keys.length > 1 ? `，兼容字段：${keys.slice(1).join(' / ')}` : ''}）`,
      `${propPath}.${canonical}`));
    return null;
  }
  if (foundKey !== canonical) {
    const w = issue('warning', 'time-alias-key',
      `${label}时间使用了别名键 "${foundKey}"，已统一为标准字段 "${canonical}"`,
      `${propPath}.${foundKey}`, true);
    w.fixed = true;
    collected.push(w);
  }
  const raw = props[foundKey];
  const ms = parseTimeLoose(raw);
  if (ms === null) {
    collected.push(issue('error', 'time-invalid',
      `${label}时间 "${raw}" 无法解析为日期（建议使用 YYYY-MM-DD 或 ISO 8601）`,
      `${propPath}.${foundKey}`));
    return null;
  }
  if (timeFormatKind(raw) === 'other') {
    const w = issue('warning', 'time-format',
      `${label}时间 "${raw}" 为非标准日期格式，已统一为 ${toISO(ms)}（UTC）`,
      `${propPath}.${foundKey}`, true);
    w.fixed = true;
    w.normalizedValue = toISO(ms);
    collected.push(w);
  }
  return ms;
}

function inspectResources(props, featurePath, collected) {
  const propPath = `${featurePath}.properties`;
  const value = props.resources;
  if (value === undefined || value === null) return [];

  if (typeof value === 'string') {
    if (/[,，、;；]/.test(value)) {
      const w = issue('warning', 'resource-string-split',
        `resources 为分隔字符串 "${value}"，已按逗号/顿号/分号拆分为数组`,
        `${propPath}.resources`, true);
      w.fixed = true;
      collected.push(w);
    }
    const normalized = normalizeResources(value);
    const parts = value.split(/[,，、;；]/).map((r) => r.trim()).filter(Boolean);
    if (parts.length !== new Set(parts).size) {
      const w = issue('warning', 'resource-duplicate',
        `资源清单存在重复项，已去重为：${normalized.join('、') || '（空）'}`,
        `${propPath}.resources`, true);
      w.fixed = true;
      collected.push(w);
    }
    return normalized;
  }

  if (Array.isArray(value)) {
    value.forEach((r, i) => {
      if (typeof r !== 'string' && typeof r !== 'number') {
        const w = issue('warning', 'resource-entry-invalid',
          `第 ${i + 1} 个资源条目不是文本（类型 ${typeof r}），已剔除`,
          `${propPath}.resources[${i}]`, true);
        w.fixed = true;
        collected.push(w);
      } else if (String(r).trim() !== String(r)) {
        const w = issue('warning', 'resource-entry-trim',
          `资源 "${r}" 含首尾空白，已去除`, `${propPath}.resources[${i}]`, true);
        w.fixed = true;
        collected.push(w);
      }
    });
    const normalized = normalizeResources(value);
    const validTexts = value
      .filter((r) => typeof r === 'string' || typeof r === 'number')
      .map((r) => String(r).trim())
      .filter(Boolean);
    if (validTexts.length !== new Set(validTexts).size) {
      const w = issue('warning', 'resource-duplicate',
        `资源清单存在重复项，已去重为：${normalized.join('、') || '（空）'}`,
        `${propPath}.resources`, true);
      w.fixed = true;
      collected.push(w);
    }
    return normalized;
  }

  const w = issue('warning', 'resource-type-invalid',
    `resources 类型为 ${typeof value}（应为字符串数组），已按空清单处理`,
    `${propPath}.resources`, true);
  w.fixed = true;
  collected.push(w);
  return [];
}

// ---------- 单要素 ----------

/**
 * @param {*} feature 原始要素
 * @param {number} index 要素序号（从 0 起）
 * @param {string|null} basePath 集合路径前缀；null 表示要素本身即根（单 Feature 输入）
 */
function inspectFeature(feature, index, basePath) {
  const featurePath = basePath === null ? '$' : `${basePath}[${index}]`;
  const fallbackName = `区域 ${index + 1}`;

  if (!feature || typeof feature !== 'object' || Array.isArray(feature)) {
    return {
      index,
      sourcePath: featurePath,
      name: fallbackName,
      status: 'error',
      errors: [issue('error', 'feature-not-object', '要素必须是 GeoJSON Feature 对象', featurePath)],
      warnings: [],
      normalized: null,
    };
  }

  const collected = [];
  if (feature.type !== 'Feature') {
    collected.push(issue('error', 'feature-type-invalid',
      `要素 type 为 "${feature.type}"，应为 "Feature"`, `${featurePath}.type`));
  }

  const propsOk = feature.properties && typeof feature.properties === 'object' && !Array.isArray(feature.properties);
  const props = propsOk ? feature.properties : {};
  if (!propsOk) {
    collected.push(issue('error', 'properties-invalid',
      'properties 必须是对象', `${featurePath}.properties`));
  }

  // 几何
  let normalizedGeometry = null;
  if (feature.type === 'Feature') {
    const result = inspectGeometry(feature.geometry, `${featurePath}.geometry`, collected);
    if (result.ok) normalizedGeometry = result.geometry;
  }

  // 时间
  let startMs = null;
  let endMs = null;
  if (feature.type === 'Feature') {
    startMs = inspectTimeField(props, START_KEYS, 'start', '开始', featurePath, collected);
    endMs = inspectTimeField(props, END_KEYS, 'end', '结束', featurePath, collected);
    if (startMs !== null && endMs !== null && endMs <= startMs) {
      collected.push(issue('error', 'time-range',
        `结束时间 ${toISO(endMs)} 必须晚于开始时间 ${toISO(startMs)}`,
        `${featurePath}.properties.end`));
    }
  }

  // 资源
  const resources = feature.type === 'Feature' ? inspectResources(props, featurePath, collected) : [];

  // 名称 / 图层
  let name;
  if (props.name === undefined || props.name === null || String(props.name).trim() === '') {
    const w = issue('warning', 'name-missing',
      `缺少名称 properties.name，已自动命名为「${fallbackName}」`,
      `${featurePath}.properties.name`, true);
    w.fixed = true;
    collected.push(w);
    name = fallbackName;
  } else {
    name = String(props.name).trim();
  }
  let layer;
  if (props.layer === undefined || props.layer === null || String(props.layer).trim() === '') {
    const w = issue('warning', 'layer-missing',
      '缺少图层 properties.layer，已归入「默认图层」',
      `${featurePath}.properties.layer`, true);
    w.fixed = true;
    collected.push(w);
    layer = '默认图层';
  } else {
    layer = String(props.layer).trim();
  }

  const errors = collected.filter((x) => x.severity === 'error');
  const warnings = collected.filter((x) => x.severity === 'warning');

  // 仅当无硬错误且结构完整时生成规范化预览
  let normalized = null;
  if (errors.length === 0 && normalizedGeometry && startMs !== null && endMs !== null && endMs > startMs) {
    const normalizedProps = { ...props };
    normalizedProps.name = name;
    normalizedProps.layer = layer;
    normalizedProps.start = toISO(startMs);
    normalizedProps.end = toISO(endMs);
    normalizedProps.resources = resources;
    // 移除已被规范字段取代的时间别名，避免歧义
    for (const alias of [...START_KEYS.slice(1), ...END_KEYS.slice(1)]) {
      delete normalizedProps[alias];
    }
    normalized = { type: 'Feature', properties: normalizedProps, geometry: normalizedGeometry };
  }

  return {
    index,
    sourcePath: featurePath,
    name: props.name !== undefined && props.name !== null && String(props.name).trim()
      ? String(props.name)
      : fallbackName,
    status: errors.length ? 'error' : warnings.length ? 'warning' : 'pass',
    errors,
    warnings,
    normalized,
  };
}

// ---------- 集合级入口 ----------

/**
 * 从请求体提取要素（FeatureCollection / 单个 Feature / Feature 数组）。
 * @returns {{features: Array, container: 'FeatureCollection'|'Feature'|'array'}}
 * @throws Error 结构不受支持或为空
 */
function extractFeatures(body) {
  if (body && body.type === 'FeatureCollection' && Array.isArray(body.features)) {
    if (body.features.length === 0) throw new Error('GeoJSON 中没有任何要素');
    return { features: body.features, container: 'FeatureCollection' };
  }
  if (body && body.type === 'Feature') {
    return { features: [body], container: 'Feature' };
  }
  if (Array.isArray(body)) {
    if (body.length === 0) throw new Error('GeoJSON 中没有任何要素');
    return { features: body, container: 'array' };
  }
  throw new Error('请求体必须是 GeoJSON FeatureCollection 或 Feature');
}

/**
 * 预检主入口（纯函数，不写库）。
 * @param {Object|Array} body GeoJSON FeatureCollection / Feature / Feature 数组
 */
function precheck(body) {
  const { features, container } = extractFeatures(body);
  // FeatureCollection: $.features[i]；裸数组: $[i]；单 Feature: $
  const basePath = container === 'FeatureCollection' ? '$.features'
    : container === 'array' ? '$'
      : null;

  const reports = features.map((f, i) => inspectFeature(f, i, basePath));

  const passed = reports.filter((r) => r.errors.length === 0);
  const blocked = reports.filter((r) => r.errors.length > 0);
  const allErrors = reports.reduce((n, r) => n + r.errors.length, 0);
  const allWarnings = reports.reduce((n, r) => n + r.warnings.length, 0);
  const fixedWarnings = reports.reduce(
    (n, r) => n + r.warnings.filter((w) => w.fixed).length, 0
  );

  return {
    generatedAt: new Date().toISOString(),
    container,
    total: reports.length,
    summary: {
      total: reports.length,
      passed: passed.length,
      blocked: blocked.length,
      clean: reports.filter((r) => r.status === 'pass').length,
      withWarnings: reports.filter((r) => r.status === 'warning').length,
      errorCount: allErrors,
      warningCount: allWarnings,
      fixedWarningCount: fixedWarnings,
    },
    reports,
    // 通过项的规范化预览（可直接下载 / 确认后提交）
    normalized: {
      type: 'FeatureCollection',
      features: passed.map((r) => r.normalized),
    },
  };
}

module.exports = {
  precheck,
  extractFeatures,
  inspectFeature,
  // 导出供测试使用
  inspectRing,
  ringSelfIntersection,
  segmentsIntersect,
  parseTimeLoose,
};
