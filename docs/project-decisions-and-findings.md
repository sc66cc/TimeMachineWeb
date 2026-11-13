# TimeMachineWeb 项目决策与验证结论

更新日期：2026-07-24

本文固化当前阶段已经讨论、实现和验证的结论。它是后续组件化和 TimeMachine
完整前后端平台设计的决策基线；性能专用行为与科学产品行为必须按本文区分。

UI 决策基线已于 2026-07-27 归档至
[`docs/ui-reference/canonical/index.html`](ui-reference/canonical/index.html)。
该可交互页面是 TimeMachineWeb UI 的唯一真实实现参考；截图、临时预览和旧版原型
不具有同等效力。

## 1. 长期目标

项目有两个互相兼容的长期目标：

1. 建设可复用的深时可视化组件，提供板块运动、时间控制、点面 Raster 图层、
   数据绑定和拾取能力；
2. 建设完整的 TimeMachine 前后端产品，逐步取代现有 Unity 客户端，覆盖用户、
   板块模型、数据导入、在线图层、在线图集、项目保存和分享。

组件不是独立于产品的临时分支。长期产品的 Web 客户端应直接复用同一套重建内核、
数据契约和 Cesium 图层运行时。

## 2. 已验证的科学计算链路

当前实现已对照 GPlates commit
`7f4b8fa85208c27fc69e660bd88bcb5ecf84363a`，确认以下语义：

- PLATES `.rot` 六字段顺序及 `999` 禁用样本；
- 欧拉极到 Hamilton 单位四元数；
- 相邻有限旋转的最短路径 SLERP；
- 重建树的 `absoluteFixed × relativeFixedToMoving` 复合顺序；
- 反向边使用相对四元数共轭；
- 现今球面坐标通过 Plate ID 对应的总旋转重建到目标时间；
- 球面而非 WGS84 扁椭球是刚性有限旋转的几何基准；
- Cesium 日历时间轴不适合 Ma，客户端使用 `0–1100 Ma` 自定义时间控制器。

自动化测试覆盖解析、重建树、四元数、Cesium 矩阵、GPML 球面剖分、pyGPlates
黄金坐标、WGP1 格式、永久有效期策略和 MetaMaker RPC wire contract。当前结果为
50 项通过，生产构建通过。

## 3. 板块面实现决策

- GPML 坐标只剖分一次；
- 同一 Plate ID 的几何共享板块级旋转；
- 时间变化只更新板块 `modelMatrix` 和要素显隐；
- 当前 PALEOMAP 数据包含 471 个要素、503 个已渲染多边形、约 649,905 个三角面；
- 两个 `gml:OrientableCurve` 不属于当前多边形渲染范围，保留为已知数据差异；
- 当前范围只支持刚性板块重建，不包含拓扑网络变形、half-stage、速度场或标量覆盖。

## 4. 大规模点实现决策

### 4.1 数据制备

PBDB XLSX 在离线/服务端阶段处理，浏览器不解析 XLSX：

- 原始行：275,347；
- 接受：275,291；
- 拒绝：56，其中缺失必需值 36、年龄区间无效 20；
- pyGPlates 在 0 Ma 分配 Plate ID：275,272 条成功、19 条未分配；
- 首次 Plate ID 分配耗时 2.764 秒，约 99,600 点/秒；
- Plate ID 结果按 XLSX、GPML、ROT 的 SHA-256 缓存；
- 1M 和 5M 压力集复用已分配的 275,291 个真实点，不重复执行分区。

线上测试格式为 WGP1：64 字节文件头、20 字节/点，包含单位球坐标、有效时间、
Plate ID 和 occurrence count。Worker 完成 fetch、格式校验和 transferable
`ArrayBuffer` 交接。

### 4.2 GPU 路径

已经否决“时间变化时在 JavaScript 中逐点计算并改坐标”的路径。当前选择：

- 一个交错 GPU 顶点缓冲；
- 顶点携带 Plate ID；
- CPU 每次只计算活动 Plate ID 的四元数；
- 四元数以 `RGBA32F` 纹理上传；
- vertex shader 查表并执行球面旋转；
- 10k 至 5M 均为一个 draw call；
- 点的 CPU 时间更新复杂度与活动板块数相关，不与点数线性相关；
- GPU 顶点和 fragment 工作仍为 O(N)，产品化 5M 需要空间瓦片和 LOD。

5M WGP1 文件约 95.4 MiB，对应 GPU 顶点缓冲约 95.4 MiB。浏览器端已验证六档
数据能成功加载和绘制；无头 SwiftShader 结果只作为功能回归，不能作为硬件性能
结论。

### 4.3 永久有效性能策略

为了测试极限绘制能力，当前默认性能夹具将每条记录设为 `0–1100 Ma` 永久有效。
19 条没有 Plate ID 的来源记录只在性能导出中挂到锚定板块 0，保证任意时间都绘制
完整的 10k、100k、275k、275,291、1M 和 5M 点。

该策略不能直接用于科学产品：

- 原始 XLSX 和 Plate ID 缓存不修改；
- manifest 明确记录 `validityPolicy` 和 `unassignedPointPolicy`；
- 科学模式必须恢复来源年龄，并对未分配点执行隐藏、人工修订或可审计的重分配。

### 4.4 GPU 资源释放

当前释放流程同步执行 Cesium primitive 移除、VertexArray/VertexBuffer 销毁、
shader 缓存释放、纹理删除和 RenderState 清理。5M 场景的感知延迟主要来自：

1. 点击事件等待当前全量渲染帧结束；
2. GPU buffer 仍被在途 DrawCommand 使用；
3. 驱动异步回收约 95.4 MiB 显存；
4. 浏览器稍后回收约 100 MiB CPU ArrayBuffer；
5. UI 在同步 `destroy()` 返回后才显示释放完成。

后续应采用“立即隐藏并反馈、停止播放、下一帧或 idle 阶段销毁”的两阶段释放，并
分别记录事件排队、同步销毁、下一帧消失和内存回落时间。频繁切换的大缓冲可考虑
池化复用。

## 5. 完整产品的既定原则

- 浏览器负责交互、可见数据请求、GPU 渲染和轻量筛选；
- XLSX/CSV/GPML/ROT/GeoTIFF/NetCDF 的解析、质量校验、Plate ID 分配、索引和
  Raster 金字塔在服务端或异步任务执行；
- 原始文件、标准化产物、瓦片和 manifest 放对象存储/CDN；
- API 管理用户、权限、数据目录、模型目录、任务状态、项目和查询；
- 点面使用紧凑二进制或列式格式，不用 JSON 传输百万条记录；
- Raster 和在线图集必须切为 COG/XYZ/WMTS 等可按需请求的金字塔，禁止整包进入
  Web 构建或首屏；
- 所有图层共享统一 `timeMa`，但各自声明时间范围、坐标时间和模型绑定；
- 数据集必须绑定 `modelId`、模型版本/哈希、锚定板块、`coordinateTimeMa`、
  Plate ID 分配方法、原始文件哈希、处理流水线版本和失败报告；
- 用户操作通过项目文档持久化，不把 Cesium/Unity 运行时对象直接序列化；
- GPlates GPL v2 上游源码只作为可追溯算法基线；直接复用代码需单独做许可审查。

## 6. 平台化新增结论

- 现有 Server 继续作为用户、权限、目录、项目生命周期、OSS 和元数据控制平面；
- 百万点、板块模型资产、图集瓦片和异步处理采用新的 V2 数据平面；
- `PlateSkeletonService` 是占位实现，不能作为板块模型在线加载基础；
- 当前密码摘要协议不能原样用于新 Web 产品，但账户 ID、角色和权限可渐进迁移；
- 大数据集与用户手工注释分离：前者使用版本化 Dataset，后者继续使用 Geo2D CRUD；
- 项目从完整 `LayerList` 覆盖更新演进为 `ProjectRevision + manifest + 乐观锁`；
- 图集复用目录、时间帧和权限，渲染资产必须增加 COG/XYZ/WMTS 等瓦片 manifest；
- Unity/Web 并行期以 Server 资源 ID 为唯一身份，通过 V1/V2 转换器渐进迁移；
- `ExportDataController` 只保留短期制图页兼容，不作为项目、会话或数据分发基础。

详细依据见 `timemachine-server-reuse-audit.md`，实施顺序见
`timemachine-web-migration-roadmap.md`。

## 7. 仍需在实现中定案

- 点/面空间瓦片的最终格式、层级和服务端查询语义；
- Raster 动态切片与预切片的选择、投影组合和成本模型；
- ProjectRevision 的 patch 粒度、保留周期和冲突 UI；
- ProcessingJob 的执行框架、资源隔离、重试和配额；
- 旧账户认证迁移和 Token/cookie 的最终方案；
- 科学模式与性能模式在数据契约和 UI 中的显式隔离。
