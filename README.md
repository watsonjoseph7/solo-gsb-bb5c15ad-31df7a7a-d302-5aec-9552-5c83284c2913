# 临时施工区域冲突分析台

一个 Node.js/Express Web 应用：导入带生效起止时间与资源占用的 GeoJSON 多边形施工区域，基于 [polygon-clipping](https://www.npmjs.com/package/polygon-clipping) 计算**同一时段内真实相交**的区域（空间冲突），并检测**同一时段占用同一资源**的区域（资源冲突）；两者同时满足时合并为一条记录并标注冲突类型、共享资源与重叠时段。结果按重叠面积降序输出，支持按冲突类型筛选，并自动生成可行的错峰/资源调配建议。每次分析后还会生成**冲突协调集群**：以区域为节点、冲突为无向边求连通分量，并用 Tarjan 算法识别移除后会拆分集群的关键区域。支持图层筛选、分析结果保存与 GeoJSON 报告导出，并可对任意两条已保存分析按区域对做新增/已解决/持续及属性变化的对比。

## 功能

- **质量预检 + 规范化（导入前置，独立流程）**：导入前逐要素检查环闭合、顶点数量、自相交、时间字段与资源字段；问题分**错误（不可导入）**与**警告（可自动规范化）**两级，每条带 [JSONPath](https://datatracker.ietf.org/wg/jsonpath/) 定位（如 `$.features[0].geometry.coordinates[0][3]`）。可修复问题（未闭合环、多余闭合点/重复顶点、资源分隔字符串、资源重复/空白、非标准日期、时间别名键、缺名称/图层）生成**规范化预览**，用户在预检结果页勾选确认后才写入区域库；支持「只导入通过项」与下载规范化 GeoJSON。提交接口在服务端再次复检，绕过前端无法写入脏数据
- **GeoJSON 导入**：支持 `FeatureCollection` / 单个 `Feature`，文件上传或文本粘贴；要素需带 `properties.start` / `properties.end`（ISO 日期），可选 `properties.resources`（字符串数组，如 `["塔吊", "挖掘机"]`）
- **空间冲突检测**：先判断时间窗口重叠，再用 polygon-clipping 对多边形做真实求交（支持 Polygon / MultiPolygon、带孔多边形），面积按局部等距投影计算（m²/公顷）
- **共享资源冲突检测**：时间重叠且 `resources` 存在交集即判定资源冲突；与空间冲突同时成立时合并为一条 `both` 记录，避免重复计数
- **冲突协调集群**：每次分析后，以区域为节点、冲突为无向边（同一对区域即使存在多类型冲突也只产生一条边），按连通分量生成仅含两个及以上区域的集群；用 **Tarjan 割点算法**识别关键区域（移除后集群会分裂）。每个集群返回区域/冲突 ID、冲突类型计数、累计重叠天数与关键区域列表，集群按冲突数降序、最小区域 ID 稳定排序
- **结果筛选与建议**：按冲突类型（空间 / 资源 / 空间+资源）筛选结果列表；点击集群卡片可联动过滤冲突列表与地图，关键区域在地图上以金色虚线 + 菱形标记独立呈现，可一键恢复全量视图；每处冲突给出"顺延 / 提前 / 工序穿插"建议，涉及共享资源时额外给出"资源错峰 / 分时复用 / 增配资源"建议（含具体调整日期与天数）
- **分析对比**：选择任意两条已保存分析，服务端**按区域对（zone pair）匹配冲突**（不依赖 `conflict-N` 编号——编号会随冲突增减与面积排序漂移），输出四类结果：**新增**（基线无、对照有）、**已解决**（基线有、对照无）、**持续且属性变化**、**持续且属性未变**；属性变化逐字段标注冲突类型、重叠起止/天数、共享资源（新增/移除的资源名），并保留两侧完整冲突详情。要求两条分析基于**同一区域集合**（参与分析的区域随结果保存为 `zoneSummaries`），新增/删除区域、重新导入（uuid 变化）或筛选区域不同都会以可理解的错误信息拒绝并列出差异区域
- **图层筛选**：按 `properties.layer` 勾选参与分析的图层，可限定分析时段（重叠期自动按时段裁剪）
- **地图可视化**：Leaflet 地图展示各区域（按图层着色）与按冲突类型着色的相交区域，点击结果可定位（纯资源冲突无相交几何，不上图）
- **保存与导出**：分析结果可命名保存（JSON 文件持久化，含集群摘要），一键导出带元数据、集群摘要、冲突类型、共享资源与建议的 GeoJSON 报告

## 快速开始

### 方式一：Docker Compose（推荐，一条命令）

```bash
docker compose up -d --build
```

启动后浏览器访问 **http://localhost:3000** 即可使用。停止服务：`docker compose down`（数据保存在命名卷 `app-data` 中）。

### 方式二：本地 Node.js（≥ 18）

```bash
npm install
npm start
```

启动后同样访问 **http://localhost:3000** 。

## 操作说明

1. 点击「**加载示例**」→「**质量预检**」→ 在结果页确认「**导入选中项**」（点击「加载问题示例」可体验预检对未闭合环、自相交、顶点不足、日期/资源问题的分级拦截与自动修复）
2. 按需勾选图层、限定分析时段，点击「**运行冲突分析**」
3. 地图与「冲突结果」列出全部冲突（按重叠面积降序），可用顶部下拉按冲突类型筛选
4. 在「**冲突协调集群**」区查看集群卡片：卡片展示区域构成、空间/资源/两者冲突的边计数、累计重叠天数与关键区域数量
   - **点击卡片**：冲突列表仅显示该集群的冲突，地图聚焦集群范围；集群外区域淡出，集群内区域加粗，**关键区域以金色虚线描边 + ◆ 菱形标记**独立呈现
   - **再次点击同一卡片**或点击右上角「**恢复全量视图**」：取消过滤
5. 在「已保存分析」输入名称后点「**保存当前分析**」，之后可随时「查看」复现（含集群选择视图所需的全部摘要）或「导出」GeoJSON 报告
6. 在「**分析对比**」分别选择基线与对照两条已保存分析（默认按保存时间自动选择最早/最晚两条），点击「**开始对比**」：结果区以分类页签展示新增 / 已解决 / 持续（可单独筛出属性变化）数量与明细；持续冲突逐条列出冲突类型、重叠起止/天数、共享资源的前后差异，展开可见两侧完整冲突详情。若两条分析的区域集合不同，会在对比面板直接提示差异区域名称，需基于同一批区域重新保存后再对比

### 导入流程（预检 → 确认 → 写入）

1. 选择/粘贴 GeoJSON 后点击「**质量预检**」（只检不写，区域库不变）
2. 预检结果页展示汇总（通过数 / 错误数 / 警告数 / 自动修复数）与逐要素明细：
   - **错误（红）**：自相交、顶点不足、坐标非法、时间缺失/非法/起止倒置、几何类型不支持等 → 不可勾选导入，需人工修复源数据
   - **警告（黄，可自动规范化）**：未闭合环、多余闭合点/连续重复点、资源分隔字符串、资源重复/空白、非标准日期、时间别名键、缺名称/图层 → 已在预览中修复，可直接导入
   - 每条问题标注 JSONPath，可据此回到源文件定位
3. 勾选要导入的通过项（错误项自动禁用），点击「**导入选中项**」（服务端复检后才写入），或「**下载规范化 GeoJSON**」存档/二次处理

### 运行测试

```bash
npm test
```

## 输入数据格式

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": {
        "name": "基坑开挖区 A",
        "layer": "土建",
        "start": "2026-10-01",
        "end": "2026-11-15",
        "resources": ["塔吊", "混凝土泵车"]
      },
      "geometry": { "type": "Polygon", "coordinates": [[[121.47, 31.228], [121.474, 31.228], [121.474, 31.231], [121.47, 31.231], [121.47, 31.228]]] }
    }
  ]
}
```

- `name`：区域名称（缺省自动命名）
- `layer`：图层名（缺省为「默认图层」），用于筛选与地图着色
- `start` / `end`：生效起止时间（也兼容 `startTime`/`endTime`、`from`/`to`），结束必须晚于开始
- `resources`：占用资源清单，**字符串数组**（如 `["塔吊", "挖掘机"]`）；也兼容逗号/顿号分隔的单个字符串，缺省为 `[]`。导入时自动去空白、去重
- 几何仅支持 `Polygon` / `MultiPolygon`

## 冲突类型与输出字段

分析结果中每条冲突包含：

| 字段 | 说明 |
| --- | --- |
| `conflictType` | `spatial`（时间重叠+空间相交）/ `resource`（时间重叠+共享资源）/ `both`（两者同时满足，合并为一条） |
| `sharedResources` | 双方共同占用的资源数组（纯空间冲突为 `[]`） |
| `overlapStart` / `overlapEnd` / `overlapDays` | 重叠时段（按分析时段裁剪后） |
| `areaM2` / `areaHectares` / `geometry` | 相交面积与相交几何；纯资源冲突无空间相交，`geometry` 为 `null`、面积为 0 |
| `suggestions` | 错峰建议列表（含资源错峰/分时复用/增配资源，每条含 `type` 与 `text`） |

汇总字段 `conflictCountByType` 给出三种类型各自的数量；保存的分析与导出的 GeoJSON 报告均完整保留以上字段（导出时纯资源冲突以 `geometry: null` 的 Feature 表示，保证冲突清单不丢失）。分析结果还包含 `zoneSummaries`：参与本次分析的全部区域摘要 `{id, name, layer}`（按 id 升序，含无冲突区域），供分析对比核对区域集合。

## 冲突协调集群输出字段

分析结果顶层新增 `clusterCount` 与 `clusters` 数组，每个集群对象包含：

| 字段 | 说明 |
| --- | --- |
| `id` | 集群编号 `cluster-1…`（先排序后赋值） |
| `zoneIds` / `zones` | 集群内全部区域 ID（升序）/ 区域摘要 `{id, name}` |
| `conflictIds` | 集群内全部冲突 ID（按冲突编号升序） |
| `conflictCount` | 集群冲突（边关联冲突）总数 |
| `conflictCountByType` | **按无向边统计**的类型计数 `{spatial, resource, both}`：同一对区域若同时挂多种类型冲突，边类型在各类各计一次，故计数之和可能小于冲突数 |
| `totalOverlapDays` | 集群内各边冲突重叠天数之和（保留一位小数） |
| `criticalZones` | Tarjan 割点算法识别的关键区域 ID（移除任一节点都会使集群分裂）；二元边、纯环结构为空 |

构图规则：区域为节点、冲突为无向边，**同一对区域不会因冲突类型形成重复边**（同对区域的多条冲突归并到同一条边，冲突 ID 全部保留）；按连通分量取集群，仅保留至少含两个区域的分量（孤立区域不入集群）。集群排序：冲突数降序，冲突数相同时按最小区域 ID 升序，保证结果稳定。

导出的 GeoJSON 中：`metadata.clusterCount` 与 `metadata.clusters` 保留完整集群摘要；每个冲突 Feature 的 `properties.clusterId` 标注其所属集群（不属于任何集群时为 `null`）。

## 分析对比输出字段

`POST /api/analyses/compare` 按**区域对**（两侧区域 id 排序后拼接的稳定键，与冲突编号无关）匹配两侧冲突，返回：

| 字段 | 说明 |
| --- | --- |
| `baseline` / `comparison` | 两条分析的 `{id, name, savedAt, params, generatedAt}` 摘要 |
| `zoneCount` | 参与对比的区域数（两条分析区域集合必须一致） |
| `summary` | `{added, resolved, persistent, persistentChanged, persistentUnchanged, beforeConflictCount, afterConflictCount}` |
| `added[]` | 新增冲突：`{pairKey, zones, conflict}`（`conflict` 为对照侧完整冲突记录） |
| `resolved[]` | 已解决冲突：`{pairKey, zones, conflict}`（`conflict` 为基线侧完整冲突记录） |
| `persistent[]` | 持续冲突：`{pairKey, zones, changed, changes[], before, after, beforeAreaM2, afterAreaM2}` |

`persistent[].changes[]` 逐项给出属性差异，每项含 `field` / `label` 与前后值：

| `field` | 触发条件 | 前后值 |
| --- | --- | --- |
| `conflictType` | 冲突类型变化（如工期/资源调整使 `spatial` ↔ `both` ↔ `resource` 转换） | `before` / `after` 为类型代码 |
| `overlap` | 重叠起止时间或重叠天数变化 | `{start, end, days}` 前后对照 |
| `sharedResources` | 共享资源集合变化 | `before[]` / `after[]` 全集 + `added[]` / `removed[]` 差异 |

各类条目内部按冲突面积（取两侧较大值）、重叠天数降序排列；持续冲突中有属性变化的排在前面。区域集合一致性依据分析结果中的 `zoneSummaries`（`analyze()` 输出的参与分析全部区域 `{id, name, layer}` 列表，按 id 升序）判定；旧版本保存、不含该字段的结果自动从冲突记录中回退恢复区域集合。

### 对比错误响应

| 场景 | 状态码 | 说明 |
| --- | --- | --- |
| 未传 / 传空 `baselineId`、`comparisonId` | 400 | `请选择两条已保存分析…` |
| 两条 id 相同 | 400 | `请选择两条不同的已保存分析进行对比` |
| 任一分析不存在（或已删除） | 404 | 指出是基线还是对照、附带其 id |
| 分析结果数据损坏（无 `conflicts` 列表） | 400 | 指出是哪条分析数据不完整 |
| 区域集合不同 | 422 | `code: "ZONE_SET_MISMATCH"`，`zonesOnlyInBefore` / `zonesOnlyInAfter` 给出仅单侧存在的区域 id，错误信息中附带区域名称（各列前 5 个） |

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/zones` | 列出全部区域（含 `resources`） |
| POST | `/api/zones/precheck` | **质量预检（只检不写）**：返回逐要素 error/warning（含 JSONPath）与规范化预览 |
| POST | `/api/zones/commit` | **确认后写入**：body `{geojson, indexes?}`；服务端重新预检，含错误要素返回 422 整批拒绝 |
| POST | `/api/zones/import` | 直接导入（兼容接口，脚本/CLI 用；网页端已改走预检流程） |
| DELETE | `/api/zones/:id` | 删除区域 |
| DELETE | `/api/zones` | 清空区域 |
| GET | `/api/layers` | 图层列表 |
| POST | `/api/analyze` | 运行分析，body：`{layers?, start?, end?}`；结果含 `clusters` / `clusterCount` |
| POST | `/api/analyses` | 保存分析，body：`{name?, params?, result}`（集群摘要随 result 一并持久化） |
| GET | `/api/analyses` | 已保存分析列表（含 `conflictCountByType`、`clusterCount`） |
| GET | `/api/analyses/:id` | 分析详情 |
| DELETE | `/api/analyses/:id` | 删除分析 |
| POST | `/api/analyses/compare` | **分析对比**：body `{baselineId, comparisonId}`；按区域对匹配冲突，返回新增/已解决/持续（含逐字段属性变化）。同一条分析返回 400、分析不存在返回 404、区域集合不同返回 422（错误信息含仅单侧存在的区域） |
| GET | `/api/analyses/:id/export` | 导出 GeoJSON 报告（附件下载；`metadata.clusters` 含集群摘要，每个 Feature 的 `properties.clusterId` 关联集群） |

### 预检检查项与分级

| 检查项 | 级别 | 代码 | 可否自动修复 |
| --- | --- | --- | --- |
| 几何类型不是 Polygon/MultiPolygon、geometry/properties 缺失 | 错误 | `geometry-type-unsupported` 等 | 否 |
| 环顶点不是数值坐标（NaN/空值）、环/面结构非法 | 错误 | `ring-invalid-position` / `polygon-invalid` | 否 |
| 线性环不足 4 个位置 / 有效顶点不足 3 个 | 错误 | `ring-too-few-vertices` / `ring-degenerate` | 否 |
| 环自相交（非相邻边交叉/接触、非相邻顶点重合，如蝴蝶结） | 错误 | `ring-self-intersection` | 否（请人工修复） |
| 时间缺失 / 无法解析 / 结束不晚于开始 | 错误 | `time-missing` / `time-invalid` / `time-range` | 否 |
| 环未闭合 | 警告 | `ring-not-closed` | ✅ 自动补点闭合 |
| 多余闭合点、连续重复顶点 | 警告 | `ring-duplicate-closure` / `ring-duplicate-vertex` | ✅ 去重 |
| 坐标超出经纬度有效范围 | 警告 | `ring-coordinate-out-of-range` | 否（提示确认坐标系） |
| 时间使用别名键（`startTime`/`from` 等）、非标准日期格式（`2026/10/01`、`2026年10月1日`、时间戳等） | 警告 | `time-alias-key` / `time-format` | ✅ 统一为 `start`/`end` + ISO 8601(UTC) |
| 资源为分隔字符串、重复、带空白、含非文本条目、类型错误 | 警告 | `resource-string-split` / `resource-duplicate` 等 | ✅ 拆分、去重、去空白、剔除 |
| 缺 `name` / `layer` | 警告 | `name-missing` / `layer-missing` | ✅ 自动命名 / 归入默认图层 |

规范化动作：环统一为显式闭合且无重复点（保留第三维高程）；`start`/`end` 统一为 ISO 8601（UTC），移除时间别名键；`resources` 统一为去重去空白的字符串数组。`YYYY-MM-DD` 与带时区 ISO 8601 视为标准写法，不会产生警告。

## 项目结构

```
├── server.js            # Express 入口与 API 路由（precheck / commit / import / analyze）
├── src/
│   ├── analysis.js      # 时空/资源冲突检测与错峰建议生成
│   ├── compare.js       # 分析对比：按区域对匹配 + 新增/已解决/持续/属性变化分类
│   ├── clusters.js      # 冲突协调集群：无向图连通分量 + Tarjan 割点（关键区域）
│   ├── quality.js       # 导入质量预检与规范化（环/顶点/自相交/时间/资源，JSONPath 定位）
│   ├── geo.js           # 局部投影与面积计算
│   └── store.js         # JSON 文件持久化（区域 / 已保存分析）
├── public/              # 前端（Leaflet 地图 + 集群卡片 + 分析面板 + 对比面板 + 预检结果页）
│   ├── sample.geojson   # 示例数据（含 resources 字段）
│   └── sample-issues.geojson # 问题示例（各类错误/警告）
├── test/analysis.test.js
├── test/clusters.test.js
├── test/quality.test.js
├── test/compare.test.js
├── Dockerfile
└── docker-compose.yml
```

## 说明

- 数据持久化在 `DATA_DIR`（默认 `./data`，容器内 `/app/data`，Compose 已挂载命名卷）
- 面积采用以相交区域质心为原点的局部等距圆柱投影近似，适用于施工场地尺度（公里级）的冲突评估
- 仅边界相接（零面积接触）不计为空间冲突
- 资源冲突只要求"时间重叠 + 资源同名"，与空间位置无关；资源名比较为精确匹配（导入时已做去空白处理），建议统一命名口径（如统一用「塔吊」而非「塔吊/塔式起重机」混用）
