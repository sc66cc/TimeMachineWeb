# TimeMachineWeb · Deep Time Atlas

基于 GPlates 有限旋转模型和 CesiumJS 的球面板块重建与大规模点性能实验。在 Plate Model 中选择模型后，Web 复用 Unity 的 DPlanet `UserPlateModel` ByteStream 接口获取数据，在浏览器内解码、求解重建树并生成球面网格。本地 PALEOMAP 仅作为显式选择的演示数据，不作为后端读取失败时的隐式回退；PBDB 二进制仍用于 GPU 点运动实验。

## 本地运行

```bash
npm ci
(cd DPlanet/TypeScript && npm ci)
npm run dev
```

打开：

```text
http://127.0.0.1:5173/
```

Web 引用的生成 SDK 位于 `DPlanet/TypeScript`，因此干净环境需要安装上面两个目录的锁定依赖。开发模式默认连接本机 Server；未选择模型时显示空板块状态，可使用 Unity 原有账号登录后选择有权限的模型，或明确选择本地演示。

生产构建与预览（构建时显式指定已有 Server）：

```bash
VITE_TIMEMACHINE_SERVER_URL=http://127.0.0.1:5130 npm run build
npm run preview
```

预览默认地址为 `http://127.0.0.1:4173/`。Web 不要求为读取模型新增 Server 接口；V1 Server 不提供的 V2 云项目、版本目录和 ingest 能力会明确标为不可用，不能把“Server 已连接”等同于所有功能均可用。

Agent 可调用的前端动作接口、控件映射与未实现能力见
[Agent API](docs/agent-api.md)。古地形编辑器和数据检索仍是独立原型，暂未接入主应用。

测试：

```bash
npm test
```

首次重新制备点数据时：

```bash
npm run data:points
```

该命令需要 Python 3、NumPy 和 pyGPlates 1.0+。它以流式 OpenXML 方式只读
`data/PointData/pbdb_data.xlsx`，使用 pyGPlates 在服务端/离线阶段分配
Plate ID，并生成 `data/generated/points/`。已有兼容的 Plate ID 缓存会被复用。

## 当前能力

- Canonical UI 已实现为真实 Vue 3 Web Shell，而不是截图或 iframe；使用 Arial、
  `rgb(42, 130, 228)` 主色和全视口响应式画布适配浏览器。
- 图层栏、板块模型切页、时间控制器和高密度地质时间轴已接入真实 Cesium、
  板块重建、PBDB 点、Raster 和图集 runtime。
- 阶段 2 已完成：支持完整图层组、组内/跨组拖拽、组/层显隐和透明度、受限点样式与
  字段过滤、row ID 拾取、请求取消、LRU 和两阶段卸载；修改即时作用于 Cesium，
  刷新可恢复，并在已有云项目时 debounce 保存新 revision。
- 项目名、时间、图层状态与相机可映射为生成的 `ProjectDocumentV2TO`，并保留本地草稿。
  共享模型使用 Unity 原有账号登录；邮箱验证码、在线版本目录和带冲突检测的云项目
  revision 取决于所连接 Server 的实际能力，V1-only Server 不支持的操作不会假报成功。
- 实验 V2 Server 的阶段 3 第一个 Point CSV 垂直切片已完成：浏览器选 CSV/TSV/TXT → MD5 内容哈希 →
  直传 OSS → `CompleteDatasetUpload` → `CreateDatasetIngestJob`（Draft DatasetVersion +
  Queued Job）→ 后台 Worker 解析、分配 Plate ID、编码 WGP1、写 manifest →
  DatasetVersion Ready → Web 轮询到 Ready 后自动添加点图层。该切片已在本地真实 Server
  上端到端跑通，并支持公开发布（`PublishDatasetVersion`）。仅 Point CSV 一种格式完成；
  Excel/Shape/GPML/ROT/TIF 在线导入、发布权限细化、manifest 稳定 URL 重写等生产化
  能力尚未完成。实施与验证记录见
  [阶段 3：Point CSV 上传与入库](docs/phase-3-point-ingest.md)。

- 解析 PLATES 旋转格式的六字段记录、`999` 禁用样本、时间段拆分和参考板块 crossover。
- 将欧拉极转换为 Hamilton 单位四元数，相邻时间样本使用最短路径 SLERP。
- 从锚定板块 `0` 构造指定时间的重建树，按 `parent × relative` 顺序复合有限旋转。
- 解析 GPML 要素、重建 Plate ID、有效时间和 `gml:Polygon`。
- 使用 Cesium `PolygonGeometry` 在球面做测地线细分和三角剖分。
- 每个板块只生成一次网格；时间变化只更新板块级 `modelMatrix` 和要素显隐。
- 支持时间轴拖动、播放、速度切换、快捷时间、视角归位和板块拾取。
- 提供 10k、100k、275k、真实 PBDB、1M、3M、5M 七档点数据切换。
- 点文件由 Worker 拉取和校验，再通过 transferable `ArrayBuffer` 交给主线程。
- 所有点保存在一个交错 GPU 顶点缓冲中；时间变化只上传 Plate ID→四元数纹理，
  不在 JavaScript 中逐点改坐标。
- 自定义 Cesium `DrawCommand` 一次提交点云，并在 vertex shader 中完成有效期过滤、
  四元数球面旋转和点大小计算。
- 性能夹具默认把所有点设为 `0–1100 Ma` 永久有效，保证任意时间都承受全量点
  rasterization 压力。
- 页面实时显示文件/GPU 字节、加载/上传耗时、播放帧率、P95 帧间隔、拖动响应和
  Chromium JS heap 观察值。
- 不依赖 Cesium ion Token 或外部底图。

## 数据与范围

输入文件：

- `data/PlateModelData/PALEOMAP_PlateModel.rot`
- `data/PlateModelData/PALEOMAP_PlatePolygons.gpml`
- `data/PointData/pbdb_data.xlsx`

生成的点夹具：

| 数据集 | 点数 | WGP1 文件 | 说明 |
| --- | ---: | ---: | --- |
| PBDB 10k | 10,000 | 195.4 KiB | 确定性分层样本 |
| PBDB 100k | 100,000 | 1.9 MiB | 确定性分层样本 |
| PBDB 275k | 275,000 | 5.2 MiB | 确定性分层样本 |
| PBDB real | 275,291 | 5.3 MiB | 清洗后的全部真实记录 |
| PBDB 1M | 1,000,000 | 19.1 MiB | 真实点确定性复用压力集 |
| PBDB 3M | 3,000,000 | 57.2 MiB | 真实点确定性复用压力集 |
| PBDB 5M | 5,000,000 | 95.4 MiB | 真实点确定性复用压力集 |

原表共 275,347 行；56 行因缺失必需值或年龄区间无效被拒绝。275,291 条有效记录
中，275,272 条由 pyGPlates 分配到 186 个 Plate ID。为了让性能夹具真正全量常驻，
19 条未分配记录仅在 WGP1 导出时挂到锚定板块 0；原始表和 Plate ID 缓存不变。
1M/3M/5M 只用于负载测试，不代表新增科学观测。

默认生成的是极限性能模式：

```bash
npm run data:points
```

如需恢复 PBDB 来源年龄过滤和隐藏未分配点：

```bash
python3 scripts/prepare_point_fixtures.py --validity source --unassigned hide
```

Vite 只把 `data/PlateModelData/` 映射为运行时公共目录，不会把约
1.1 GB 的点与栅格测试数据复制进每次生产构建。本地 `dev`/`preview` 通过
`/point-data/` 流式提供生成夹具。部署到独立数据服务时，可通过
`VITE_ROTATION_MODEL_URL`、`VITE_PLATE_POLYGONS_URL` 和
`VITE_POINT_DATA_MANIFEST_URL` 覆盖默认 URL。

当前交互时间轴为 `0–538.8 Ma`，性能夹具的永久有效期为 `0–1100 Ma`，两者不能混为一谈。本地 PALEOMAP 演示数据含 471 个 GPML 要素，其中 503 个多边形被渲染；另有 2 个 `gml:OrientableCurve` 被解析为不支持的几何并保留在审计统计中。后端模型的数量与有效期以实际返回内容为准。

实现的是这份数据所需的刚性板块重建。拓扑网络变形、half-stage 海岭重建、速度场与标量覆盖不在当前范围内。

## 结构

| 模块 | 职责 |
| --- | --- |
| `packages/reconstruction-core/` | `.rot`/GPML 解析、重建树、四元数、SLERP 和球面旋转 |
| `packages/cesium-runtime/` | Cesium 球面剖分、板块批处理、矩阵更新、显隐与拾取 |
| `packages/point-runtime/` | WGP1 Worker、单缓冲点云、四元数纹理和 GPU 旋转 |
| `packages/raster-runtime/` | 古地理图集帧选择、瓦片图层和切换缓存 |
| `packages/api-client/` | MetaMaker 生成 Invoker 可复用的无 UI RPC runtime |
| `scripts/prepare_point_fixtures.py` | PBDB 清洗、Plate ID 分配和夹具生成 |
| `src/ui/geological-timeline.ts` | 地质时间轴、播放与拖动 |
| `src/test/` | GPlates 黄金值、解析、剖分和浏览器矩阵测试 |

算法对应关系见 [GPlates 源码定位与 Web 映射](docs/gplates-algorithm-notes.md)，验证记录见
[验证报告](docs/verification.md)。后续演进见
[组件化与完整产品可行性方案](docs/long-term-feasibility.md) 和
[性能测试方案](docs/performance-test-plan.md)。本轮点实现、格式和测试说明见
[大规模点性能实验台](docs/point-performance-lab.md)。当前项目的共识基线见
[项目决策与验证结论](docs/project-decisions-and-findings.md)；面向 TimeMachine
完整前后端产品的现有接口判断和实施顺序见
[Server 复用审计](docs/timemachine-server-reuse-audit.md) 与
[Web 平台及 Unity 渐进替代路线](docs/timemachine-web-migration-roadmap.md)。
阶段 0 的包边界、MetaMaker 接入方式和当前阻塞记录见
[阶段 0：契约与兼容层实施记录](docs/phase-0-contract-and-compatibility.md)。
阶段 1A 的 Canonical Vue Shell、runtime 接线、本地项目草稿和浏览器验收见
[阶段 1A：Canonical Web Shell 实施记录](docs/phase-1a-canonical-web-shell.md)。
阶段 1B 的登录、在线资源 ID/version、云项目版本链和运行配置见
[阶段 1B：登录、在线资源与云项目版本链](docs/phase-1b-online-workspace.md)。
阶段 2 的图层组、点样式、拾取、LRU、runtime 接线和自动保存见
[阶段 2：图层管理、点在线加载与自定义可视化](docs/phase-2-layer-management.md)。
交由其他 Agent 继续开发前，请先阅读
[Agent 工程交接文档](docs/agent-handoff.md)。

TimeMachineWeb 的 UI 设计与前端实现只以
[Canonical UI](docs/ui-reference/README.md) 中的可交互归档为准；截图、聊天预览、
旧版原型和未同步的设计稿不构成实现依据。

## 上游与许可

- `GPlates/` 是单独拉取的 GPlates 上游源码快照，当前 commit 为 `7f4b8fa85208c27fc69e660bd88bcb5ecf84363a`，采用 GPL v2。
- CesiumJS 1.143.0 采用 Apache 2.0。
- 若分发本项目或直接复用 GPlates 实现代码，请根据实际复用范围完成 GPL v2 合规审查。
