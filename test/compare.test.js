'use strict';

const assert = require('assert');
const { analyze } = require('../src/analysis');
const {
  compareAnalyses,
  extractZoneSet,
  indexConflictsByPair,
  pairKey,
  ComparisonError,
} = require('../src/compare');

function square(lon1, lat1, lon2, lat2) {
  return {
    type: 'Polygon',
    coordinates: [[[lon1, lat1], [lon2, lat1], [lon2, lat2], [lon1, lat2], [lon1, lat1]]],
  };
}

function zone(id, { start, end, resources = [] } = {}) {
  return {
    id, name: id, layer: 'L',
    start: start || '2026-10-01T00:00:00.000Z',
    end: end || '2026-11-30T00:00:00.000Z',
    resources,
    // 四个区域同处一片相交区域（完全重合），冲突形态完全由时间窗与资源决定
    geometry: square(121.470, 31.228, 121.475, 31.232),
  };
}

function record(id, name, result) {
  return { id, name, savedAt: new Date().toISOString(), params: result.params, result };
}

// 四区域两两空间相交。
// 基线：z3×z4 同时共享塔吊 → both；其余 5 对均为 spatial
const baseZones = [
  zone('z1'), zone('z2'),
  zone('z3', { resources: ['塔吊'] }),
  zone('z4', { resources: ['塔吊'] }),
];
const baseResult = analyze(baseZones);
const base = record('a1', '基线分析', baseResult);

assert.strictEqual(baseResult.conflictCount, 6, '4 个两两相交区域应产生 6 对冲突');
assert.strictEqual(baseResult.conflictCountByType.both, 1);
assert.strictEqual(baseResult.conflictCountByType.spatial, 5);
assert.strictEqual(baseResult.zoneSummaries.length, 4);

// 对照（同一区域集合）：
// - z1 提前到 11-15 完工 → z1 与其余三对的重叠期缩短（overlap 变化）
// - z2 占用泵车、z3 占用塔吊+泵车 → z2×z3 变为 both（类型 + 共享资源变化）
// - z4 不再占用塔吊 → z3×z4 从 both 退回 spatial（类型 + 共享资源变化）
// - z2×z4 始终无共享资源、重叠期不变 → 持续且无任何属性变化
const afterZones = [
  zone('z1', { end: '2026-11-15T00:00:00.000Z' }),
  zone('z2', { resources: ['泵车'] }),
  zone('z3', { resources: ['塔吊', '泵车'] }),
  zone('z4'),
];
const afterResult = analyze(afterZones);
const after = record('a2', '对照分析', afterResult);

const cmp = compareAnalyses(base, after);

// 0. 元信息与汇总结构
assert.strictEqual(cmp.baseline.id, 'a1');
assert.strictEqual(cmp.comparison.id, 'a2');
assert.strictEqual(cmp.zoneCount, 4);
for (const k of ['added', 'resolved', 'persistent', 'persistentChanged', 'persistentUnchanged',
  'beforeConflictCount', 'afterConflictCount']) {
  assert.ok(Number.isInteger(cmp.summary[k]), `summary.${k} 应为整数`);
}
assert.strictEqual(cmp.summary.added, 0);
assert.strictEqual(cmp.summary.resolved, 0);
assert.strictEqual(cmp.summary.persistent, 6);
assert.strictEqual(cmp.summary.persistentChanged, 5, '5 对有属性变化');
assert.strictEqual(cmp.summary.persistentUnchanged, 1, 'z2×z4 无变化');
assert.strictEqual(
  cmp.summary.added + cmp.summary.resolved + cmp.summary.persistent,
  new Set([...indexConflictsByPair(baseResult).keys(), ...indexConflictsByPair(afterResult).keys()]).size,
  '三类数量之和应等于两侧区域对键的并集大小'
);

// 1. 按区域对匹配，不依赖冲突编号
const allPairs = new Set([
  ...indexConflictsByPair(baseResult).keys(),
  ...indexConflictsByPair(afterResult).keys(),
]);
for (const e of cmp.persistent) {
  assert.ok(allPairs.has(e.pairKey), '每条对比项必须对应一个真实区域对');
  assert.strictEqual(e.zones.length, 2, '对比项必须带两个区域摘要');
}

// 2. 变化项的具体字段
const byPair = Object.fromEntries(cmp.persistent.map((e) => [e.pairKey, e]));
const z2z3 = byPair[pairKey('z2', 'z3')];
assert.ok(z2z3.changed);
assert.ok(z2z3.changes.some((ch) => ch.field === 'conflictType' &&
  ch.before === 'spatial' && ch.after === 'both'), 'z2×z3 类型应 spatial → both');
assert.ok(z2z3.changes.some((ch) => ch.field === 'sharedResources' &&
  ch.added.includes('泵车')), 'z2×z3 应新增共享资源「泵车」');

const z3z4 = byPair[pairKey('z3', 'z4')];
assert.ok(z3z4.changes.some((ch) => ch.field === 'conflictType' &&
  ch.before === 'both' && ch.after === 'spatial'), 'z3×z4 类型应 both → spatial');
assert.ok(z3z4.changes.some((ch) => ch.field === 'sharedResources' &&
  ch.removed.includes('塔吊')), 'z3×z4 应移除共享资源「塔吊」');

const z1z2 = byPair[pairKey('z1', 'z2')];
const ov = z1z2.changes.find((ch) => ch.field === 'overlap');
assert.ok(ov, 'z1×z2 应有重叠期变化');
assert.strictEqual(ov.before.days, 60);
assert.strictEqual(ov.after.days, 45);
assert.strictEqual(ov.after.end, '2026-11-15T00:00:00.000Z');

const z2z4 = byPair[pairKey('z2', 'z4')];
assert.strictEqual(z2z4.changed, false, 'z2×z4 属性应完全不变');
assert.deepStrictEqual(z2z4.changes, []);

// 3. 单区域对的受控测试
function makePairResult({ aRes, bRes, aStart = '2026-10-01T00:00:00.000Z',
  aEnd = '2026-11-30T00:00:00.000Z',
  bStart = '2026-10-10T00:00:00.000Z',
  bEnd = '2026-11-20T00:00:00.000Z' } = {}) {
  return analyze([
    { id: 'x', name: 'X', layer: 'L', start: aStart, end: aEnd, resources: aRes,
      geometry: square(121.470, 31.228, 121.475, 31.232) },
    { id: 'y', name: 'Y', layer: 'L', start: bStart, end: bEnd, resources: bRes,
      geometry: square(121.472, 31.229, 121.477, 31.233) },
  ]);
}

// 3a. 完全一致 → 持续且无变化
const r1 = makePairResult({ aRes: [], bRes: [] });
const r1b = makePairResult({ aRes: [], bRes: [] });
const c1 = compareAnalyses(record('m1', 'M1', r1), record('m2', 'M2', r1b));
assert.strictEqual(c1.summary.persistent, 1);
assert.strictEqual(c1.summary.persistentUnchanged, 1);
assert.strictEqual(c1.summary.added + c1.summary.resolved, 0);
assert.strictEqual(c1.persistent[0].changed, false);
assert.deepStrictEqual(c1.persistent[0].changes, []);

// 3b. 重叠期缩短（Y 提前结束）→ overlap 变化
const r2 = makePairResult({
  aRes: [], bRes: [],
  bStart: '2026-10-10T00:00:00.000Z',
  bEnd: '2026-11-05T00:00:00.000Z',
});
const c2 = compareAnalyses(record('m1', 'M1', r1), record('m2', 'M2', r2));
const p2 = c2.persistent[0];
assert.strictEqual(p2.changed, true);
const overlapCh = p2.changes.find((ch) => ch.field === 'overlap');
assert.ok(overlapCh, '应检测到重叠起止/天数变化');
assert.strictEqual(overlapCh.before.days, 41); // 10-10 ~ 11-20
assert.strictEqual(overlapCh.after.days, 26);  // 10-10 ~ 11-05
assert.strictEqual(overlapCh.after.end, '2026-11-05T00:00:00.000Z');

// 3c. spatial → both（新增共享资源）：类型变化 + 共享资源变化
const r3 = makePairResult({ aRes: ['塔吊'], bRes: ['塔吊'] });
const c3 = compareAnalyses(record('m1', 'M1', r1), record('m2', 'M2', r3));
const p3 = c3.persistent[0];
assert.strictEqual(p3.changed, true);
assert.ok(p3.changes.some((ch) => ch.field === 'conflictType' &&
  ch.before === 'spatial' && ch.after === 'both'), '应检测到类型 spatial → both');
const resCh = p3.changes.find((ch) => ch.field === 'sharedResources');
assert.ok(resCh, '应检测到共享资源变化');
assert.deepStrictEqual(resCh.added, ['塔吊']);
assert.deepStrictEqual(resCh.removed, []);

// 3d. both → resource 几何不变但…资源保留而类型改变很难构造（类型由几何决定），
//     改为验证共享资源部分移除：both(塔吊,泵车) → both(塔吊)
const r4a = makePairResult({ aRes: ['塔吊', '泵车'], bRes: ['塔吊', '泵车'] });
const r4b = makePairResult({ aRes: ['塔吊', '泵车'], bRes: ['塔吊'] });
const c4 = compareAnalyses(record('m1', 'M1', r4a), record('m2', 'M2', r4b));
const p4 = c4.persistent[0];
assert.strictEqual(p4.changed, true);
const resCh4 = p4.changes.find((ch) => ch.field === 'sharedResources');
assert.deepStrictEqual(resCh4.added, []);
assert.deepStrictEqual(resCh4.removed, ['泵车']);
assert.ok(!p4.changes.some((ch) => ch.field === 'conflictType'), '类型仍为 both');

// 4. 新增 / 已解决：两区域 X×Y，基线无冲突（时间错开）、对照有冲突 → added；反向 → resolved
function timeSplitPair(bOverlap) {
  return analyze([
    { id: 'x', name: 'X', layer: 'L', start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z',
      geometry: square(121.470, 31.228, 121.475, 31.232) },
    {
      id: 'y', name: 'Y', layer: 'L',
      start: bOverlap ? '2026-10-20T00:00:00.000Z' : '2026-12-01T00:00:00.000Z',
      end: bOverlap ? '2026-12-15T00:00:00.000Z' : '2026-12-20T00:00:00.000Z',
      geometry: square(121.472, 31.229, 121.477, 31.233),
    },
  ]);
}
const noOverlap = timeSplitPair(false);
const overlap = timeSplitPair(true);
assert.strictEqual(noOverlap.conflictCount, 0);
assert.strictEqual(overlap.conflictCount, 1);

const cAdded = compareAnalyses(record('n1', '无重叠', noOverlap), record('n2', '有重叠', overlap));
assert.strictEqual(cAdded.summary.added, 1);
assert.strictEqual(cAdded.summary.resolved, 0);
assert.strictEqual(cAdded.summary.persistent, 0);
assert.strictEqual(cAdded.added[0].conflict.conflictType, 'spatial');
assert.deepStrictEqual(cAdded.added[0].zones.map((z) => z.id).sort(), ['x', 'y']);

const cResolved = compareAnalyses(record('n1', '有重叠', overlap), record('n2', '无重叠', noOverlap));
assert.strictEqual(cResolved.summary.resolved, 1);
assert.strictEqual(cResolved.summary.added, 0);
assert.strictEqual(cResolved.resolved[0].conflict.conflictType, 'spatial');

// 5. 区域集合不同 → 可理解的错误（422 + code + 差异区域 id）
const threeZones = [...baseZones, zone('z5', { resources: ['塔吊'] })];
const withExtra = record('a3', '多一个区域', analyze(threeZones));
try {
  compareAnalyses(base, withExtra);
  assert.fail('区域集合不同应抛错');
} catch (err) {
  assert.ok(err instanceof ComparisonError);
  assert.strictEqual(err.status, 422);
  assert.strictEqual(err.code, 'ZONE_SET_MISMATCH');
  assert.ok(/区域集合不同/.test(err.message), '错误信息应说明区域集合不同');
  assert.deepStrictEqual(err.zonesOnlyInAfter, ['z5']);
  assert.ok(err.message.includes('z5'), '错误信息应尽量带区域名称');
}

// 缺少区域（删除）方向
const fewer = record('a4', '少区域', analyze([baseZones[0], baseZones[1]]));
try {
  compareAnalyses(base, fewer);
  assert.fail('区域集合不同应抛错');
} catch (err) {
  assert.strictEqual(err.code, 'ZONE_SET_MISMATCH');
  assert.ok(err.zonesOnlyInBefore.length >= 1, '应列出仅基线包含的区域');
}

// 6. 无效输入
assert.throws(() => compareAnalyses(base, base), /两条不同/, '同一分析对比应拒绝');
assert.throws(
  () => compareAnalyses(base, { id: 'xx', name: '坏数据', result: { conflicts: 'nope' } }),
  /数据不完整/,
  '结果损坏应给出可理解错误'
);
assert.throws(
  () => compareAnalyses(
    record('e1', '空1', analyze([])),
    record('e2', '空2', analyze([]))
  ),
  /不含任何区域/,
  '两条空分析无法对比'
);

// 7. 无 zoneSummaries 的旧版结果：从冲突记录回退恢复区域集合，仍可对比
function legacyResult(result) {
  const { zoneSummaries, ...legacy } = result;
  return legacy;
}
const legacyCmp = compareAnalyses(
  record('l1', '旧版1', legacyResult(r1)),
  record('l2', '旧版2', legacyResult(r1b))
);
assert.strictEqual(legacyCmp.zoneCount, 2, '旧版结果应从冲突中恢复区域集合');
assert.strictEqual(legacyCmp.summary.persistent, 1);
assert.strictEqual(extractZoneSet(legacyResult(r1)).size, 2);

// 8. pairKey 与排序稳定性：区域 id 顺序无关
assert.strictEqual(pairKey('a', 'b'), pairKey('b', 'a'));
const stable1 = compareAnalyses(record('s1', 'S1', r1), record('s2', 'S2', r1b));
const stable2 = compareAnalyses(record('s1', 'S1', r1), record('s2', 'S2', r1b));
assert.deepStrictEqual(
  stable1.persistent.map((e) => e.pairKey),
  stable2.persistent.map((e) => e.pairKey)
);

console.log('✅ 分析对比测试全部通过');
