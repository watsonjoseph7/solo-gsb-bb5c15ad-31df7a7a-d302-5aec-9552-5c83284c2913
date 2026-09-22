'use strict';

/**
 * 共享资源错峰排程（Shared Resource Stagger Scheduling）
 *
 * 基于一条**已保存分析**的冲突结果，针对其中一种共享资源，按区域原定工期
 * （start/end 区间长度保持不变）生成不超过资源可用数量（容量，默认 1）的
 * 连续安排：每个参与该资源冲突的区域只能整体后移，在所有时间点上同时占用
 * 该资源的区域数不超过容量。排程结果是只读建议，不修改原区域或分析结果。
 *
 * 算法：区间容量受限的贪心排程（list scheduling）
 * - 按原定开始时间升序处理区域（开始相同则结束早者优先，再以区域 id 兜底）；
 * - 每个区域从原定开始时间起尝试放置，若与已放置区域在任一时刻的并发数
 *   达到容量则顺延；可行的最早起点一定出现在「原定起点」或「某个已放置
 *   区域的结束时刻」，故只需在这些候选点中从小到大取第一个可行点；
 * - 时间采用半开区间 [start, end)：前一区域结束与后一区域开始同一时刻
 *   不算重叠（可无缝衔接进场）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 排程入参无效：status 建议 HTTP 400 */
class SchedulingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SchedulingError';
    this.status = 400;
  }
}

function parseTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function toISO(ms) {
  return new Date(ms).toISOString();
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

/** 校验并规范化资源可用数量（正整数，默认 1） */
function normalizeCapacity(value) {
  if (value === undefined || value === null || value === '') return 1;
  // 拒绝 "1.5" / true / 非数字字符串等隐式换算
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new SchedulingError('资源可用数量必须为不小于 1 的整数');
  }
  return n;
}

/**
 * 从分析结果中挑出涉及指定资源的冲突（resource / both 且共享资源包含该资源）。
 * @returns {Array} 冲突记录（保持结果中的原始顺序）
 */
function findResourceConflicts(result, resource) {
  if (!result || !Array.isArray(result.conflicts)) return [];
  return result.conflicts.filter(
    (c) => Array.isArray(c.sharedResources) && c.sharedResources.includes(resource)
  );
}

/**
 * 提取参与资源冲突的区域（以 id 去重）。
 * 区域原定时间优先取冲突记录内 zones 摘要的 start/end（随分析结果保存）。
 * @returns {Map<string, {id, name, layer, startMs, endMs, durationMs}>}
 */
function extractConflictZones(conflicts) {
  const zones = new Map();
  for (const c of conflicts) {
    for (const z of c.zones || []) {
      if (!z || z.id === undefined || z.id === null) continue;
      const id = String(z.id);
      if (zones.has(id)) continue;
      const startMs = parseTime(z.start);
      const endMs = parseTime(z.end);
      if (startMs === null || endMs === null || endMs <= startMs) continue; // 异常记录跳过
      zones.set(id, {
        id,
        name: z.name != null ? String(z.name) : id,
        layer: z.layer != null ? String(z.layer) : '',
        startMs,
        endMs,
        durationMs: endMs - startMs,
      });
    }
  }
  return zones;
}

/**
 * 判断把区间 [start, start+duration) 加入已放置区间后，是否始终不超过容量。
 * 半开区间端点相接不算并发；用事件扫描统计叠加区间内的最大并发数。
 */
function fitsCapacity(placed, start, duration, capacity) {
  const end = start + duration;
  // 事件：与新区间有真实交叠（start < other.end && end > other.start）的已放置区间
  const events = [];
  for (const p of placed) {
    if (p.endMs <= start || p.startMs >= end) continue;
    events.push({ t: Math.max(start, p.startMs), delta: 1 });
    events.push({ t: Math.min(end, p.endMs), delta: -1 });
  }
  events.sort((a, b) => (a.t - b.t) || (a.delta - b.delta)); // 同一时刻先结束后开始
  let concurrent = 0;
  for (const ev of events) {
    concurrent += ev.delta;
    if (concurrent + 1 > capacity) return false; // 再加新区间即超容
  }
  return true;
}

/**
 * 贪心排程：返回 zoneId -> {startMs, endMs} 的建议安排（只后移、不提前、不改工期）。
 */
function scheduleZones(zoneMap, capacity) {
  const ordered = [...zoneMap.values()].sort((a, b) =>
    (a.startMs - b.startMs) || (a.endMs - b.endMs) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );

  const placed = []; // { zoneId, startMs, endMs }
  const assignments = new Map();

  for (const z of ordered) {
    // 候选起点：原定起点 + 每个已放置区域的结束时刻（取不早于原定起点者）
    const candidates = [z.startMs];
    for (const p of placed) {
      if (p.endMs >= z.startMs) candidates.push(p.endMs);
    }
    candidates.sort((a, b) => a - b);

    let chosen = null;
    for (const cand of candidates) {
      if (fitsCapacity(placed, cand, z.durationMs, capacity)) {
        chosen = cand;
        break;
      }
    }
    // 理论上 candidates 含最晚已放置区间的结束点，必然可行；防御性回退
    if (chosen === null) chosen = candidates[candidates.length - 1];

    const item = { zoneId: z.id, startMs: chosen, endMs: chosen + z.durationMs };
    placed.push(item);
    assignments.set(z.id, item);
  }

  return assignments;
}

/** 判断排程后两个区域是否仍在时间上重叠（半开区间） */
function stillOverlaps(assignments, idA, idB) {
  const a = assignments.get(String(idA));
  const b = assignments.get(String(idB));
  if (!a || !b) return false;
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/**
 * 对一条已保存分析生成指定共享资源的错峰排程。
 * @param {Object} record 已保存分析记录 {id, name, savedAt, result}
 * @param {Object} options { resource: string, capacity?: number }
 * @returns {Object} 排程计划（plan 为空表示该资源无相关冲突）
 * @throws {SchedulingError} 记录无效 / 未选资源 / 容量非法
 */
function buildResourceSchedule(record, options = {}) {
  if (!record || typeof record !== 'object' || !record.result) {
    throw new SchedulingError('分析记录无效，无法生成排程');
  }
  const { result } = record;
  if (!Array.isArray(result.conflicts)) {
    throw new SchedulingError('该分析结果数据不完整（缺少 conflicts 列表），无法生成排程');
  }
  const resource = typeof options.resource === 'string' ? options.resource.trim() : '';
  if (!resource) {
    throw new SchedulingError('请选择一种共享资源');
  }
  const capacity = normalizeCapacity(options.capacity);

  const conflicts = findResourceConflicts(result, resource);

  const base = {
    generatedAt: new Date().toISOString(),
    resource,
    capacity,
    analysis: {
      id: record.id || null,
      name: record.name || null,
      savedAt: record.savedAt || null,
      generatedAt: result.generatedAt || null,
    },
  };

  // 无相关冲突 → 空计划（明确不改动任何安排）
  if (!conflicts.length) {
    return {
      ...base,
      zoneCount: 0,
      delayedCount: 0,
      maxDelayDays: 0,
      totalDelayDays: 0,
      conflictCount: 0,
      resolvedCount: 0,
      remainingCount: 0,
      plan: [],
      affectedConflicts: [],
      empty: true,
      message: `该分析中不存在因共享资源「${resource}」导致的冲突，无需错峰排程`,
    };
  }

  const zoneMap = extractConflictZones(conflicts);
  const assignments = scheduleZones(zoneMap, capacity);

  // ---- 每个区域的建议安排 ----
  const plan = [...zoneMap.values()].map((z) => {
    const a = assignments.get(z.id);
    const delayMs = a.startMs - z.startMs;
    return {
      zoneId: z.id,
      zoneName: z.name,
      layer: z.layer,
      originalStart: toISO(z.startMs),
      originalEnd: toISO(z.endMs),
      suggestedStart: toISO(a.startMs),
      suggestedEnd: toISO(a.endMs),
      delayDays: round1(delayMs / DAY_MS),
      durationDays: round1(z.durationMs / DAY_MS),
      affectedConflictIds: conflicts
        .filter((c) => (c.zones || []).some((zz) => String(zz.id) === z.id))
        .map((c) => c.id),
    };
  });

  // ---- 受影响冲突：排程后是否仍时间重叠（容量 >1 时部分冲突可能保留）----
  const affectedConflicts = conflicts.map((c) => {
    const ids = (c.zones || []).map((z) => String(z.id));
    const remaining = stillOverlaps(assignments, ids[0], ids[1]);
    return {
      conflictId: c.id,
      conflictType: c.conflictType,
      zones: (c.zones || []).map((z) => ({
        id: z.id != null ? String(z.id) : null,
        name: z.name != null ? String(z.name) : String(z.id),
        layer: z.layer != null ? String(z.layer) : '',
      })),
      sharedResources: Array.isArray(c.sharedResources) ? c.sharedResources : [resource],
      overlapStart: c.overlapStart || null,
      overlapEnd: c.overlapEnd || null,
      overlapDays: Number.isFinite(Number(c.overlapDays)) ? Number(c.overlapDays) : null,
      remaining,
    };
  });

  // 稳定排序：计划按建议开始时间（再按原定开始、区域 id）；冲突按原重叠开始、冲突 id
  plan.sort((a, b) =>
    Date.parse(a.suggestedStart) - Date.parse(b.suggestedStart) ||
    Date.parse(a.originalStart) - Date.parse(b.originalStart) ||
    (a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0)
  );
  affectedConflicts.sort((a, b) =>
    Date.parse(a.overlapStart || 0) - Date.parse(b.overlapStart || 0) ||
    extractConflictSeq(a.conflictId) - extractConflictSeq(b.conflictId)
  );

  const delays = plan.map((p) => p.delayDays);
  const delayedCount = delays.filter((d) => d > 0).length;
  const totalDelayDays = round1(delays.reduce((s, d) => s + d, 0));

  return {
    ...base,
    zoneCount: plan.length,
    delayedCount,
    maxDelayDays: Math.max(0, ...delays),
    totalDelayDays,
    conflictCount: affectedConflicts.length,
    resolvedCount: affectedConflicts.filter((c) => !c.remaining).length,
    remainingCount: affectedConflicts.filter((c) => c.remaining).length,
    plan,
    affectedConflicts,
    empty: false,
    message: null,
  };
}

/** 从冲突 id（如 conflict-3）提取序号用于稳定排序 */
function extractConflictSeq(id) {
  const m = /^conflict-(\d+)$/.exec(String(id));
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

/**
 * 列出一条已保存分析中出现过资源冲突的共享资源（供前端选择）。
 * @returns {Array<{resource, conflictCount, zoneCount}>} 按冲突数降序、资源名升序
 */
function listSharedResources(result) {
  if (!result || !Array.isArray(result.conflicts)) return [];
  const stats = new Map();
  for (const c of result.conflicts) {
    if (!Array.isArray(c.sharedResources)) continue;
    const zoneIds = new Set(
      (c.zones || []).map((z) => z && z.id != null ? String(z.id) : null).filter(Boolean)
    );
    for (const r of c.sharedResources) {
      const key = String(r);
      let s = stats.get(key);
      if (!s) {
        s = { resource: key, conflictCount: 0, zoneIds: new Set() };
        stats.set(key, s);
      }
      s.conflictCount += 1;
      zoneIds.forEach((id) => s.zoneIds.add(id));
    }
  }
  return [...stats.values()]
    .map((s) => ({ resource: s.resource, conflictCount: s.conflictCount, zoneCount: s.zoneIds.size }))
    .sort((a, b) => (b.conflictCount - a.conflictCount) || (a.resource < b.resource ? -1 : 1));
}

module.exports = {
  buildResourceSchedule,
  listSharedResources,
  findResourceConflicts,
  normalizeCapacity,
  SchedulingError,
};
