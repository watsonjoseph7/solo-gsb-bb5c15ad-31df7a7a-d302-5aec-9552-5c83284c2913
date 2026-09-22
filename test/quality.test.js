'use strict';

const assert = require('assert');
const { precheck, inspectRing, parseTimeLoose, segmentsIntersect } = require('../src/quality');

function closedSquare(lon1, lat1, lon2, lat2) {
  return [[[lon1, lat1], [lon2, lat1], [lon2, lat2], [lon1, lat2], [lon1, lat1]]];
}
function feature(props, geometry) {
  return {
    type: 'Feature',
    properties: { name: '测试', layer: '土建', start: '2026-10-01', end: '2026-11-01', ...props },
    geometry: geometry || { type: 'Polygon', coordinates: closedSquare(0, 0, 1, 1) },
  };
}
function codes(report, severity) {
  return report[severity].map((i) => i.code);
}

// 1. 规范要素：无错误无警告，原样通过
let r = precheck({ type: 'FeatureCollection', features: [feature()] });
assert.strictEqual(r.summary.passed, 1);
assert.strictEqual(r.summary.blocked, 0);
assert.strictEqual(r.summary.clean, 1);
assert.strictEqual(r.reports[0].status, 'pass');
assert.ok(r.reports[0].normalized);
assert.deepStrictEqual(
  r.reports[0].normalized.geometry.coordinates,
  closedSquare(0, 0, 1, 1),
  '规范环规范化后应保持一致'
);

// 2. 未闭合环 → warning，自动补点闭合
r = precheck(feature(undefined, {
  type: 'Polygon',
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]], // 缺末点
}));
assert.strictEqual(r.summary.blocked, 0);
assert.deepStrictEqual(codes(r.reports[0], 'warnings'), ['ring-not-closed']);
assert.strictEqual(r.reports[0].warnings[0].fixed, true);
assert.strictEqual(r.reports[0].normalized.geometry.coordinates[0].length, 5, '应补回闭合点');
assert.deepStrictEqual(
  r.reports[0].normalized.geometry.coordinates[0][4], [0, 0]
);

// 3. 多余闭合点 + 连续重复顶点 → warning，已去除
r = precheck(feature(undefined, {
  type: 'Polygon',
  coordinates: [[[0, 0], [0, 0], [1, 0], [1, 1], [0, 1], [0, 0], [0, 0]]],
}));
assert.strictEqual(r.summary.blocked, 0);
assert.ok(codes(r.reports[0], 'warnings').includes('ring-duplicate-closure'));
assert.ok(codes(r.reports[0], 'warnings').includes('ring-duplicate-vertex'));
assert.strictEqual(r.reports[0].normalized.geometry.coordinates[0].length, 5);

// 4. 顶点不足 → error，无规范化预览
r = precheck(feature(undefined, {
  type: 'Polygon',
  coordinates: [[[0, 0], [1, 1], [0, 0]]],
}));
assert.strictEqual(r.summary.blocked, 1);
assert.ok(codes(r.reports[0], 'errors').includes('ring-too-few-vertices'));
assert.strictEqual(r.reports[0].normalized, null);

// 5. 自相交（蝴蝶结）→ error
r = precheck(feature(undefined, {
  type: 'Polygon',
  coordinates: [[[0, 0], [2, 2], [2, 0], [0, 2], [0, 0]]],
}));
assert.ok(codes(r.reports[0], 'errors').includes('ring-self-intersection'));
assert.strictEqual(r.summary.passed, 0);

// 6. 自相交检测原语：交叉边相交、正常相邻边不相交
assert.strictEqual(segmentsIntersect([0, 0], [2, 2], [0, 2], [2, 0]), true);
assert.strictEqual(segmentsIntersect([0, 0], [1, 0], [1, 0], [1, 1]), true, '端点接触也算相交（非相邻时为自交）');
assert.strictEqual(segmentsIntersect([0, 0], [1, 0], [2, 0], [3, 0]), false);

// 凹多边形（边不交叉）不应误报
const concave = [[0, 0], [3, 0], [3, 3], [2, 1], [1, 3], [0, 3], [0, 0]];
const { ok: concaveOk } = inspectRing(concave, '$.x', []);
assert.strictEqual(concaveOk, true, '合法凹多边形不应被判为自相交');

// 7. 时间字段：缺失 / 非法 / 起止倒置
assert.ok(codes(precheck(feature({ start: undefined, end: undefined })).reports[0], 'errors').includes('time-missing'));
assert.ok(codes(precheck(feature({ start: 'nope' })).reports[0], 'errors').includes('time-invalid'));
assert.ok(codes(precheck(feature({ start: '2026-11-01', end: '2026-10-01' })).reports[0], 'errors').includes('time-range'));

// 8. 时间别名键 + 非标准格式 → warning，统一为标准字段和 ISO
r = precheck(feature({ start: undefined, end: undefined, startTime: '2026/10/01', to: '2026.11.01' }));
assert.strictEqual(r.summary.blocked, 0);
const w = codes(r.reports[0], 'warnings');
assert.ok(w.includes('time-alias-key'));
assert.ok(w.includes('time-format'));
const np = r.reports[0].normalized.properties;
assert.strictEqual(np.start, '2026-10-01T00:00:00.000Z');
assert.strictEqual(np.end, '2026-11-01T00:00:00.000Z');
assert.strictEqual(np.startTime, undefined, '别名应被移除');
assert.strictEqual(np.to, undefined);
assert.strictEqual(np.start !== undefined && np.end !== undefined, true);

// 9. 中文日期可解析
assert.strictEqual(parseTimeLoose('2026年10月1日'), Date.parse('2026/10/01'));
assert.strictEqual(parseTimeLoose('2026.10.01'), Date.parse('2026/10/01'));
assert.strictEqual(parseTimeLoose('garbage'), null);

// 10. 资源：分隔字符串拆分 + 去重 + 非法条目剔除 + 空白裁剪
r = precheck(feature({ resources: '塔吊，挖掘机、塔吊' }));
assert.ok(codes(r.reports[0], 'warnings').includes('resource-string-split'));
assert.ok(codes(r.reports[0], 'warnings').includes('resource-duplicate'));
assert.deepStrictEqual(r.reports[0].normalized.properties.resources, ['塔吊', '挖掘机']);

r = precheck(feature({ resources: [' 泵车 ', true, 123, '泵车'] }));
assert.ok(codes(r.reports[0], 'warnings').includes('resource-entry-invalid'));
assert.ok(codes(r.reports[0], 'warnings').includes('resource-entry-trim'));
assert.ok(codes(r.reports[0], 'warnings').includes('resource-duplicate'));
assert.deepStrictEqual(r.reports[0].normalized.properties.resources, ['泵车', '123']);

r = precheck(feature({ resources: 99 }));
assert.ok(codes(r.reports[0], 'warnings').includes('resource-type-invalid'));
assert.deepStrictEqual(r.reports[0].normalized.properties.resources, []);

// 11. 缺少 name / layer → warning 自动补全
r = precheck(feature({ name: undefined, layer: undefined }));
assert.ok(codes(r.reports[0], 'warnings').includes('name-missing'));
assert.ok(codes(r.reports[0], 'warnings').includes('layer-missing'));
assert.strictEqual(r.reports[0].normalized.properties.name, '区域 1');
assert.strictEqual(r.reports[0].normalized.properties.layer, '默认图层');

// 12. JSONPath 定位：容器路径规则
r = precheck({ type: 'FeatureCollection', features: [feature()] });
assert.strictEqual(r.reports[0].sourcePath, '$.features[0]');
r = precheck([feature()]);
assert.strictEqual(r.reports[0].sourcePath, '$[0]');
r = precheck(feature());
assert.strictEqual(r.reports[0].sourcePath, '$');
// 具体问题路径
r = precheck({ type: 'FeatureCollection', features: [feature(undefined, { type: 'Point', coordinates: [0, 0] })] });
const typeErr = r.reports[0].errors.find((e) => e.code === 'geometry-type-unsupported');
assert.strictEqual(typeErr.path, '$.features[0].geometry.type');
r = precheck({ type: 'FeatureCollection', features: [feature({ start: 'bad' })] });
const timeErr = r.reports[0].errors.find((e) => e.code === 'time-invalid');
assert.strictEqual(timeErr.path, '$.features[0].properties.start');

// 13. MultiPolygon 逐面逐环检查
r = precheck(feature(undefined, {
  type: 'MultiPolygon',
  coordinates: [
    closedSquare(0, 0, 1, 1),
    [[[5, 5], [6, 5], [6, 6], [5, 6]]], // 第二面未闭合四边形
  ],
}));
assert.strictEqual(r.summary.blocked, 0, '未闭合环会被自动修复，不应阻断');
assert.ok(codes(r.reports[0], 'warnings').includes('ring-not-closed'));
assert.strictEqual(r.reports[0].normalized.geometry.type, 'MultiPolygon');
assert.strictEqual(r.reports[0].normalized.geometry.coordinates[1][0].length, 5, '未闭合环补点后 5 个位置');

r = precheck(feature(undefined, {
  type: 'MultiPolygon',
  coordinates: [
    closedSquare(0, 0, 1, 1),
    [[[5, 5], [7, 7], [7, 5], [5, 7], [5, 5]]], // 自相交
  ],
}));
assert.ok(codes(r.reports[0], 'errors').includes('ring-self-intersection'));
assert.strictEqual(r.reports[0].normalized, null);

// 14. 带孔洞多边形（外环 + 内环）可通过
r = precheck(feature(undefined, {
  type: 'Polygon',
  coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]],
  ],
}));
assert.strictEqual(r.summary.blocked, 0);
assert.strictEqual(r.reports[0].normalized.geometry.coordinates.length, 2);

// 15. 汇总统计与 normalized 集合只含通过项
r = precheck({
  type: 'FeatureCollection',
  features: [
    feature(),                                   // pass
    feature({ start: 'bad' }),                   // error
    feature({ resources: '塔吊，塔吊' }),        // warning
  ],
});
assert.strictEqual(r.summary.total, 3);
assert.strictEqual(r.summary.passed, 2);
assert.strictEqual(r.summary.blocked, 1);
assert.strictEqual(r.summary.clean, 1);
assert.strictEqual(r.summary.withWarnings, 1);
assert.strictEqual(r.normalized.features.length, 2);
assert.strictEqual(r.normalized.type, 'FeatureCollection');

// 16. 非要素 / 结构错误
assert.throws(() => precheck({ type: 'FeatureCollection', features: [] }), /没有任何要素/);
assert.throws(() => precheck({ type: 'Bogus' }), /FeatureCollection/);
r = precheck({ type: 'FeatureCollection', features: [{ foo: 'bar' }] });
assert.strictEqual(r.reports[0].status, 'error');

// 17. 规范化结果可被分析侧 normalizeZone 安全消费（端到端数据契约）
const { normalizeZone } = require('../src/analysis');
r = precheck(feature({ resources: '塔吊，塔吊', startTime: undefined, start: '2026/10/01' }));
const z = normalizeZone(r.normalized.features[0], 0);
assert.strictEqual(z.start, '2026-10-01T00:00:00.000Z');
assert.deepStrictEqual(z.resources, ['塔吊']);
assert.ok(z.geometry.type === 'Polygon');

console.log('✅ 质量预检测试全部通过');
