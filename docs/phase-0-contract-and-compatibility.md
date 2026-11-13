# 阶段 0：契约与兼容层实施记录

更新日期：2026-07-24

状态：已完成。阶段 0 的契约源、三端生成代码、Server 兼容层、Web/Unity
功能协商与遥测、自动化回归和独立 Git 工作副本均已落地。

## 1. 隔离基线

为避免污染 `/Users/user/Desktop/Work/Dev` 中存在冲突和本地修改的 SVN 工作副本，
在 `TimeMachineWeb/DPlanet` 建立了独立 Git 工作副本：

- 来源：DPlanet SVN revision 4494 的干净导出；
- 分支：`stage0`；
- 范围：`MetaMaker2`、`Server`、`TypeScript`、`Unity` 以及构建所需 SDK；
- 规则：只修改 `MetaMaker2/Define` 契约源，所有 `CodeEx` 均由 MetaMaker 生成；
- 手写 Server、Unity 和测试代码均位于 `CodeEx` 外。

MetaMaker 增加了可在终端和自动化环境运行的 `GeneratorCli`。连续第二次生成结果为：

```text
Generated: new=0, changed=0, same=1771, deleted=0
```

这证明当前生成结果幂等。

## 2. Web 运行时与 SDK 边界

根应用通过 package 入口组合能力，不再从 demo UI 直接引用散落实现：

| Package | 职责 |
|---|---|
| `@timemachine/reconstruction-core` | ROT/GPML、重建树、四元数、球面坐标旋转 |
| `@timemachine/cesium-runtime` | 球面剖分、板块 primitive、矩阵与拾取 |
| `@timemachine/point-runtime` | WGP1、Worker、GPU buffer、四元数纹理 |
| `@timemachine/raster-runtime` | Raster/图集 manifest、帧选择、Cesium imagery |
| `@timemachine/api-client` | 无 UI 依赖的 MetaMaker RPC transport |
| `@timemachine/generated-api` | 直接导出 MetaMaker 生成的 Invoker、DTO 和 enum |
| `@timemachine/platform-runtime` | capabilities、只读/写门控和遥测 |

MetaMaker 的 TypeScript 代码生成器现在支持可配置 RPC 模块导入。DPlanet 的生成目标使用
`@timemachine/api-client`，旧工程仍可保留相对导入模式。DPlanet TypeScript 里原有的五套
RPC 类已改为统一 runtime 的 re-export，因此 wire contract 只有一个实现。

这不是把 TypeScript 业务逻辑复制到 Server。边界仍然是：

- `MetaMaker2/Define`：Entity/API/DTO 的唯一契约源；
- MetaMaker：生成 Server Controller/Service interface、TypeScript SDK 和 Unity SDK；
- Server 手写 Service：权限、事务、兼容转换和遥测；
- Web/Unity 手写 runtime：客户端能力协商及渲染编排。

## 3. 五张 V2 实体表

以下实体已进入 `MetaMaker2/Define`，并生成到 `DPlanetDBContext`。`ViFKey<T>` 会形成
MetaMaker 外键元数据，索引由 `DBIndex`/`DBUnionIndex` 定义。

| 实体 | 唯一索引 | 主要普通/组合索引 | 外键 |
|---|---|---|---|
| `PlateModelVersionEntity` | `(PlateModel, VersionNumber)` | `PlateModel`、`Status`、`ContentHash`、`Creator` | `PlateModelEntity`、`AccountEntity` |
| `DatasetVersionEntity` | `(Dataset, VersionNumber)` | `Dataset`、`GeometryType`、`Status`、`PlateModelVersion`、`ContentHash`、`Creator` | `TableEntity`、`PlateModelVersionEntity`、`AccountEntity` |
| `ProcessingJobEntity` | 无 | `(Creator, JobType, Status)`、`(InputHash, ProcessorVersion)` 及各目标字段 | Account、PlateModelVersion、DatasetVersion、ProjectRevision、RasterTileSet |
| `ProjectRevisionEntity` | `(Project, RevisionNumber)` | `Project`、`BaseRevision`、`PlateModelVersion`、`RevisionStatus`、`ContentHash`、`Creator` | Project、自引用 BaseRevision、PlateModelVersion、Account |
| `RasterTileSetEntity` | `(Atlas, VersionNumber, FrameKey)` | `Atlas`、`DatasetVersion`、`Status`、`ContentHash`、`Creator` | TimeSequenceAtlas、DatasetVersion、Account |

实体同时包含版本号、状态、内容哈希、处理器版本、manifest、访问范围等可复现字段。
`ProjectRevision` 保存 schema version、稳定 JSON、warning 和来源契约版本；
`RasterTileSet` 保存帧、CRS、矩形范围、层级、瓦片大小、格式与 NoData。

阶段 0 完成的是数据库 schema 的契约与生成元数据。没有连接或修改任何共享数据库实例；
部署环境应先备份并审阅 MetaMaker `MetaFormat` 产生的 DDL，再应用五张新表。

## 4. V1→V2 只读兼容

新增两个登录后接口：

- `TimeMachineCompatibility.ConvertPlateModelV1`
- `TimeMachineCompatibility.ConvertProjectV1`

兼容 Service 先执行 owner/public 权限过滤；项目转换还会校验传入
`PlateModelVersion` 确实属于 V1 项目绑定的 `PlateModel`。

转换器位于手写 Server 目录，不进入 `CodeEx`，行为如下：

- V1 `PlateModelEntity` 映射为只读 `PlateModelVersionRO`；
- V1 `ProjectEntity.LayerList` 按原列表顺序深拷贝；
- 保留模型 ID、模型版本 ID、图层透明度、类型、样式、视图和路径树；
- V1 没有持久化的项目时间和坐标系，明确默认到 `0 Ma` 与 `Rectangular` 并产生 warning；
- 输出 canonical JSON 与 SHA-256 内容哈希；
- 只读转换不写数据库，用户后续明确保存时才创建 V2 revision。

匿名化代表性 fixture 覆盖了图层顺序、模型绑定、0 Ma 默认、样式/视图、
深拷贝、warning 和重复转换稳定哈希。未复制生产数据库中的用户项目或敏感字段。

## 5. Web/Unity 功能开关与遥测

新增公共平台接口：

- `TimeMachinePlatform.GetCapabilities`
- `TimeMachinePlatform.RecordTelemetry`

五个能力名与五张实体一致。阶段 0 返回 `enabled=true, readOnly=true`：
Web 和 Unity 可以读取 V2/兼容结果，但写操作仍留在 V1，避免未完成的写链路提前启用。
服务不可用或尚未完成协商时，两端默认关闭能力。

Web 在配置 `VITE_TIMEMACHINE_SERVER_URL` 后启动协商；未配置时保持当前本地 demo
工作方式。Unity 在 `RPCManager.Ready()` 后协商，并通过同源生成 enum 进行
`CanRead`/`CanWrite` 判断。

遥测只记录客户端、版本、能力、事件名、耗时、数量、成功状态和 correlation ID。
Server 不记录任意 dimensions 内容，避免把业务属性或用户数据写入日志。

## 6. 生成兼容修复

全量生成与 Unity 编译暴露出一个 r4494 历史问题：
`ParseShapeTo3DMesh` 存在于旧生成 Controller/Invoker 和手写 Service，但缺失于
MetaMaker 源 Module。重新生成会删除该 API 并破坏 Unity。

该方法已补回 `MetaMaker2/Define/DPlanet/Module/FileParse`，随后重新生成。
因此旧客户端功能被保留，同时生成结果恢复为幂等状态。

## 7. 验证结果

全部通过：

| 验证 | 结果 |
|---|---|
| MetaMaker CLI 构建 | 0 warning / 0 error |
| MetaMaker 连续生成 | 0 new / 0 changed / 1771 same / 0 deleted |
| Server solution | 0 error；9 个既有 GeoCoding DTO warning |
| V1→V2 C# fixture | 通过 |
| DPlanet TypeScript type-check + Vite build | 通过 |
| Unity 2022.3.24f1 batch compile | 通过，无脚本编译错误 |
| TimeMachineWeb Vitest | 11 files / 52 tests 全通过 |
| TimeMachineWeb TypeScript + production build | 通过 |

52 个 Web 测试包含既有 pyGPlates 黄金坐标、多链路四元数复合、全部 GPML 面剖分、
WGP1、Raster，以及新增 capabilities/telemetry RPC contract。

已知非阻塞项：

- DPlanet TypeScript 的既有依赖审计报告 12 个 moderate、3 个 high；
- DPlanet 管理端构建仍有既有大 chunk warning；
- Server 的 GeoCoding 私有 DTO 有 9 个既有“字段未赋值”warning；
- 兼容转换对 V1 未持久化的时间和坐标系只能使用明确默认值并返回 warning。

## 8. 阶段 0 结论

阶段 0 已建立可继续演进的边界：V2 数据模型从 MetaMaker 单一来源生成，Server、
Web 和 Unity 使用同一契约；V1 数据可只读进入 V2 视图；Web/Unity 由同一能力开关
控制渐进替代。下一阶段可以开始第一个在线垂直切片，而无需从 TypeScript 复制业务逻辑
到 Server，也无需在生成目录中维护手工补丁。
