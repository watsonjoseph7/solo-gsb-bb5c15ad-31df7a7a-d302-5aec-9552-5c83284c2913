'use strict';

/**
 * 地理计算辅助：把经纬度投影到局部平面坐标（等距圆柱近似），
 * 用于计算多边形面积（平方米）。对施工场地级别的范围足够精确。
 */

const METERS_PER_DEG_LAT = 111320; // 纬度 1 度约 111.32 km

function makeProjector(refLon, refLat) {
  const cosLat = Math.cos((refLat * Math.PI) / 180);
  return function project([lon, lat]) {
    return [
      (lon - refLon) * cosLat * METERS_PER_DEG_LAT,
      (lat - refLat) * METERS_PER_DEG_LAT,
    ];
  };
}

/** 鞋带公式求单个环的面积（已投影坐标） */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

/**
 * 计算 MultiPolygon（polygon-clipping 输出格式）的面积，单位 m²。
 * 外环取正、孔洞取负。
 */
function multiPolygonArea(multiPolygon, refLon, refLat) {
  const project = makeProjector(refLon, refLat);
  let total = 0;
  for (const polygon of multiPolygon) {
    polygon.forEach((ring, idx) => {
      const projected = ring.map(project);
      const area = ringArea(projected);
      total += idx === 0 ? Math.abs(area) : -Math.abs(area);
    });
  }
  return Math.max(0, total);
}

/** 从若干几何中估算参考点（用于投影原点） */
function centroidOfCoords(coords) {
  let sumLon = 0;
  let sumLat = 0;
  let n = 0;
  (function walk(c) {
    if (typeof c[0] === 'number') {
      sumLon += c[0];
      sumLat += c[1];
      n += 1;
    } else {
      c.forEach(walk);
    }
  })(coords);
  return n ? [sumLon / n, sumLat / n] : [0, 0];
}

module.exports = { multiPolygonArea, centroidOfCoords };
