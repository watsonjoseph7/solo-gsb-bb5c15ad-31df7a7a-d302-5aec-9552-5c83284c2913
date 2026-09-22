'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { analyze, normalizeZone } = require('./src/analysis');
const { precheck, extractFeatures } = require('./src/quality');
const { compareAnalyses, ComparisonError } = require('./src/compare');
const store = require('./src/store');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- 健康检查 ----
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ---- 区域管理 ----

// 列出全部区域
app.get('/api/zones', (req, res) => {
  res.json({ zones: store.listZones() });
});

// 导入 GeoJSON（FeatureCollection / 单个 Feature / 几何数组均可）
// 保留原有直接导入接口（CLI/脚本兼容）；网页端默认走下方 precheck → commit 两步流程
app.post('/api/zones/import', (req, res) => {
  try {
    const features = extractFeatures(req.body).features;
    const zones = features.map((f, i) => {
      const z = normalizeZone(f, i);
      z.id = crypto.randomUUID();
      z.importedAt = new Date().toISOString();
      return z;
    });
    store.addZones(zones);
    res.status(201).json({ imported: zones.length, zones });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- 质量预检与规范化（独立流程：只检不写，不改变区域库） ----

// 预检：逐要素检查环闭合 / 顶点数 / 自相交 / 时间 / 资源，
// 返回 error|warning 分级问题（带 JSONPath）与规范化预览
app.post('/api/zones/precheck', (req, res) => {
  try {
    res.json(precheck(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 确认提交：用户在预检结果页确认后才写入；服务端对提交内容重新预检，
// 含错误要素则整批拒绝（防止绕过前端写入脏数据）
app.post('/api/zones/commit', (req, res) => {
  try {
    const body = req.body;
    const geojson = body && body.geojson ? body.geojson : body;
    const indexes = body && Array.isArray(body.indexes) ? body.indexes : null;

    let { features } = extractFeatures(geojson);
    if (indexes) {
      const selected = indexes
        .filter((i) => Number.isInteger(i) && i >= 0 && i < features.length)
        .sort((a, b) => a - b)
        .map((i) => features[i]);
      if (selected.length === 0) {
        return res.status(400).json({ error: '没有选中任何可导入要素' });
      }
      features = selected;
    }

    // 服务端复检：规范化结果本身不应再有 error
    const result = precheck(features);
    if (result.summary.blocked > 0) {
      return res.status(422).json({
        error: `提交的要素中有 ${result.summary.blocked} 个未通过预检，写入已中止`,
        precheck: result,
      });
    }

    // 复检通过后，以规范化要素为唯一事实来源写入（索引顺序即要素顺序）
    const zones = result.normalized.features.map((f, i) => {
      const z = normalizeZone(f, i);
      z.id = crypto.randomUUID();
      z.importedAt = new Date().toISOString();
      return z;
    });
    store.addZones(zones);
    res.status(201).json({
      imported: zones.length,
      warningsFixed: result.summary.fixedWarningCount,
      zones,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 删除单个区域
app.delete('/api/zones/:id', (req, res) => {
  const removed = store.deleteZone(req.params.id);
  res.status(removed ? 204 : 404).end();
});

// 清空全部区域
app.delete('/api/zones', (req, res) => {
  store.clearZones();
  res.status(204).end();
});

// 图层列表
app.get('/api/layers', (req, res) => {
  const layers = [...new Set(store.listZones().map((z) => z.layer))].sort();
  res.json({ layers });
});

// ---- 冲突分析 ----

// 运行分析：body { layers?: string[], start?: string, end?: string }
app.post('/api/analyze', (req, res) => {
  const result = analyze(store.listZones(), req.body || {});
  res.json(result);
});

// ---- 已保存的分析 ----

// 保存一次分析结果
app.post('/api/analyses', (req, res) => {
  const { name, params, result } = req.body || {};
  if (!result || !Array.isArray(result.conflicts)) {
    return res.status(400).json({ error: '缺少有效的分析结果（result.conflicts）' });
  }
  const record = {
    id: crypto.randomUUID(),
    name: String(name || `分析 ${new Date().toLocaleString('zh-CN')}`),
    savedAt: new Date().toISOString(),
    params: params || result.params || {},
    result,
  };
  store.saveAnalysis(record);
  res.status(201).json(record);
});

// 列出已保存分析（不含大结果体，便于列表展示）
app.get('/api/analyses', (req, res) => {
  const list = store.listAnalyses().map(({ id, name, savedAt, params, result }) => ({
    id,
    name,
    savedAt,
    params,
    conflictCount: result.conflictCount,
    conflictCountByType: result.conflictCountByType || null,
    clusterCount: result.clusterCount || (Array.isArray(result.clusters) ? result.clusters.length : 0),
    totalConflictAreaM2: result.totalConflictAreaM2,
  }));
  res.json({ analyses: list });
});

// 获取单个分析详情
app.get('/api/analyses/:id', (req, res) => {
  const record = store.getAnalysis(req.params.id);
  if (!record) return res.status(404).json({ error: '分析不存在' });
  res.json(record);
});

// 删除已保存分析
app.delete('/api/analyses/:id', (req, res) => {
  const removed = store.deleteAnalysis(req.params.id);
  res.status(removed ? 204 : 404).end();
});

// 分析对比：选择两条已保存分析，服务端按区域对匹配冲突，
// 输出新增 / 已解决 / 持续（含属性变化）。区域集合不同或结果无效时给出可理解的错误
app.post('/api/analyses/compare', (req, res) => {
  const body = req.body || {};
  const baselineId = typeof body.baselineId === 'string' ? body.baselineId : null;
  const comparisonId = typeof body.comparisonId === 'string' ? body.comparisonId : null;
  if (!baselineId || !comparisonId) {
    return res.status(400).json({ error: '请选择两条已保存分析（baselineId / comparisonId）' });
  }

  const recordA = store.getAnalysis(baselineId);
  if (!recordA) {
    return res.status(404).json({ error: `基线分析不存在或已被删除（${baselineId}），请重新选择` });
  }
  const recordB = store.getAnalysis(comparisonId);
  if (!recordB) {
    return res.status(404).json({ error: `对照分析不存在或已被删除（${comparisonId}），请重新选择` });
  }

  try {
    res.json(compareAnalyses(recordA, recordB));
  } catch (err) {
    if (err instanceof ComparisonError) {
      return res.status(err.status || 400).json({
        error: err.message,
        code: err.code || 'COMPARISON_INVALID',
        zonesOnlyInBefore: err.zonesOnlyInBefore,
        zonesOnlyInAfter: err.zonesOnlyInAfter,
      });
    }
    return res.status(400).json({ error: err.message });
  }
});

// 导出 GeoJSON 报告（相交区域 + 冲突类型 + 共享资源 + 建议）
app.get('/api/analyses/:id/export', (req, res) => {
  const record = store.getAnalysis(req.params.id);
  if (!record) return res.status(404).json({ error: '分析不存在' });

  // 纯资源冲突无空间相交几何，导出为 null geometry 的 Feature 以保留完整冲突清单
  // 每个 Feature 通过 clusterId 关联所属冲突协调集群（不在集群中的冲突为 null）
  const clusterIndex = new Map();
  (record.result.clusters || []).forEach((cl) => {
    cl.conflictIds.forEach((cid) => clusterIndex.set(cid, cl.id));
  });

  const features = record.result.conflicts.map((c) => ({
    type: 'Feature',
    geometry: c.geometry || null,
    properties: {
      conflictId: c.id,
      clusterId: clusterIndex.get(c.id) || null,
      conflictType: c.conflictType,
      zones: c.zones.map((z) => z.name).join(' ∩ '),
      zoneDetails: c.zones,
      sharedResources: c.sharedResources || [],
      overlapStart: c.overlapStart,
      overlapEnd: c.overlapEnd,
      overlapDays: c.overlapDays,
      areaM2: c.areaM2,
      areaHectares: c.areaHectares,
      suggestions: c.suggestions.map((s) => s.text),
    },
  }));

  const report = {
    type: 'FeatureCollection',
    metadata: {
      title: record.name,
      exportedAt: new Date().toISOString(),
      generatedAt: record.result.generatedAt,
      params: record.params,
      conflictCount: record.result.conflictCount,
      conflictCountByType: record.result.conflictCountByType || null,
      clusterCount: record.result.clusters ? record.result.clusters.length : 0,
      // 集群摘要：区域/冲突 ID、类型计数、累计重叠天数、关键区域
      clusters: (record.result.clusters || []).map((cl) => ({
        id: cl.id,
        zoneIds: cl.zoneIds,
        zones: cl.zones,
        conflictIds: cl.conflictIds,
        conflictCount: cl.conflictCount,
        conflictCountByType: cl.conflictCountByType,
        totalOverlapDays: cl.totalOverlapDays,
        criticalZones: cl.criticalZones,
      })),
      totalConflictAreaM2: record.result.totalConflictAreaM2,
    },
    features,
  };

  const filename = `conflict-report-${record.id}.geojson`;
  res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(report, null, 2));
});

// SPA 兜底
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`施工区域冲突分析台已启动: http://localhost:${PORT}`);
});
