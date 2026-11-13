# TimeMachine Server 复用审计

更新日期：2026-07-24

## 1. 审计目标

本审计面向“以 Cesium Web 客户端逐步取代 Unity 客户端”的长期目标，核对
`/Users/user/Desktop/Work/Dev` 中的项目文档、生成定义、Controller 和 Service
实际实现，回答两个问题：

1. 哪些现有 Server 能力可以直接服务 Web；
2. 哪些能力只能复用业务模型或内部代码，必须增加新的 Web 数据接口。

这里的“存在接口”不等于“可用于生产”。判断同时考虑了实现是否完整、返回数据量、
同步/异步方式、并发、权限、缓存和百万级点或 Raster 的传输成本。

## 2. 结论摘要

现有 Server 适合继续承担**控制平面**：

- 用户、角色、Token 和资源访问范围；
- 板块模型、图集、色带、用户表格和项目的目录及生命周期；
- MySQL 元数据、Redis 锁和缓存、OSS 文件引用；
- 项目创建、克隆、发布、访问控制和缩略图；
- MetaMaker 生成的 C#、Unity 和 TypeScript 数据契约。

现有 Server 还不能直接承担面向大数据 Web 客户端的**数据平面**：

- 板块模型目前按完整 `PlateModelTO` 返回，没有版本化 manifest 和独立二进制资产；
- 用户表格和公共表格会物化字符串矩阵，不适合百万点；
- Geo2D 的 `display_all` 不适合大规模要素；
- 图集保存源帧，没有 XYZ/WMTS/COG 瓦片描述；
- 文件解析接口同步读取到内存并一次性返回完整结果；
- 缺少面向普通用户的数据处理 Job、进度、重试和产物清单接口。

推荐方案不是重写 Server，而是：

> 保留现有账户、目录、权限、OSS 和项目业务底座；在同一 .NET 体系中增加 V2
> 数据集、资产 manifest、处理任务、项目修订和瓦片接口。

## 3. 复用分级

### 3.1 可直接复用或通过薄适配复用

| 领域 | 现有模块/接口 | 复用内容 | 前置条件 |
|---|---|---|---|
| 账户 | `user/login/*`、`user/account/*`、Google/Mail 登录、logout | 账户、角色、Token 生命周期、Redis 会话 | 上线前完成密码协议整改，见 4.1 |
| 资源权限 | `ResourceAccessRange`、owner/public 查询条件 | Private/Public/Publish 访问语义 | V2 资源继续复用同一权限判定 |
| 虚拟文件 | `d_planet/user_virtual_file/*` | 文件目录、元数据、访问范围、URL 获取 | 大文件上传改为直传/分片 |
| OSS | `d_planet/user_oss_file/*`、`OssFileOperator`、`OssFileFiller` | MD5 校验、OSS 引用关系、授权 URL、配额统计 | 增加 presigned multipart 和完整性校验 |
| 项目目录 | `d_planet/user_project/display*`、`get_detail`、`get_list` | 项目列表、详情入口、所有者和访问控制 | 项目内容逐步迁移至 V2 revision |
| 项目生命周期 | `create`、`clone`、`publish`、`set_access_range`、软删除 | 云项目、版本来源、发布和分享业务 | 不再把大型图层内容内嵌到一次 update |
| 板块模型目录 | `d_planet/user_plate_model/display*` | 模型搜索、我的模型、公共模型、基本信息 | 模型内容改由 version manifest 加载 |
| 图集目录 | `d_planet/user_time_sequence_atlas/display*`、`count` | 图集元数据、时间帧、模型绑定、权限、标签 | 渲染改走 tileset/瓦片 URL |
| 色带 | `color_ramp`、`user_color_ramp` | 公共/用户色带目录和样式预设 | Web 侧增加统一样式表达式 |
| TypeScript SDK | `TypeScript/src/code_ex`、RPC 基础设施 | 已生成的类型、枚举、Invoker、RPC 返回处理 | 抽成独立 package，禁止手改生成文件 |

### 3.2 适合复用内部实现，不应沿用当前外部契约

| 领域 | 可复用实现 | 当前问题 | V2 包装方式 |
|---|---|---|---|
| Excel/CSV | `FileParseOpenAPIService`、表格解析工具 | `MemoryStream` 全量读取并返回矩阵 | 异步 ingest job，输出标准化列式资产和报告 |
| Shape | GDAL Shapefile 解析、Geo2D 转换 | 全量内存结果，响应体随数据增长 | Job 输出 GeoParquet/分块二进制/矢量瓦片 |
| TIF | GDAL TIFF 解析 | 返回全分辨率 band blob | Job 生成 COG 和瓦片金字塔 |
| GPML/ROT | GDAL GPML/ROT 解析、球面 mesh 构建 | 返回完整 `PlateModelTO`，模型过大 | 生成不可变模型版本及多份二进制资产 |
| 板块投影 | `PlateModelRectangularProjectionWorker` | 单年龄、完整 JSON，偏 2D 输出 | 只作为兼容/导出服务，不作为 3D 主链路 |
| 计划任务 | `ScheduleService`、`ScheduleEntity`、脚本注册机制 | 仅 Operator 管理；无用户产物、阶段进度、重试策略 | 可借用执行骨架，新增用户级 `ProcessingJob` |
| 项目保存 | `UserProjectService` 的事务、锁、OSS 引用 | 整个 `LayerList` 一次更新；最多 32 层；冲突粒度过大 | `ProjectRevision` + manifest + 乐观锁 |
| 公共表查询 | `PublicTableService` 条件树、字段元数据 | 结果为字符串矩阵；分页代码实际被注释 | 复用条件语义，增加 typed/binary/spatial 查询 |
| Geo2D CRUD | 点、线、面的项目归属与小批量编辑 | `display_all` 与逐条实体不适合百万数据 | 仅用于注释/编辑要素，大数据走 Dataset |

### 3.3 不应作为新平台基础

| 现有能力 | 原因 | 处理方式 |
|---|---|---|
| `PlateSkeletonService.GetBoneByModel` / `GetPlateByModel` | Service 仅 `Task.CompletedTask`，没有填充结果 | 不接入；由 PlateModel V2 manifest 取代 |
| `PlateSkeletonService.DisplayModel` | 硬编码 `Scotese` 和 `More in future` | 不接入 |
| `ExportDataController` | 进程内 `ConcurrentDictionary`，30 分钟过期，重启即丢失 | 仅保留 Unity→制图页兼容，不能存项目或会话 |
| Web URL 中的 base64 / LocalStorage 传包 | 体积、可靠性和安全性都不适合产品 | 改为持久化资源 ID 和授权 URL |
| `UserTable.Value` 全量字符串矩阵 | 类型丢失、数据库/序列化开销大 | 小表兼容；大表迁入 DatasetVersion |
| 整幅 GZIP PNG 图集加载 | 首屏、显存、浏览器解压和释放成本随整图增长 | 改为时间帧 tileset + 可见瓦片请求 |
| Cesium/Unity 运行时对象持久化 | 不可版本化、不可跨客户端、含瞬态状态 | 项目只保存领域状态和资源引用 |

## 4. 分领域审计

### 4.1 用户体系

可复用：

- 账户注册、邮件验证码、Google/Mail 登录；
- Account 展示和更新；
- 角色授权级别；
- Token 签发、Redis 账户缓存、Token 更新和退出；
- `Private/Public/Publish` 资源访问控制。

必须整改：

- 当前 TypeScript 端以固定全局 key 对账户和密码计算 SHA-256；
- Server 登录接口把该结果直接与数据库字段比较；
- 该摘要实质上是可重放的“等价密码”，不是 Argon2id/bcrypt/scrypt 一类慢哈希；
- Token 被前端保存在 `localStorage`，需要评估 XSS 风险。

建议在不破坏现有账户 ID 的前提下渐进迁移：

1. 新登录端点在 TLS 下接收原始密码；
2. Server 使用 Argon2id 或合适参数的 bcrypt 保存独立盐哈希；
3. 老账户首次成功登录时升级密码记录；
4. Web 优先使用 `HttpOnly + Secure + SameSite` cookie；API 场景再使用短期 access
   token 和可撤销 refresh token；
5. 旧 `/user/account_open_api/get_password*` 退出公开登录链路。

因此，**用户数据模型和权限体系可复用，当前密码协议不可原样复用到新 Web 产品**。

### 4.2 文件上传与数据解析

现状：

- `FileParseOpenAPIController` 支持 Excel、CSV、Shape、TIF、GPML+ROT、CPT、JSON
  色带和点配准；
- 请求上限可到 1 GiB，但 Service 多处先读入 `MemoryStream`；
- Shape、Raster 和板块模型结果在一次 RPC 中完整返回；
- `upload_byte_stream` 单 blob 约束为 64 MiB；
- OSS 元数据、文件引用、MD5 完整性和授权 URL 已存在。

判断：

- 小文件 MVP 可以继续调用现有解析接口；
- 正式数据上传应只复用解析器和 OSS 基础设施，不应让 HTTP 请求一直等待解析；
- “允许 1 GiB 请求”不等于“能稳定解析 1 GiB”，内存中可能同时存在上传体、
  解析结构、序列化结果和响应副本。

V2 需要：

- 初始化上传、分片直传 OSS、完成上传；
- 以文件哈希去重；
- 创建用户可见 Job；
- 阶段状态：校验、解析、字段映射、Plate ID 分配、索引/剖分、切片、发布；
- 结构化错误报告和可下载 rejected rows；
- 发布不可变 `DatasetVersion`，客户端只读取 manifest 和资产。

### 4.3 板块模型

可复用：

- `UserPlateModel` 的创建、更新、目录、所有者和访问控制；
- `PlateModelTO` 中的 GPML geometry 与 rotation 数据语义；
- `FileParseOpenAPIService.ParseGPML`；
- `PlateModelSphereMeshAssistant`；
- `PlateModelProjectionService` 可继续为 2D 矩形投影兼容场景服务。

不应直接用于 Web 主渲染：

- `get_detail` 返回完整 `PlateModelRO.Content`，还会在读取时补建 mesh 并写回；
- 模型内容和资源目录没有清晰的不可变版本边界；
- `PlateSkeletonService` 的骨架和板块接口是占位代码；
- 单个大型 JSON 会造成数据库读取、Server 序列化、网络和浏览器解析峰值。

建议新增：

- `PlateModelVersion`：模型 ID、版本、hash、锚定板块、时间范围、处理器版本；
- `PlateModelManifest`：rotation、polygon mesh、feature metadata 等资产 URL；
- rotation 资产保持精确的父子关系和样本，客户端使用已验证的 GPlates 四元数链；
- mesh/feature 采用紧凑二进制并由 CDN 缓存；
- manifest 和资产不可变，更新模型时发布新版本。

### 4.4 项目与用户行为保存

现有 `UserProject` 已经覆盖：

- Guest/LocalDraft/CloudProject；
- `DraftID`、`LastSyncTarget`；
- 创建、更新、克隆、发布、访问控制；
- 板块模型、图层、图层树、视图设置和缩略图；
- Unity 端 3 秒延迟保存。

这些业务语义值得保留。但当前项目更新发送完整 `LayerList`，图层还内嵌点/线/面/
Raster/Atlas 配置，并有 32 层限制。随着在线数据和瓦片出现，这种结构会导致：

- 保存体积随数据增长；
- 两个客户端修改不同图层仍会冲突；
- 难以做历史版本、差异比较和可靠恢复；
- 资源和表现状态耦合。

V2 项目建议保存：

- 当前板块模型版本；
- 统一 `timeMa`、播放设置、相机和 globe/view 设置；
- 图层树、顺序、显隐、透明度；
- 每层的 `sourceRef`、时间绑定、模型绑定和样式表达式；
- 选择集或筛选条件的可选命名版本；
- revision、父 revision、创建者和变更说明。

不保存：

- Cesium Primitive、GPU buffer、纹理、Worker；
- 百万点本体；
- 每次鼠标移动、相机中间帧等瞬态行为。

建议用 `baseRevision`/ETag 做乐观并发，自动保存采用 debounce 后提交 patch 或新
revision；发布和里程碑才生成长期快照。

### 4.5 在线点数据

现有能力：

- `UserTable` 的目录、权限和 XLSX 下载；
- `PublicTable` 的字段元数据、条件树和外键值；
- `UserProjectGeo2DPoint` 的小批量 CRUD；
- PBDB 等现有数据库表。

规模问题：

- `UserTable.Value` 是 `FieldAndValueStringMatrixTO`；
- `PublicTableService.DisplayValue` 中分页限制被注释，可能物化大量行；
- Web 制图页把所有点转为普通 JS 对象并放入 Vue 响应式数组；
- Geo2D `display_all` 会让浏览器一次接收整个集合。

建议区分两类数据：

1. **Annotation Feature**：用户手工创建/编辑的小规模点线面，继续复用 Geo2D；
2. **Dataset Feature**：PBDB 或上传的大规模数据，不复制进 Project，项目只引用
   DatasetVersion。

Dataset V2 需要 typed schema、统计、字段字典、空间/时间索引、模型绑定、处理来源和
二进制资产。当前 WGP1 可以作为第一版静态点资产，后续增加空间瓦片、LOD 和独立
属性列。

### 4.6 在线图集与 Raster

`UserTimeSequenceAtlas` 的以下内容可直接成为新目录的基础：

- 作者、引用、版本、类别、标签、许可和访问范围；
- 绑定的 PlateModel；
- `StartAge/EndAge/MeanAge` 帧时间；
- 色带和值域；
- OSS 原始文件和缩略图。

缺少的核心是可渲染瓦片。当前 `AtlasFrameTO` 描述源文件和 band，没有 tile matrix、
层级、格式、投影、NoData、边界或 URL template。

建议新增 `AtlasAssetVersion`/`RasterTileSet`：

- 原始文件保留在 OSS；
- ingest job 生成 COG 或内部标准 Raster；
- 按时间帧生成 XYZ/WMTS 瓦片或按需动态切片；
- manifest 记录 CRS、extent、tile matrix、level、format、NoData、band 和统计；
- 客户端按当前时间选择帧，只保留相邻帧和可见瓦片；
- 色带尽可能在 shader 端应用，避免为每种色带重复切瓦片。

## 5. 建议新增的 V2 接口组

下列为建议契约，不是当前已有接口。

### 5.1 上传与任务

- `POST /api/v2/uploads`
- `POST /api/v2/uploads/{id}/complete`
- `POST /api/v2/processing-jobs`
- `GET /api/v2/processing-jobs/{id}`
- `POST /api/v2/processing-jobs/{id}/cancel`
- `GET /api/v2/processing-jobs/{id}/events`（SSE，可先用轮询）

### 5.2 数据集

- `GET /api/v2/datasets`
- `GET /api/v2/datasets/{id}`
- `GET /api/v2/datasets/{id}/versions/{version}/manifest`
- `GET /api/v2/datasets/{id}/versions/{version}/query`
- `GET /api/v2/datasets/{id}/versions/{version}/tiles/{z}/{x}/{y}`

数据资产应优先由带时效签名的 OSS/CDN URL 返回，不由应用 Server 中转大文件。

### 5.3 板块模型

- `GET /api/v2/plate-models`
- `GET /api/v2/plate-models/{id}`
- `GET /api/v2/plate-models/{id}/versions/{version}/manifest`

### 5.4 图集

- `GET /api/v2/atlases`
- `GET /api/v2/atlases/{id}/manifest`
- `GET /api/v2/atlases/{id}/frames/{frame}/tiles/{z}/{x}/{y}`

若瓦片为公开资源，最后一个地址可以直接是 CDN URL template。

### 5.5 项目

- `GET /api/v2/projects/{id}`
- `GET /api/v2/projects/{id}/revisions/{revision}`
- `POST /api/v2/projects/{id}/revisions`
- `PATCH /api/v2/projects/{id}/draft`
- `POST /api/v2/projects/{id}/publish`

所有写入都带 `baseRevision` 或 `If-Match`，冲突时返回当前 revision，而不是静默覆盖。

## 6. MetaMaker 和代码组织约束

现有工程明确规定 `CodeEx` 为生成代码。新增实体、枚举和 RPC 定义应优先放在
`MetaMaker2/Define` 并重新生成 Server/Unity/TypeScript 产物，不能直接修改生成文件。

建议：

- 控制平面 DTO、Entity、访问控制和 CRUD 继续走 MetaMaker；
- 大文件流、Range、瓦片、SSE 等数据平面端点可以使用专门 Controller，但必须复用
  同一认证和权限服务；
- 把 `TypeScript/src/code_ex` 和 RPC runtime 提取成可发布的内部 SDK 包；
- TimeMachineWeb 的重建内核与 Cesium renderer 保持独立包，不依赖生成 RPC 细节。

## 7. 审计证据入口

主要阅读入口：

- `/Users/user/Desktop/Work/Dev/PROJECT_ARCHITECTURE.md`
- `/Users/user/Desktop/Work/Dev/Docs/Web轻量编图应用_架构讨论.md`
- `/Users/user/Desktop/Work/Dev/Server/ServiceUser/Service/LoginService.cs`
- `/Users/user/Desktop/Work/Dev/Server/ServiceUser/AccountAssistant.cs`
- `/Users/user/Desktop/Work/Dev/Server/ServiceDPlanet/Service/FileParse/FileParseOpenAPIService.cs`
- `/Users/user/Desktop/Work/Dev/Server/ServiceDPlanet/Service/WorkSpace/UserOssFileService.cs`
- `/Users/user/Desktop/Work/Dev/Server/ServiceDPlanet/Service/WorkSpace/UserPlateModelService.cs`
- `/Users/user/Desktop/Work/Dev/Server/ServiceDPlanet/Service/WorkSpace/Projection/PlateModelProjectionService.cs`
- `/Users/user/Desktop/Work/Dev/Server/ServiceDPlanet/Service/Geo/PlateSkeletonService.cs`
- `/Users/user/Desktop/Work/Dev/Server/ServiceDPlanet/Service/WorkSpace/UserProjectService.cs`
- `/Users/user/Desktop/Work/Dev/Server/ServiceDPlanet/Service/WorkSpace/UserTableService.cs`
- `/Users/user/Desktop/Work/Dev/Server/ServiceDPlanet/Service/Table/PublicTableService.cs`
- `/Users/user/Desktop/Work/Dev/Server/ServiceDPlanet/Service/WorkSpace/UserTimeSequenceAtlasService.cs`
- `/Users/user/Desktop/Work/Dev/Server/ServiceSystem/Service/ScheduleService.cs`
- `/Users/user/Desktop/Work/Dev/Server/Server/Controllers/ExportDataController.cs`
- `/Users/user/Desktop/Work/Dev/TimeMachineMapping/src/views/mapping/services/dataReceiver.ts`
- `/Users/user/Desktop/Work/Dev/TimeMachineMapping/src/views/mapping/composables/useTimeMachineStore.ts`
- `/Users/user/Desktop/Work/Dev/TypeScript/src/code_ex`
