'use strict';

const assert = require('assert');
const {
  buildResourceSchedule,
  listSharedResources,
  findResourceConflicts,
  normalizeCapacity,
  SchedulingError,
} = require('../src/scheduling');

/** 构造一条最小化的已保存分析记录（conflicts 直接给定） */
function makeRecord(conflicts, extra = {}) {
  return {
    id: 'ana-1',
    name: '测试分析',
    savedAt: '2026-09-01T00:00:00.000Z',
    result: { generatedAt: '2026-09-01T00:00:00.000Z', conflicts, ...extra },
  };
}

/** 冲突记录工厂（默认 resource 类型） */
function conflict(id, z1, z2, resource = '塔吊', type = 'resource', overlapDays) {
  const s = Math.max(Date.parse(z1.start), Date.parse(z2.start));
  const e = Math.min(Date.parse(z1.end), Date.parse(z2.end));
  return {
    id,
    conflictType: type,
    zones: [z1, z2],
    sharedResources: [resource],
    overlapStart: new Date(s).toISOString(),
    overlapEnd: new Date(e).toISOString(),
    overlapDays: overlapDays != null ? overlapDays : Math.round(((e - s) / 86400000) * 10) / 10,
  };
}

function zone(id, name, start, end) {
  return {
    id, name, layer: '土建',
    start: `${start}T00:00:00.000Z`,
    end: `${end}T00:00:00.000Z`,
    resources: ['塔吊'],
  };
}

const D = '2026-10'; // 日期前缀简写

// 1. 容量 1：三个工期相同、两两重叠的区域必须排成首尾相接
{
  const z1 = zone('z1', '一区', `${D}-01`, `${D}-11`); // 10 天
  const z2 = zone('z2', '二区', `${D}-05`, `${D}-15`);
  const z3 = zone('z3', '三区', `${D}-06`, `${D}-16`);
  const record = makeRecord([
    conflict('conflict-1', z1, z2),
    conflict('conflict-2', z2, z3),
    conflict('conflict-3', z1, z3),
  ]);
  const sched = buildResourceSchedule(record, { resource: '塔吊', capacity: 1 });

  assert.strictEqual(sched.empty, false);
  assert.strictEqual(sched.zoneCount, 3);
  assert.strictEqual(sched.delayedCount, 2, '后开工的两个区域应被顺延');
  assert.strictEqual(sched.resolvedCount, 3, '容量 1 下所有资源冲突都应消除');
  assert.strictEqual(sched.remainingCount, 0);

  const byId = Object.fromEntries(sched.plan.map((p) => [p.zoneId, p]));
  assert.strictEqual(byId.z1.suggestedStart, `${D}-01T00:00:00.000Z`, '最早开工者不动');
  assert.strictEqual(byId.z1.delayDays, 0);
  assert.strictEqual(byId.z2.suggestedStart, `${D}-11T00:00:00.000Z`, '二区顺延至一区完工');
  assert.strictEqual(byId.z2.delayDays, 6);
  assert.strictEqual(byId.z3.suggestedStart, `${D}-21T00:00:00.000Z`, '三区顺延至二区完工');
  assert.strictEqual(byId.z3.delayDays, 15);
  assert.strictEqual(sched.maxDelayDays, 15);

  // 工期保持不变
  for (const p of Object.values(byId)) {
    assert.strictEqual(p.durationDays, 10);
    const dur = Date.parse(p.suggestedEnd) - Date.parse(p.suggestedStart);
    assert.strictEqual(dur, Date.parse(p.originalEnd) - Date.parse(p.originalStart), '工期不得改变');
  }
  // 半开区间端点相接：建议安排互不重叠
  const sorted = [...sched.plan].sort((a, b) => Date.parse(a.suggestedStart) - Date.parse(b.suggestedStart));
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(Date.parse(sorted[i].suggestedStart) >= Date.parse(sorted[i - 1].suggestedEnd), '安排应互不重叠');
  }
}

// 2. 无相关冲突 → 空计划
{
  const record = makeRecord([]);
  const sched = buildResourceSchedule(record, { resource: '塔吊' });
  assert.strictEqual(sched.empty, true);
  assert.deepStrictEqual(sched.plan, []);
  assert.deepStrictEqual(sched.affectedConflicts, []);
  assert.strictEqual(sched.zoneCount, 0);
  assert.strictEqual(sched.delayedCount, 0);
  assert.strictEqual(sched.message.includes('塔吊'), true);

  // 分析中存在冲突但不涉及所选资源，同样返回空计划
  const z1 = zone('z1', '一区', `${D}-01`, `${D}-11`);
  const z2 = zone('z2', '二区', `${D}-05`, `${D}-15`);
  const record2 = makeRecord([conflict('conflict-1', z1, z2, '挖掘机')]);
  const sched2 = buildResourceSchedule(record2, { resource: '塔吊' });
  assert.strictEqual(sched2.empty, true);
  assert.deepStrictEqual(sched2.plan, []);
}

// 3. 容量足够（>= 并发数）→ 全部不延后，冲突标记为仍保留
{
  const z1 = zone('z1', '一区', `${D}-01`, `${D}-11`);
  const z2 = zone('z2', '二区', `${D}-05`, `${D}-15`);
  const record = makeRecord([conflict('conflict-1', z1, z2)]);
  const sched = buildResourceSchedule(record, { resource: '塔吊', capacity: 2 });
  assert.strictEqual(sched.delayedCount, 0);
  assert.strictEqual(sched.resolvedCount, 0);
  assert.strictEqual(sched.remainingCount, 1);
  assert.strictEqual(sched.affectedConflicts[0].remaining, true);
  assert.strictEqual(sched.plan[0].delayDays, 0);
}

// 4. 容量 2、3 个并发区域 → 仅一个顺延
{
  const z1 = zone('z1', '一区', `${D}-01`, `${D}-11`);
  const z2 = zone('z2', '二区', `${D}-02`, `${D}-12`);
  const z3 = zone('z3', '三区', `${D}-03`, `${D}-13`);
  const record = makeRecord([
    conflict('conflict-1', z1, z2),
    conflict('conflict-2', z2, z3),
    conflict('conflict-3', z1, z3),
  ]);
  const sched = buildResourceSchedule(record, { resource: '塔吊', capacity: 2 });
  assert.strictEqual(sched.delayedCount, 1, '容量 2 时只需顺延第三个');
  const byId = Object.fromEntries(sched.plan.map((p) => [p.zoneId, p]));
  assert.strictEqual(byId.z1.delayDays, 0);
  assert.strictEqual(byId.z2.delayDays, 0);
  assert.strictEqual(byId.z3.suggestedStart, `${D}-11T00:00:00.000Z`, '三区等一区释放后排入');
  assert.strictEqual(byId.z3.delayDays, 8);
  // 排程后：z1×z2 仍并发、z2[02,12) 与 z3[11,21) 仍重叠；z1×z3 已错开
  const rem = sched.affectedConflicts.filter((c) => c.remaining).map((c) => c.conflictId).sort();
  assert.deepStrictEqual(rem, ['conflict-1', 'conflict-2']);
  assert.strictEqual(sched.resolvedCount, 1);
  assert.strictEqual(sched.remainingCount, 2);
}

// 5. 不同工期链式顺延：短任务也要等长任务释放资源
{
  // z1 [01,11) 10 天, z2 [05,25) 20 天, z3 [06,10) 4 天；容量 1
  // 顺序：z1 → z2(顺延至 11) → z3：06 与 z1 冲突，11 与 z2 冲突，25 才可行
  const z1 = zone('z1', '一区', `${D}-01`, `${D}-11`);
  const z2 = zone('z2', '二区', `${D}-05`, `${D}-25`);
  const z3 = zone('z3', '三区', `${D}-06`, `${D}-10`);
  const record = makeRecord([
    conflict('conflict-1', z1, z2),
    conflict('conflict-2', z1, z3),
    conflict('conflict-3', z2, z3),
  ]);
  const sched = buildResourceSchedule(record, { resource: '塔吊', capacity: 1 });
  const byId = Object.fromEntries(sched.plan.map((p) => [p.zoneId, p]));
  assert.strictEqual(byId.z2.suggestedStart, `${D}-11T00:00:00.000Z`);
  assert.strictEqual(byId.z3.suggestedStart, `${D}-31T00:00:00.000Z`);
  assert.strictEqual(byId.z3.suggestedEnd, `2026-11-04T00:00:00.000Z`, '短任务工期保持 4 天');
  assert.strictEqual(byId.z3.delayDays, 25);
}

// 6. 入参校验
assert.strictEqual(normalizeCapacity(undefined), 1);
assert.strictEqual(normalizeCapacity(3), 3);
assert.throws(() => normalizeCapacity(0), /可用数量/);
assert.throws(() => normalizeCapacity(1.5), /可用数量/);
assert.throws(() => normalizeCapacity(-2), /可用数量/);
assert.throws(() => normalizeCapacity('abc'), /可用数量/);

assert.throws(
  () => buildResourceSchedule(makeRecord([]), { capacity: 1 }),
  (e) => e instanceof SchedulingError && /选择一种共享资源/.test(e.message)
);
assert.throws(() => buildResourceSchedule(null, { resource: '塔吊' }), /分析记录无效/);
assert.throws(
  () => buildResourceSchedule({ id: 'x', result: {} }, { resource: '塔吊' }),
  /数据不完整/
);

// 7. 不修改原分析结果（深比较冲突记录引用对象的关键字段）
{
  const z1 = zone('z1', '一区', `${D}-01`, `${D}-11`);
  const z2 = zone('z2', '二区', `${D}-05`, `${D}-15`);
  const record = makeRecord([conflict('conflict-1', z1, z2)]);
  const snapshot = JSON.stringify(record);
  buildResourceSchedule(record, { resource: '塔吊', capacity: 1 });
  assert.strictEqual(JSON.stringify(record), snapshot, '排程不得修改原分析记录');
}

// 8. both 类型冲突同样纳入；纯 spatial 冲突不纳入
{
  const z1 = zone('z1', '一区', `${D}-01`, `${D}-11`);
  const z2 = zone('z2', '二区', `${D}-05`, `${D}-15`);
  const z3 = zone('z3', '三区', `${D}-05`, `${D}-15`);
  const record = makeRecord([
    conflict('conflict-1', z1, z2, '塔吊', 'both'),
    { ...conflict('conflict-2', z1, z3, '塔吊', 'spatial'), sharedResources: [] },
  ]);
  const found = findResourceConflicts(record.result, '塔吊');
  assert.deepStrictEqual(found.map((c) => c.id), ['conflict-1']);
  const sched = buildResourceSchedule(record, { resource: '塔吊' });
  assert.strictEqual(sched.zoneCount, 2, '仅 both 冲突中的两个区域参与排程');
  assert.strictEqual(sched.conflictCount, 1);
}

// 9. listSharedResources：聚合冲突数/区域数并排序
{
  const z1 = zone('z1', '一区', `${D}-01`, `${D}-11`);
  const z2 = zone('z2', '二区', `${D}-05`, `${D}-15`);
  const z3 = zone('z3', '三区', `${D}-05`, `${D}-15`);
  const c1 = conflict('conflict-1', z1, z2, '塔吊');
  const c2 = conflict('conflict-2', z2, z3, '挖掘机');
  const c3 = conflict('conflict-3', z1, z3, '塔吊');
  const list = listSharedResources(makeRecord([c1, c2, c3]).result);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].resource, '塔吊');
  assert.strictEqual(list[0].conflictCount, 2);
  assert.strictEqual(list[0].zoneCount, 3);
  assert.strictEqual(list[1].resource, '挖掘机');
  assert.deepStrictEqual(listSharedResources({ conflicts: [] }), []);
}

// 10. 输出结构与排序：plan 按建议开始时间升序；affectedConflicts 带双方信息
{
  const z1 = zone('z1', '一区', `${D}-01`, `${D}-11`);
  const z2 = zone('z2', '二区', `${D}-05`, `${D}-15`);
  const record = makeRecord([conflict('conflict-7', z1, z2)]);
  const sched = buildResourceSchedule(record, { resource: '塔吊' });
  assert.ok(sched.generatedAt);
  assert.strictEqual(sched.resource, '塔吊');
  assert.strictEqual(sched.capacity, 1, '缺省容量为 1');
  assert.deepStrictEqual(sched.analysis, {
    id: 'ana-1', name: '测试分析',
    savedAt: '2026-09-01T00:00:00.000Z', generatedAt: '2026-09-01T00:00:00.000Z',
  });
  for (let i = 1; i < sched.plan.length; i++) {
    assert.ok(
      Date.parse(sched.plan[i - 1].suggestedStart) <= Date.parse(sched.plan[i].suggestedStart),
      'plan 应按建议开始时间升序'
    );
  }
  const ac = sched.affectedConflicts[0];
  assert.strictEqual(ac.conflictId, 'conflict-7');
  assert.strictEqual(ac.zones.length, 2);
  assert.deepStrictEqual(ac.sharedResources, ['塔吊']);
  assert.strictEqual(ac.remaining, false);
  // 区域条目回链受影响冲突 id
  assert.deepStrictEqual(sched.plan[0].affectedConflictIds, ['conflict-7']);
}

// 11. 同开始时间按结束早者优先（确定性）：两个同时开工、工期一长一短
{
  const z1 = zone('z1', '长任务', `${D}-01`, `${D}-21`); // 20 天
  const z2 = zone('z2', '短任务', `${D}-01`, `${D}-06`); // 5 天
  const record = makeRecord([conflict('conflict-1', z1, z2)]);
  const sched = buildResourceSchedule(record, { resource: '塔吊' });
  const byId = Object.fromEntries(sched.plan.map((p) => [p.zoneId, p]));
  assert.strictEqual(byId.z2.delayDays, 0, '同刻开工时结束更早者先排');
  assert.strictEqual(byId.z1.suggestedStart, `${D}-06T00:00:00.000Z`);
}

console.log('✅ 全部排程测试通过');
