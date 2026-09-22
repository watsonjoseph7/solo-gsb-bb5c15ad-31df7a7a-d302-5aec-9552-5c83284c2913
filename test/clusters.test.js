'use strict';

const assert = require('assert');
const { analyze } = require('../src/analysis');
const { buildClusters } = require('../src/clusters');

function square(lon1, lat1, lon2, lat2) {
  return {
    type: 'Polygon',
    coordinates: [[[lon1, lat1], [lon2, lat1], [lon2, lat2], [lon1, lat2], [lon1, lat1]]],
  };
}

function zone(id, lon, lat, start = '2026-10-01', end = '2026-12-31', resources = []) {
  return {
    id, name: id, layer: 'L',
    start, end, resources,
    geometry: square(lon, lat, lon + 0.002, lat + 0.002),
  };
}

function conflict(id, zoneA, zoneB, conflictType = 'spatial', overlapDays = 10) {
  return {
    id,
    conflictType,
    overlapDays,
    sharedResources: conflictType === 'spatial' ? [] : ['塔吊'],
    geometry: conflictType === 'resource' ? null : { type: 'MultiPolygon', coordinates: [] },
    zones: [
      { id: zoneA, name: zoneA },
      { id: zoneB, name: zoneB },
    ],
  };
}

// 1. 连通分量 + 排序：两个集群（三角形 3 节点 / 二元组 2 节点），按冲突数降序
let clusters = buildClusters([
  conflict('conflict-1', 'a', 'b'),
  conflict('conflict-2', 'b', 'c'),
  conflict('conflict-3', 'a', 'c'),
  conflict('conflict-4', 'd', 'e'),
]);
assert.strictEqual(clusters.length, 2, '应形成两个至少含两个区域的集群');
assert.strictEqual(clusters[0].id, 'cluster-1', '排序后才赋 id');
assert.deepStrictEqual(clusters[0].zoneIds, ['a', 'b', 'c']);
assert.strictEqual(clusters[0].conflictCount, 3);
assert.deepStrictEqual(clusters[0].conflictIds, ['conflict-1', 'conflict-2', 'conflict-3']);
assert.deepStrictEqual(clusters[1].zoneIds, ['d', 'e']);
assert.strictEqual(clusters[1].conflictCount, 1);

// 2. 同冲突数时按最小区域 id 稳定排序
clusters = buildClusters([
  conflict('conflict-1', 'z', 'q'),
  conflict('conflict-2', 'a', 'b'),
]);
assert.deepStrictEqual(clusters.map((cl) => cl.zoneIds[0]), ['a', 'q']);

// 3. 类型计数（按边统计）与累计重叠天数
clusters = buildClusters([
  conflict('c1', 'a', 'b', 'spatial', 5),
  conflict('c2', 'b', 'c', 'resource', 12.5),
]);
const cl = clusters[0];
assert.deepStrictEqual(cl.conflictCountByType, { spatial: 1, resource: 1, both: 0 });
assert.strictEqual(cl.totalOverlapDays, 17.5);
assert.deepStrictEqual(cl.zones.map((z) => z.name), ['a', 'b', 'c']);

// 4. 同区域对多类型不产生重复边：边计数仍为 1，冲突归并到同一条边
clusters = buildClusters([
  conflict('c1', 'a', 'b', 'spatial', 3),
  conflict('c2', 'a', 'b', 'resource', 7),
]);
assert.strictEqual(clusters.length, 1);
assert.strictEqual(clusters[0].zoneIds.length, 2, '同一对区域不得形成重复边');
assert.strictEqual(clusters[0].conflictCount, 2, '两条冲突都要挂在该集群上');
assert.deepStrictEqual(clusters[0].conflictIds, ['c1', 'c2']);

// 4b. 同区域对同类型多条冲突：边类型计数只计一次，但冲突全部保留、天数累计
clusters = buildClusters([
  conflict('c1', 'a', 'b', 'spatial', 3),
  conflict('c2', 'a', 'b', 'spatial', 4),
]);
assert.strictEqual(clusters[0].zoneIds.length, 2);
assert.strictEqual(clusters[0].conflictCount, 2);
assert.deepStrictEqual(clusters[0].conflictCountByType, { spatial: 1, resource: 0, both: 0 });
assert.strictEqual(clusters[0].totalOverlapDays, 7);

// 5. Tarjan 关键区域：链式 a-b-c 中 b 为割点；二元组无割点；三角形无割点
clusters = buildClusters([
  conflict('c1', 'a', 'b'),
  conflict('c2', 'b', 'c'),
  conflict('c3', 'a', 'c'),
  conflict('c4', 'd', 'e'),
  conflict('c5', 'f', 'g'),
  conflict('c6', 'g', 'h'),
]);
const triangle = clusters.find((c) => c.zoneIds.includes('a'));
assert.deepStrictEqual(triangle.criticalZones, [], '三角形（环）没有割点');
const pair = clusters.find((c) => c.zoneIds.includes('d'));
assert.deepStrictEqual(pair.criticalZones, [], '单条边的两个端点都不是割点');
const chain = clusters.find((c) => c.zoneIds.includes('f'));
assert.deepStrictEqual(chain.criticalZones, ['g'], '链中间节点 g 为关键区域');

// 6. 星形：中心为割点（即使它恰好是 DFS 根）
clusters = buildClusters([
  conflict('c1', 'hub', 'l1'),
  conflict('c2', 'hub', 'l2'),
  conflict('c3', 'hub', 'l3'),
]);
assert.deepStrictEqual(clusters[0].criticalZones, ['hub']);

// 7. 无冲突时无集群
assert.deepStrictEqual(buildClusters([]), []);

// 8. 端到端：analyze() 输出带 clusters 字段，冲突与集群相互引用可对齐
const zones = [
  zone('A', 121.470, 31.228, '2026-10-01', '2026-11-30'), // 与 B、D 相交
  zone('B', 121.471, 31.2285, '2026-10-01', '2026-11-30'),
  zone('D', 121.4715, 31.229, '2026-10-01', '2026-11-30'),
  zone('F', 121.60, 31.40, '2026-10-01', '2026-11-30'),   // 远离主群，孤立 → 不入集群
  zone('G', 121.601, 31.401, '2026-10-01', '2026-11-30'), // 与 F 成对
];
const result = analyze(zones);
assert.ok(result.clusterCount === result.clusters.length);
assert.ok(result.clusters.length >= 1);
// 每个集群引用的冲突都存在，且每条边的两个区域都在集群内
for (const c of result.clusters) {
  assert.ok(c.zoneIds.length >= 2);
  const zoneSet = new Set(c.zoneIds);
  for (const cid of c.conflictIds) {
    const conflictRow = result.conflicts.find((x) => x.id === cid);
    assert.ok(conflictRow, `集群引用的冲突 ${cid} 必须存在`);
    conflictRow.zones.forEach((z) => assert.ok(zoneSet.has(z.id)));
  }
  // 类型计数按边统计，故各类之和等于该集群的边数，不超过冲突数
  const typeSum = c.conflictCountByType.spatial + c.conflictCountByType.resource + c.conflictCountByType.both;
  assert.ok(typeSum <= c.conflictCount);
}
// 排序断言：冲突数降序
for (let i = 1; i < result.clusters.length; i++) {
  assert.ok(result.clusters[i - 1].conflictCount >= result.clusters[i].conflictCount);
}
// 链式/星形结构在真实 analyze 中也应被 Tarjan 识别：构造一条长链
const chainZones = [];
for (let i = 0; i < 5; i++) {
  chainZones.push(zone(`n${i}`, 121.0 + i * 0.0015, 31.0, '2026-10-01', '2026-11-30'));
}
const chainResult = analyze(chainZones);
assert.strictEqual(chainResult.clusters.length, 1);
assert.deepStrictEqual(
  chainResult.clusters[0].criticalZones,
  ['n1', 'n2', 'n3'],
  '5 节点路径的内部节点均为关键区域'
);

console.log('✅ 集群测试全部通过');
