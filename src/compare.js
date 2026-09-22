'use strict';

/**
 * 分析对比（Analysis Comparison）
 *
 * 对两次已保存分析的冲突结果做差异比较。核心原则：
 * - **按区域对（zone pair）匹配冲突**，不依赖冲突编号（conflict-N 在不同结果间
 *   会因排序、冲突增减而漂移）；同一对区域在一次分析中至多产生一条冲突
 *   （空间/资源/两者合并），因此区域对是天然的稳定匹配键。
 * - 两次分析必须面向**同一区域集合**：区域被新增、删除或重新导入（uuid 变化）
 *   后，区域对的语义已不可比，直接以可理解的错误信息拒绝并列出差异区域。
 * - 分类输出：
 *   - added     新增冲突：旧分析中该区域对无冲突，新分析中有
 *   - resolved  已解决：旧分析中有，新分析中无
 *   - persistent 持续冲突：两次都存在，再标注属性变化（类型 / 重叠起止与天数 /
 *     共享资源；面积随重叠窗口变化，附带前后值但不单列为变化项）
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 对比校验失败：status 建议 HTTP 状态码（400 输入无效 / 404 分析不存在） */
class ComparisonError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'ComparisonError';
    this.status = status;
    Object.assign(this, extra);
  }
}

/** 区域对匹配键：区域 id 排序后用分隔符拼接（id 为 uuid 时不可能出现该分隔符序列冲突） */
function pairKey(zoneAId, zoneBId) {
  return [String(zoneAId), String(zoneBId)].sort().join('::');
}

/**
 * 取一次分析涉及的区域集合。
 * 优先使用 analyze() 输出的 zoneSummaries（参与分析的全部区域，含无冲突区域）；
 * 旧版保存结果没有该字段时，从冲突记录的 zones 回退恢复（此时无冲突区域无法恢复）。
 * @returns {Map<string, {id, name, layer}>}
 */
function extractZoneSet(result) {
  const map = new Map();
  if (result && Array.isArray(result.zoneSummaries) && result.zoneSummaries.length) {
    for (const z of result.zoneSummaries) {
      if (z && z.id !== undefined && z.id !== null) {
        map.set(String(z.id), {
          id: String(z.id),
          name: z.name != null ? String(z.name) : String(z.id),
          layer: z.layer != null ? String(z.layer) : '',
        });
      }
    }
    return map;
  }
  if (result && Array.isArray(result.conflicts)) {
    for (const c of result.conflicts) {
      for (const z of c.zones || []) {
        if (z && z.id !== undefined && z.id !== null && !map.has(String(z.id))) {
          map.set(String(z.id), {
            id: String(z.id),
            name: z.name != null ? String(z.name) : String(z.id),
            layer: z.layer != null ? String(z.layer) : '',
          });
        }
      }
    }
  }
  return map;
}

/** 冲突记录 -> 以区域对键为索引的表（同区域对异常出现多条时保留面积最大者） */
function indexConflictsByPair(result) {
  const map = new Map();
  if (!result || !Array.isArray(result.conflicts)) return map;
  for (const c of result.conflicts) {
    const ids = [...new Set((c.zones || []).map((z) => z && z.id != null ? String(z.id) : null).filter(Boolean))];
    if (ids.length !== 2) continue;
    const key = pairKey(ids[0], ids[1]);
    const prev = map.get(key);
    if (!prev || (Number(c.areaM2) || 0) > (Number(prev.areaM2) || 0)) {
      map.set(key, c);
    }
  }
  return map;
}

function fmtNames(zoneSet, ids, limit = 5) {
  const names = ids.map((id) => {
    const z = zoneSet.get(id);
    return z ? z.name : id;
  });
  const shown = names.slice(0, limit).join('、');
  return names.length > limit ? `${shown} 等 ${names.length} 个区域` : shown;
}

/** 校验已保存分析记录结构并返回其 result（无效记录给出可理解的错误） */
function requireValidResult(record, label) {
  if (!record || typeof record !== 'object') {
    throw new ComparisonError(`${label}不是有效的分析记录`);
  }
  if (!record.result || !Array.isArray(record.result.conflicts)) {
    throw new ComparisonError(`「${record.name || record.id || label}」的分析结果数据不完整（缺少 conflicts 列表），无法参与对比`);
  }
  return record.result;
}

/** 重叠天数由起止时间直接重算，避免依赖结果中可能缺失的 overlapDays */
function daysBetween(startIso, endIso) {
  const s = Date.parse(startIso);
  const e = Date.parse(endIso);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return null;
  return Math.round(((e - s) / DAY_MS) * 10) / 10;
}

function strSet(arr) {
  return new Set((arr || []).map((x) => String(x)));
}

/**
 * 比较两条冲突（同一区域对）的属性差异。
 * changed 字段按需求维度给出：conflictType / overlap（起止或天数）/ sharedResources。
 */
function diffConflicts(before, after) {
  const changes = [];

  if (before.conflictType !== after.conflictType) {
    changes.push({
      field: 'conflictType',
      label: '冲突类型',
      before: before.conflictType,
      after: after.conflictType,
    });
  }

  const beforeDays = Number.isFinite(Number(before.overlapDays))
    ? Number(before.overlapDays)
    : daysBetween(before.overlapStart, before.overlapEnd);
  const afterDays = Number.isFinite(Number(after.overlapDays))
    ? Number(after.overlapDays)
    : daysBetween(after.overlapStart, after.overlapEnd);
  const overlapChanged =
    before.overlapStart !== after.overlapStart ||
    before.overlapEnd !== after.overlapEnd ||
    (beforeDays !== null && afterDays !== null && beforeDays !== afterDays);
  if (overlapChanged) {
    changes.push({
      field: 'overlap',
      label: '重叠起止/天数',
      before: { start: before.overlapStart || null, end: before.overlapEnd || null, days: beforeDays },
      after: { start: after.overlapStart || null, end: after.overlapEnd || null, days: afterDays },
    });
  }

  const beforeRes = strSet(before.sharedResources);
  const afterRes = strSet(after.sharedResources);
  const addedRes = [...afterRes].filter((r) => !beforeRes.has(r)).sort();
  const removedRes = [...beforeRes].filter((r) => !afterRes.has(r)).sort();
  if (addedRes.length || removedRes.length) {
    changes.push({
      field: 'sharedResources',
      label: '共享资源',
      before: [...beforeRes].sort(),
      after: [...afterRes].sort(),
      added: addedRes,
      removed: removedRes,
    });
  }

  return {
    changed: changes.length > 0,
    changes,
    beforeAreaM2: Number(before.areaM2) || 0,
    afterAreaM2: Number(after.areaM2) || 0,
  };
}

function pairLabel(key) {
  return key.split('::');
}

/** 排序：先按面积（取较大一侧）降序，再按重叠天数、区域对键兜底，保证结果稳定 */
function sortEntries(entries, beforeMap, afterMap) {
  entries.sort((x, y) => {
    const cx = afterMap.get(x.pairKey) || beforeMap.get(x.pairKey);
    const cy = afterMap.get(y.pairKey) || beforeMap.get(y.pairKey);
    const ax = Math.max(Number(cx?.areaM2) || 0, 0);
    const ay = Math.max(Number(cy?.areaM2) || 0, 0);
    if (ay !== ax) return ay - ax;
    const dx = Math.max(Number(cx?.overlapDays) || 0, 0);
    const dy = Math.max(Number(cy?.overlapDays) || 0, 0);
    if (dy !== dx) return dy - dx;
    return x.pairKey < y.pairKey ? -1 : x.pairKey > y.pairKey ? 1 : 0;
  });
}

/**
 * 对比两次已保存分析。
 * @param {Object} recordA 基线（较早）分析记录 {id, name, savedAt, result}
 * @param {Object} recordB 对照（较新）分析记录
 * @returns {Object} 分类差异结果
 * @throws {ComparisonError} 同一条分析 / 结果无效 / 区域集合不一致
 */
function compareAnalyses(recordA, recordB) {
  if (!recordA || !recordB || !recordA.id || !recordB.id) {
    throw new ComparisonError('缺少待对比的分析记录');
  }
  if (recordA.id === recordB.id) {
    throw new ComparisonError('请选择两条不同的已保存分析进行对比');
  }

  const resultA = requireValidResult(recordA, '基线分析');
  const resultB = requireValidResult(recordB, '对照分析');

  const zonesA = extractZoneSet(resultA);
  const zonesB = extractZoneSet(resultB);

  // ---- 区域集合一致性校验（不依赖冲突编号的可比性前提）----
  const onlyInA = [...zonesA.keys()].filter((id) => !zonesB.has(id)).sort();
  const onlyInB = [...zonesB.keys()].filter((id) => !zonesA.has(id)).sort();
  if (onlyInA.length || onlyInB.length) {
    const parts = [];
    if (onlyInB.length) {
      parts.push(`仅新分析「${recordB.name}」包含：${fmtNames(zonesB, onlyInB)}`);
    }
    if (onlyInA.length) {
      parts.push(`仅基线分析「${recordA.name}」包含：${fmtNames(zonesA, onlyInA)}`);
    }
    throw new ComparisonError(
      '两条分析的区域集合不同，无法按区域对匹配冲突。' +
      '请基于同一批区域重新运行并保存分析后再对比（删除/新增区域或重新导入都会改变区域集合）。差异：' +
      parts.join('；'),
      422,
      { code: 'ZONE_SET_MISMATCH', zonesOnlyInBefore: onlyInA, zonesOnlyInAfter: onlyInB }
    );
  }
  if (zonesA.size === 0) {
    throw new ComparisonError('两条分析均不含任何区域信息，无法对比');
  }

  const beforeMap = indexConflictsByPair(resultA);
  const afterMap = indexConflictsByPair(resultB);

  const added = [];
  const resolved = [];
  const persistent = [];

  for (const key of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    const [zoneAId, zoneBId] = pairLabel(key);
    const base = {
      pairKey: key,
      zones: [zonesA.get(zoneAId), zonesA.get(zoneBId)],
    };

    if (!beforeMap.has(key)) {
      added.push({ ...base, conflict: afterMap.get(key) });
    } else if (!afterMap.has(key)) {
      resolved.push({ ...base, conflict: beforeMap.get(key) });
    } else {
      const before = beforeMap.get(key);
      const after = afterMap.get(key);
      const diff = diffConflicts(before, after);
      persistent.push({
        ...base,
        changed: diff.changed,
        changes: diff.changes,
        before,
        after,
        beforeAreaM2: diff.beforeAreaM2,
        afterAreaM2: diff.afterAreaM2,
      });
    }
  }

  sortEntries(added, beforeMap, afterMap);
  sortEntries(resolved, beforeMap, afterMap);
  // 持续冲突：有属性变化的排前面，组内沿用面积/天数排序
  const changedEntries = persistent.filter((e) => e.changed);
  const unchangedEntries = persistent.filter((e) => !e.changed);
  sortEntries(changedEntries, beforeMap, afterMap);
  sortEntries(unchangedEntries, beforeMap, afterMap);
  persistent.splice(0, persistent.length, ...changedEntries, ...unchangedEntries);

  const summary = {
    added: added.length,
    resolved: resolved.length,
    persistent: persistent.length,
    persistentChanged: changedEntries.length,
    persistentUnchanged: unchangedEntries.length,
    beforeConflictCount: Array.isArray(resultA.conflicts) ? resultA.conflicts.length : 0,
    afterConflictCount: Array.isArray(resultB.conflicts) ? resultB.conflicts.length : 0,
  };

  return {
    comparedAt: new Date().toISOString(),
    zoneCount: zonesA.size,
    baseline: {
      id: recordA.id,
      name: recordA.name,
      savedAt: recordA.savedAt || null,
      params: recordA.params || resultA.params || {},
      generatedAt: resultA.generatedAt || null,
    },
    comparison: {
      id: recordB.id,
      name: recordB.name,
      savedAt: recordB.savedAt || null,
      params: recordB.params || resultB.params || {},
      generatedAt: resultB.generatedAt || null,
    },
    summary,
    added,
    resolved,
    persistent,
  };
}

module.exports = {
  compareAnalyses,
  extractZoneSet,
  indexConflictsByPair,
  pairKey,
  ComparisonError,
};
