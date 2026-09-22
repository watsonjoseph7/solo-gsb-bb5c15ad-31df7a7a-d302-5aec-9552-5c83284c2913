'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ZONES_FILE = path.join(DATA_DIR, 'zones.json');
const ANALYSES_FILE = path.join(DATA_DIR, 'analyses.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // 原子替换，避免写一半损坏
}

// ---- 区域（zones） ----

function listZones() {
  return readJson(ZONES_FILE, []);
}

function saveZones(zones) {
  writeJson(ZONES_FILE, zones);
}

function addZones(newZones) {
  const zones = listZones();
  zones.push(...newZones);
  saveZones(zones);
  return zones;
}

function deleteZone(id) {
  const zones = listZones();
  const next = zones.filter((z) => z.id !== id);
  saveZones(next);
  return zones.length !== next.length;
}

function clearZones() {
  saveZones([]);
}

// ---- 已保存的分析 ----

function listAnalyses() {
  return readJson(ANALYSES_FILE, []);
}

function getAnalysis(id) {
  return listAnalyses().find((a) => a.id === id) || null;
}

function saveAnalysis(record) {
  const analyses = listAnalyses();
  analyses.push(record);
  writeJson(ANALYSES_FILE, analyses);
  return record;
}

function deleteAnalysis(id) {
  const analyses = listAnalyses();
  const next = analyses.filter((a) => a.id !== id);
  writeJson(ANALYSES_FILE, next);
  return analyses.length !== next.length;
}

module.exports = {
  listZones,
  addZones,
  deleteZone,
  clearZones,
  listAnalyses,
  getAnalysis,
  saveAnalysis,
  deleteAnalysis,
};
