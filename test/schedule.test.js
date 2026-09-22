'use strict';

const assert = require('assert');
const { analyze } = require('../src/analysis');
const { buildSchedule, listScheduleResources, ScheduleError } = require('../src/schedule');

function square(lon1, lat1, lon2, lat2) {
  return {
    type: 'Polygon',
    coordinates: [[[lon1, lat1], [lon2, lat1], [lon2, lat2], [lon1, lat2], [lon1, lat1]]],
  };
}

function zone(id, name, start, end, resources, lon = 121.5) {
  return {
    id, name, layer: '土建',
    start: `${start}T00:00:00.000Z`,
    end: `${end}T00:00:00.000Z`,
    resources,
    // 各区域空间远离，避免产生空间冲突，聚焦资源排程
    geometry: square(lon, 31.25, lon + 0.004, 31.253),
  };
}

function recordOf(zones, options) {
  const result = analyze(zones, options);
  return { id: 'analysis-1', name: '测试分析', savedAt: new Date().toISOString(), result };
}

function byId(plan, id) {
  return plan.zones.find((z) => z.zoneId === id);
}

// 1. 容量 1：三个同资源区域错峰串行，后两个依次顺延且工期不变
let record = recordOf([
  zone('a', 'A区', '2026-10-01', '2026-10-11', ['塔吊'], 121.500), // 10 天
  zone('b', 'B区', '2026-10-05', '2026-10-15', ['塔吊'], 121.510), // 与 A 重叠
  zone('c', 'C区', '2026-10-10', '2026-10-20', ['塔吊'], 121.520), // 与 A/B 均重叠（10-10 起三方并发）
]);
let plan = buildSchedule(record, { resource: '塔吊', capacity: 1 });
assert.strictEqual(plan.empty, false);
assert.strictEqual(plan.capacity, 1);
assert.strictEqual(plan.zones.length, 3);
assert.strictEqual(plan.conflicts.length, 3);

const pa = byId(plan, 'a');
const pb = byId(plan, 'b');
const pc = byId(plan, 'c');
assert.strictEqual(pa.delayDays, 0, '最早开工的 A 不应顺延');
assert.strictEqual(pa.scheduledStart, '2026-10-01T00:00:00.000Z');
assert.strictEqual(pa.scheduledEnd, '2026-10-11T00:00:00.000Z', '工期应保持不变');
assert.strictEqual(pb.scheduledStart, '2026-10-11T00:00:00.000Z', 'B 应顺延到 A 完工');
assert.strictEqual(pb.scheduledEnd, '2026-10-21T00:00:00.000Z', 'B 工期保持 10 天');
assert.strictEqual(pb.delayDays, 6);
assert.strictEqual(pc.scheduledStart, '2026-10-21T00:00:00.000Z', 'C 应链式顺延到 B 完工');
assert.strictEqual(pc.scheduledEnd, '2026-10-31T00:00:00.000Z');
assert.strictEqual(pc.delayDays, 11);

// 容量 1 下所有相关冲突都应解除
assert.strictEqual(plan.summary.affectedConflictCount, 3);
assert.strictEqual(plan.summary.resolvedConflictCount, 3);
assert.strictEqual(plan.summary.remainingConflictCount, 0);
assert.strictEqual(plan.summary.delayedZoneCount, 2);
assert.strictEqual(plan.summary.maxDelayDays, 11);
assert.ok(plan.conflicts.every((c) => c.resolvedAfterSchedule === true));
assert.ok(plan.conflicts.every((c) => c.scheduledOverlap === null));

// 区域级受影响冲突：B 同时与 A、C 冲突
assert.strictEqual(pb.affectedConflictCount, 2);
assert.ok(pb.affectedConflicts.every((c) => c.resolvedAfterSchedule));
assert.ok(pb.affectedConflicts.some((c) => c.otherZone && c.otherZone.id === 'a'));
assert.ok(pb.affectedConflicts.some((c) => c.otherZone && c.otherZone.id === 'c'));

// 2. 容量 2：链式重叠（任意时刻最多 2 个并发）区域全部不需顺延，冲突按容量保留
record = recordOf([
  zone('a', 'A区', '2026-10-01', '2026-10-20', ['塔吊'], 121.500),
  zone('b', 'B区', '2026-10-10', '2026-10-30', ['塔吊'], 121.510), // 仅与 A 重叠
  zone('c', 'C区', '2026-10-20', '2026-11-09', ['塔吊'], 121.520), // 与 A 端点相接（不重叠），与 B 重叠
  zone('d', 'D区', '2026-10-30', '2026-11-20', ['塔吊'], 121.530), // 与 B 端点相接，与 C 重叠
]);
plan = buildSchedule(record, { resource: '塔吊', capacity: 2 });
assert.strictEqual(plan.zones.length, 4);
assert.ok(plan.zones.every((z) => z.delayDays === 0), '并发从未达到 3，不应有顺延');
assert.strictEqual(plan.summary.affectedConflictCount, 3);
assert.strictEqual(plan.summary.resolvedConflictCount, 0);
assert.strictEqual(plan.summary.remainingConflictCount, 3, '容量 2 允许冲突保留');
assert.ok(plan.conflicts.every((c) => c.resolvedAfterSchedule === false));
assert.ok(plan.conflicts.every((c) => c.scheduledOverlap && c.scheduledOverlap.days > 0));
record = recordOf([
  zone('a', 'A区', '2026-10-01', '2026-11-01', ['塔吊'], 121.500),
  zone('b', 'B区', '2026-10-02', '2026-11-02', ['塔吊'], 121.510),
  zone('c', 'C区', '2026-10-03', '2026-11-03', ['塔吊'], 121.520),
  zone('d', 'D区', '2026-10-04', '2026-11-04', ['塔吊'], 121.530),
]);
plan = buildSchedule(record, { resource: '塔吊', capacity: 2 });
const c3 = byId(plan, 'c');
const d3 = byId(plan, 'd');
assert.strictEqual(c3.scheduledStart, '2026-11-01T00:00:00.000Z', 'C 应等到 A(11-01) 完工');
assert.strictEqual(c3.delayDays, 29);
assert.strictEqual(c3.scheduledEnd, '2026-12-02T00:00:00.000Z', 'C 工期保持 31 天');
assert.strictEqual(d3.scheduledStart, '2026-11-02T00:00:00.000Z', 'D 应等到 B(11-02) 完工');
assert.strictEqual(d3.delayDays, 29);
// 排程后剩余冲突恰好为容量允许的 3 条（A-B、B-C、C-D）
assert.strictEqual(plan.summary.remainingConflictCount, 3);
assert.strictEqual(plan.summary.resolvedConflictCount, 3);
// 排程后任意时刻并发不超过 2：收集全部起止点逐一验证
const wins = plan.zones.map((z) => [Date.parse(z.scheduledStart), Date.parse(z.scheduledEnd)]);
const points = [...new Set(wins.flat())];
for (const t of points) {
  const n = wins.filter(([s, e]) => s <= t && t < e).length;
  assert.ok(n <= 2, `时刻 ${new Date(t).toISOString()} 并发 ${n} 超过容量 2`);
}

// 4. 无相关冲突 → 空计划
record = recordOf([
  zone('a', 'A区', '2026-10-01', '2026-10-11', ['塔吊'], 121.500),
  zone('b', 'B区', '2026-10-20', '2026-11-01', ['挖掘机'], 121.510),
]);
plan = buildSchedule(record, { resource: '塔吊' });
assert.strictEqual(plan.empty, true);
assert.deepStrictEqual(plan.zones, []);
assert.deepStrictEqual(plan.conflicts, []);
assert.strictEqual(plan.summary.affectedConflictCount, 0);
assert.strictEqual(plan.capacity, 1, '缺省容量为 1');

// 5. 不相关的资源（任何区域都未占用）也是空计划，不报错
plan = buildSchedule(recordOf([
  zone('a', 'A区', '2026-10-01', '2026-10-11', ['塔吊'], 121.500),
  zone('b', 'B区', '2026-10-05', '2026-10-15', ['塔吊'], 121.510),
]), { resource: '盾构机' });
assert.strictEqual(plan.empty, true);

// 6. 入参校验
assert.throws(() => buildSchedule(record, {}), /选择一种共享资源/, '未选资源应报错');
assert.throws(() => buildSchedule(record, { resource: '塔吊', capacity: 0 }), /可用数量/);
assert.throws(() => buildSchedule(record, { resource: '塔吊', capacity: -1 }), /可用数量/);
assert.throws(() => buildSchedule(record, { resource: '塔吊', capacity: 1.5 }), /可用数量/);
assert.throws(() => buildSchedule(record, { resource: '塔吊', capacity: 'abc' }), /可用数量/);
assert.throws(() => buildSchedule(null, { resource: '塔吊' }), ScheduleError);
assert.throws(
  () => buildSchedule({ id: 'x', result: {} }, { resource: '塔吊' }),
  /数据不完整/
);

// 7. 可排程资源列表：按冲突数降序、名称兜底
record = recordOf([
  zone('a', 'A区', '2026-10-01', '2026-11-01', ['塔吊', '泵车'], 121.500),
  zone('b', 'B区', '2026-10-02', '2026-11-02', ['塔吊'], 121.510),
  zone('c', 'C区', '2026-10-03', '2026-11-03', ['泵车', '挖掘机'], 121.520),
  zone('d', 'D区', '2027-01-01', '2027-02-01', ['塔吊'], 121.530), // 时间不重叠，不产生塔吊冲突
]);
const resources = listScheduleResources(record.result);
const find = (r) => resources.find((x) => x.resource === r);
assert.strictEqual(find('塔吊').conflictCount, 1, 'A∩B 一条塔吊冲突');
assert.strictEqual(find('塔吊').zoneCount, 2);
assert.strictEqual(find('泵车').conflictCount, 1, 'A∩C 一条泵车冲突');
assert.strictEqual(find('挖掘机'), undefined, '挖掘机未发生冲突，不应出现在列表');
assert.ok(resources[0].conflictCount >= resources[resources.length - 1].conflictCount,
  '资源列表应按冲突数降序');

// 8. 排程不修改原分析结果
const snapshot = JSON.parse(JSON.stringify(record.result));
const snapZone = record.result.conflicts[0].zones[0];
buildSchedule(record, { resource: '塔吊', capacity: 1 });
assert.deepStrictEqual(record.result, snapshot, '分析结果应原样不变');
assert.ok(snapZone.start !== undefined);

// 9. both 类型冲突（空间+资源）同样纳入排程，且资源无关的纯空间冲突不纳入
record = (() => {
  const zones = [
    {
      id: 'p1', name: 'P1', layer: '土建',
      start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z',
      resources: ['塔吊'],
      geometry: square(121.470, 31.228, 121.474, 31.231),
    },
    {
      id: 'p2', name: 'P2', layer: '土建',
      start: '2026-10-15T00:00:00.000Z', end: '2026-11-15T00:00:00.000Z',
      resources: ['塔吊'],
      geometry: square(121.472, 31.229, 121.476, 31.232), // 与 P1 空间相交
    },
  ];
  const result = analyze(zones);
  return { id: 'analysis-both', name: '空间+资源', result };
})();
assert.strictEqual(record.result.conflicts[0].conflictType, 'both');
plan = buildSchedule(record, { resource: '塔吊', capacity: 1 });
assert.strictEqual(plan.zones.length, 2, 'both 冲突的区域应纳入排程');
assert.strictEqual(plan.conflicts[0].conflictType, 'both');
assert.strictEqual(byId(plan, 'p2').delayDays, 17, 'P2 从 10-15 顺延到 11-01');
assert.ok(plan.conflicts.every((c) => c.resolvedAfterSchedule));

// 10. 纯空间冲突的资源不产生排程计划
record = recordOf([
  {
    id: 's1', name: 'S1', layer: '土建',
    start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z',
    resources: [],
    geometry: square(121.470, 31.228, 121.474, 31.231),
  },
  {
    id: 's2', name: 'S2', layer: '土建',
    start: '2026-10-15T00:00:00.000Z', end: '2026-11-15T00:00:00.000Z',
    resources: [],
    geometry: square(121.472, 31.229, 121.476, 31.232),
  },
]);
assert.strictEqual(record.result.conflicts[0].conflictType, 'spatial');
assert.deepStrictEqual(listScheduleResources(record.result), []);

console.log('✅ schedule 全部测试通过');
