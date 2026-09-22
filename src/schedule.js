'use strict';

/**
 * 共享资源错峰排程（Shared Resource Stagger Scheduling）
 *
 * 基于**已保存分析**的冲突结果，针对一种共享资源、按可用数量（容量）做连续错峰排程：
 * - 仅纳入与该资源存在资源冲突（conflictType 为 resource / both 且 sharedResources
 *   命中该资源）的区域；每个区域在其**原定工期**内持续占用 1 个单位的该资源；
 * - 排程不改变工期长度（连续安排），只允许整体延后开工，依次把每个区域放到
 *   最早的可行开工点，使其工期内该资源的并发占用始终不超过容量 capacity；
 * - 容量 > 1 时，允许部分冲突在排程后仍然时间重叠（并发不超容量即合法），
 *   这类冲突会标注 resolvedAfterSchedule=false 与排程后重叠时段；
 * - 纯计算结果：**不修改任何区域，也不修改已保存分析结果**（不落库）；
 * - 该资源没有相关冲突时返回空计划（empty: true，zones/conflicts 均为空数组）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 排程入参/数据错误：status 建议 HTTP 状态码（400 入参无效 / 404 分析不存在） */
class ScheduleError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'ScheduleError';
    this.status = status;
    Object.assign(this, extra);
  }
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function toISO(ms) {
  return new Date(ms).toISOString();
}

function parseMs(value, label) {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new ScheduleError(`${label}不是有效的时间`);
  return t;
}

/** 从冲突 id（如 conflict-3）提取序号用于稳定排序，非标准 id 退化为字符串比较 */
function conflictSeq(id) {
  const m = /^conflict-(\d+)$/.exec(String(id));
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

function byConflictSeq(a, b) {
  return conflictSeq(a) - conflictSeq(b) || String(a).localeCompare(String(b));
}

/** 分析结果中与指定资源相关的冲突（共享资源清单命中即算） */
function findResourceConflicts(result, resource) {
  return (result.conflicts || []).filter(
    (c) => Array.isArray(c.sharedResources) && c.sharedResources.includes(resource)
  );
}

/**
 * 列出一次分析中可排程的共享资源（至少存在一条相关冲突）。
 * @returns {Array<{resource, conflictCount, zoneCount}>} 按冲突数、区域数、名称稳定排序
 */
function listScheduleResources(result) {
  const map = new Map();
  for (const c of (result && result.conflicts) || []) {
    for (const r of c.sharedResources || []) {
      let entry = map.get(r);
      if (!entry) {
        entry = { resource: r, conflictCount: 0, zoneIds: new Set() };
        map.set(r, entry);
      }
      entry.conflictCount += 1;
      for (const z of c.zones || []) {
        if (z && z.id != null) entry.zoneIds.add(String(z.id));
      }
    }
  }
  return [...map.values()]
    .map((e) => ({ resource: e.resource, conflictCount: e.conflictCount, zoneCount: e.zoneIds.size }))
    .sort((a, b) =>
      (b.conflictCount - a.conflictCount) ||
      (b.zoneCount - a.zoneCount) ||
      a.resource.localeCompare(b.resource));
}

/**
 * 已放置窗口在区间 [start, end) 内任意时刻的最大并发数。
 * 半开区间语义（前闭后开）：在 end 时刻结束的窗口已释放资源；
 * 占用数只在窗口起点增加，故只需检查区间起点与各窗口起点。
 */
function maxConcurrent(windows, start, end) {
  const active = windows.filter((w) => w.start < end && w.end > start);
  if (!active.length) return 0;
  const checkPoints = [...new Set([
    start,
    ...active.map((w) => Math.max(w.start, start)),
  ])];
  let max = 0;
  for (const t of checkPoints) {
    const n = active.reduce((cnt, w) => (cnt + (w.start <= t && t < w.end ? 1 : 0)), 0);
    if (n > max) max = n;
  }
  return max;
}

function emptySummary() {
  return {
    affectedConflictCount: 0,
    resolvedConflictCount: 0,
    remainingConflictCount: 0,
    delayedZoneCount: 0,
    maxDelayDays: 0,
    totalDelayDays: 0,
  };
}

/**
 * 为一条已保存分析生成某共享资源的错峰排程。
 * @param {Object} record 已保存分析记录 {id, name, result}
 * @param {Object} options { resource: string, capacity?: number }
 * @returns {Object} 排程计划（详见 README「共享资源错峰排程输出字段」）
 * @throws {ScheduleError} 分析记录/结果无效、资源未选、容量非法
 */
function buildSchedule(record, options = {}) {
  if (!record || !record.id) {
    throw new ScheduleError('缺少已保存分析记录');
  }
  if (!record.result || !Array.isArray(record.result.conflicts)) {
    throw new ScheduleError(
      `「${record.name || record.id}」的分析结果数据不完整（缺少 conflicts 列表），无法排程`
    );
  }

  const resource = options.resource;
  if (typeof resource !== 'string' || !resource.trim()) {
    throw new ScheduleError('请选择一种共享资源');
  }

  // 容量：默认 1，仅接受不小于 1 的整数（小数 / 0 / 负数 / 非数字均拒绝）
  let capacity = options.capacity;
  if (capacity === undefined || capacity === null || capacity === '') {
    capacity = 1;
  } else if (typeof capacity === 'string') {
    capacity = capacity.trim() === '' ? 1 : Number(capacity);
  }
  if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1) {
    throw new ScheduleError('资源可用数量必须为不小于 1 的整数');
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    analysisId: record.id,
    analysisName: record.name || record.id,
    resource,
    capacity,
  };

  const conflicts = findResourceConflicts(record.result, resource);

  // 无相关冲突：返回空计划（不报错，不写任何数据）
  if (!conflicts.length) {
    return {
      ...meta,
      empty: true,
      zoneCount: 0,
      scheduledZoneCount: 0,
      delayedZoneCount: 0,
      zones: [],
      conflicts: [],
      summary: emptySummary(),
    };
  }

  // ---- 从冲突记录提取参与区域的原定工期（冲突记录中的 zone.start/end 为区域原始时间）----
  const zoneMap = new Map();
  for (const c of conflicts) {
    for (const z of c.zones || []) {
      if (!z || z.id == null) continue;
      const id = String(z.id);
      if (!zoneMap.has(id)) {
        const name = z.name != null ? String(z.name) : id;
        zoneMap.set(id, {
          id,
          name,
          layer: z.layer != null ? String(z.layer) : '',
          startMs: parseMs(z.start, `区域「${name}」的开始时间`),
          endMs: parseMs(z.end, `区域「${name}」的结束时间`),
        });
      }
    }
  }

  // ---- 贪心列表调度 ----
  // 处理顺序：原定开工升序 → 原定完工升序 → 区域 id 升序（保证结果确定）
  const order = [...zoneMap.values()].sort((a, b) =>
    (a.startMs - b.startMs) ||
    (a.endMs - b.endMs) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 可行开工点只需考虑：原定开工点、各已放置窗口的完工点（占用关系只在事件点变化）
  const placed = []; // { id, start, end }
  const scheduled = new Map(); // id -> { startMs, endMs }
  for (const z of order) {
    const duration = z.endMs - z.startMs;
    const candidates = [...new Set([
      z.startMs,
      ...placed.map((p) => p.end).filter((t) => t > z.startMs),
    ])].sort((a, b) => a - b);

    let chosen = null;
    for (const t of candidates) {
      // 放入该区域后其自身占用 1 个单位，故其他窗口的最大并发不得超过 capacity - 1
      if (maxConcurrent(placed, t, t + duration) <= capacity - 1) {
        chosen = t;
        break;
      }
    }
    // 防御：所有已放置窗口完工之后必可行
    if (chosen === null) {
      chosen = Math.max(z.startMs, ...placed.map((p) => p.end));
    }
    placed.push({ id: z.id, start: chosen, end: chosen + duration });
    scheduled.set(z.id, { startMs: chosen, endMs: chosen + duration });
  }

  /** 冲突双方排程后的重叠时段（半开区间），不重叠返回 null */
  function scheduledOverlap(c) {
    const ids = (c.zones || []).map((z) => z && String(z.id));
    if (ids.length < 2 || ids.some((id) => !id || !scheduled.has(id))) return null;
    const [sa, sb] = ids.map((id) => scheduled.get(id));
    const start = Math.max(sa.startMs, sb.startMs);
    const end = Math.min(sa.endMs, sb.endMs);
    if (end <= start) return null;
    return { start, end };
  }

  // ---- 输出：受影响冲突明细（顶层一份，区域内按"对方区域"再引用）----
  const conflictEntries = conflicts
    .map((c) => {
      const post = scheduledOverlap(c);
      return {
        conflictId: c.id,
        conflictType: c.conflictType,
        zones: (c.zones || []).map((z) => ({
          id: String(z.id),
          name: z.name != null ? String(z.name) : String(z.id),
          layer: z.layer != null ? String(z.layer) : '',
        })),
        sharedResources: c.sharedResources || [],
        overlapStart: c.overlapStart,
        overlapEnd: c.overlapEnd,
        overlapDays: c.overlapDays,
        resolvedAfterSchedule: post === null,
        scheduledOverlap: post
          ? { start: toISO(post.start), end: toISO(post.end), days: round1((post.end - post.start) / DAY_MS) }
          : null,
      };
    })
    .sort((a, b) => byConflictSeq(a.conflictId, b.conflictId));

  // ---- 输出：每个参与区域的建议起止、延后天数与受影响冲突 ----
  const zoneEntries = order.map((z) => {
    const sch = scheduled.get(z.id);
    const affectedConflicts = [];
    for (const c of conflicts) {
      const zones = c.zones || [];
      if (!zones.some((zz) => zz && String(zz.id) === z.id)) continue;
      const other = zones.find((zz) => zz && String(zz.id) !== z.id);
      const post = scheduledOverlap(c);
      affectedConflicts.push({
        conflictId: c.id,
        conflictType: c.conflictType,
        otherZone: other
          ? { id: String(other.id), name: other.name != null ? String(other.name) : String(other.id) }
          : null,
        overlapStart: c.overlapStart,
        overlapEnd: c.overlapEnd,
        overlapDays: c.overlapDays,
        resolvedAfterSchedule: post === null,
        scheduledOverlap: post
          ? { start: toISO(post.start), end: toISO(post.end), days: round1((post.end - post.start) / DAY_MS) }
          : null,
      });
    }
    affectedConflicts.sort((a, b) => byConflictSeq(a.conflictId, b.conflictId));

    return {
      zoneId: z.id,
      zoneName: z.name,
      layer: z.layer,
      originalStart: toISO(z.startMs),
      originalEnd: toISO(z.endMs),
      durationDays: round1((z.endMs - z.startMs) / DAY_MS),
      scheduledStart: toISO(sch.startMs),
      scheduledEnd: toISO(sch.endMs),
      delayDays: round1((sch.startMs - z.startMs) / DAY_MS),
      affectedConflictCount: affectedConflicts.length,
      resolvedConflictCount: affectedConflicts.filter((a) => a.resolvedAfterSchedule).length,
      affectedConflicts,
    };
  });

  // 排程视图按建议开工时间排列（同时开工按 id），便于按时间轴阅读
  zoneEntries.sort((a, b) =>
    (Date.parse(a.scheduledStart) - Date.parse(b.scheduledStart)) ||
    (a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0));

  const delayed = zoneEntries.filter((z) => z.delayDays > 0);
  const remaining = conflictEntries.filter((c) => !c.resolvedAfterSchedule);

  return {
    ...meta,
    empty: false,
    zoneCount: zoneEntries.length,
    scheduledZoneCount: zoneEntries.length,
    delayedZoneCount: delayed.length,
    zones: zoneEntries,
    conflicts: conflictEntries,
    summary: {
      affectedConflictCount: conflictEntries.length,
      resolvedConflictCount: conflictEntries.length - remaining.length,
      remainingConflictCount: remaining.length,
      delayedZoneCount: delayed.length,
      maxDelayDays: delayed.reduce((m, z) => Math.max(m, z.delayDays), 0),
      totalDelayDays: round1(delayed.reduce((s, z) => s + z.delayDays, 0)),
    },
  };
}

module.exports = {
  buildSchedule,
  listScheduleResources,
  findResourceConflicts,
  ScheduleError,
};
