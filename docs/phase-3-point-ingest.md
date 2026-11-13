# 阶段 3（第一个垂直切片）：Point CSV 上传与入库

本轮交付 Phase 3 的第一个端到端切片：

```text
浏览器选 CSV → MD5 内容哈希 → 直传 OSS → CompleteDatasetUpload
  → CreateDatasetIngestJob（Draft DatasetVersion + Queued Job）
  → Worker 领取 → 解析 → Plate ID 分配 → WGP1 编码 → manifest
  → DatasetVersion Ready → Web 轮询到 Ready 后自动添加 Point 图层
```

覆盖 roadmap 的 3B（契约与控制平面）、3C（Worker）、3D（上传向导）、3E（公开发布）。
四段都已在本地真实 Server 上跑通，见 5.1。

## 1. 契约（MetaMaker2/Define）

`TimeMachineIngestModule`（`LoginAfter` + `Role.Customer`）：

| API | 作用 |
| --- | --- |
| `DisplayIngestPlateModels()` | 列出可绑定的 PlateModel 及其板块多边形数量（JSON 传输，见 3.1） |
| `CreateDatasetUpload(DatasetUploadRequestVO)` | 预留 OSS 对象，返回 presigned PUT；内容不经过应用 Server |
| `CompleteDatasetUpload(ViFKey OssFileID)` | 校验对象实际大小并标记上传完成 |
| `CreateDatasetIngestJob(DatasetIngestRequestVO)` | 建 Draft DatasetVersion 与 Queued ProcessingJob |
| `DisplayMyJobs()` / `GetJob(ViFKey)` | 只返回调用者自己的 Job |
| `CancelJob(ViFKey)` | 仅 Queued/Running 且属于调用者 |
| `PublishDatasetVersion(ViFKey, ResourceAccessRange)` | Ready 且属于调用者的版本进入公开目录 |

`DatasetIngestRequestVO.PlateModel` 绑定 `PlateModelEntity`，不引入
`PlateModelVersionEntity`，理由见 2.2。

### 1.1 数据库变更

唯一一处 DDL：`processing_job` 新增 `request_json` 列（已获用户明确批准）。原因是
Job 需要携带列映射、PlateModelVersion 绑定和源文件哈希，这些是任务输入而不是结果，
放在 manifest 里会导致 Worker 无法在领取时重建请求。回滚方式为删除该列并回退
`ProcessingJobEntity` 定义后重新生成。

## 2. Worker（`PointIngestWorkerService.cs`）

`IHostedService`，注册于 `ServiceInit.cs`，`SQLDBName`/`RedisDBName` 由
`ImplementAssembly.Exec()` 注入。`TIMEMACHINE_POINT_WORKER_DISABLED` 环境变量可关闭。

领取逻辑靠一次带条件的更新，而不是先读后写：

```text
Redis 锁 ProcessingJobQueue
  → 查 Queued + JobType=DatasetIngest + ProcessorVersion 匹配，按 CreateTime 取 2 条
  → 逐条 UPDATE ... WHERE ID=? AND Status=Queued  （changed>0 才算领到）
```

因此多实例并行不会重复处理，且 `Attempt` 每次领取自增。

阶段与进度：`download 0.05 → parse 0.25 → assign 0.45 → encode 0.7 → publish 0.85 → done 1.0`。

终态写入的三条约束：

- `Fail` 带 `WHERE Status=Running`，已 Cancelled 的 Job 不会被覆盖回 Failed；
- `SetVersionStatus` 带 `WHERE Status != Ready`，Ready 版本永不被降级；
- `Succeed` 在单个事务内同时把 DatasetVersion 置 Ready 和 Job 置 Succeeded，
  不存在「Ready 但没有 manifest」的半成品。

写入 Manifest 这类扁平化 `FileLinkTO` 子列只能走 `SaveByIDAsync<TMask>`
（`DatasetVersionCreateVO` / `ProcessingJobRO`）：流式 `SetField` 需要强类型
`ViMetaField<T>`，而 `Manifest.Name/.Extention/.MD5` 只在 mask 展开时存在。

### 2.1 WGP1 产物

64 字节头 `<4sIIIIIII`：magic `WGP1`、version 1、headerBytes 64、recordStride 20、
pointCount、sourcePointCount、maxPlateId、maxTimeDeciMa 11000。
记录 20 字节：position float32×3 @0、validFromDeciMa u16 @12、validToDeciMa u16 @14、
plateId u16 @16、occurrenceCount u16 @18。

时间编码 `from = floor(ma*10)`、`to = ceil(ma*10)`，clamp 到 [0, 11000]；
永久有效为 from=11000 / to=0。

`activeCountsByIntegerMa` 用长度 11002 的差分数组累加，每 10 个索引采样一次，
输出恰好 1101 项——这是 manifest 里唯一的逐时间序列，百万行数据不会跨 API 边界。

### 2.2 Plate ID

源 CSV 提供 `plate_id` 时按源值使用（超范围记 `plate_id_out_of_range`）；
未提供或为 `65535` 时用 PlateModel 自身的多边形做点在面判定。嵌套多边形取内层。

绑定对象是 `PlateModelEntity`，不是 `PlateModelVersionEntity`。后者在本地库里没有任何
RPC 会创建，引入它只会给切片加一层无法自举的依赖；而板块多边形本来就存在于
`PlateModelEntity.Content.GeoList[].Polygon`，`ParseGPML` + `UserPlateModel.Create`
已经能完整落库。manifest 用 `source.plateModelId` / `source.plateModelName` 记录绑定，
审计不需要版本行。

拒绝原因与 Python 参考实现保持一致：`missing_required_value`、`non_finite_value`、
`coordinate_out_of_range`、`invalid_age_interval`，新增 `plate_id_out_of_range`。
每种原因都有独立计数写入 manifest。

## 3. Web 上传向导

`src/phase3/`：

| 文件 | 职责 |
| --- | --- |
| `md5.ts` | 分块流式 MD5（4 MB/块）。Web Crypto 不提供 MD5，而上传契约以 32 位小写十六进制 MD5 做内容寻址 |
| `csv-preview.ts` | 只读前 128 KB，最多 8 行预览；RFC 4180 引号处理；分隔符探测；列名猜测 |
| `ingest-client.ts` | 校验、XHR 直传（带上传进度）、Job 轮询 |

`md5.ts` 的 MD5 只是内容地址与完整性校验，不作为安全原语。

`AppShell.vue` 中 `Upload to Layer` 从占位改为三步对话框（select / map / run）。
两点实现约束：

- `File` 对象存放在响应式状态之外，避免 Vue 遍历 256 MB 负载；
- 进度分两半：客户端 0→0.5（哈希、票据、上传、校验、入队），服务端
  `0.5 + job.Progress * 0.5`。

Ready 后调用 `selectDataset(outcome.datasetVersionId)`，复用既有 reload 机制完成
「自动添加图层」，不新增第二条加载路径。

### 3.1 板块模型下拉与 ByteStream 传输

下拉原先调 `UserPlateModelInvoker.Display`，这是一个**在浏览器里必然 400 的调用**：
`UserPlateModelModule` 声明了
`[RPC(RequestContentType = ByteStream, ResponseContentType = ByteStream)]`，请求体是
单个名为 `_stream` 的 ViSerializer 二进制表单字段，而 `packages/api-client` 的
`rpc-client.ts` 只会发 JSON。这是已发布代码里的真实缺陷，本轮修掉。

替代方案是在 JSON 传输上新增 `TimeMachineIngestModule.DisplayIngestPlateModels()`，
返回 `PlateModelIngestOptionRO`（ID / Name / Author / AgeStart / AgeEnd /
`PlatePolygonCount` / AccessRange）。选它而不是教客户端第二套线格式，是因为向导只
需要「能不能用来分配 plate ID」这一个判据。`PlatePolygonCount === 0` 的模型会在
Worker 侧失败，所以前端直接不列出。

## 4. 已知问题

### 4.1 manifest 里的 30 天签名 URL（已修复 2026-08-01）

旧行为：worker 把 `datasets[0].url` 写成 `OssAssistant.GetReadURL(path, now + 30 天)`
的绝对签名 URL，固化进不可变 manifest，30 天后必然过期但 manifest 永久保留。

现行为：manifest 只存**稳定相对路径**（wgp 文件名即内容 MD5 + 扩展名，与 manifest
同 OSS 目录）；读取侧通过新增的 `SystemOpenAPI.GetManifestAssetURL`
（`ManifestAccessToken` + `RelativePath` → 短期可读 URL）动态换发。

- 契约：`SystemOpenAPIModule` 新增 `GetManifestAssetURL(string, string)`，
  MetaMaker 已重新生成（二次运行 `new=0, changed=0, same=1839, deleted=0` 幂等）；
- Service：`SystemOpenAPIService.GetManifestAssetURL` 验证 manifest token 后，把相对
  路径限制在 manifest 所在目录内（拒绝 `/` 开头、`..`、`\` 归一化后的越界），
  用 `OssAssistant.UrlDuration`（1 小时）签发；
- 路径拼接逻辑抽到 `OssAssistant.TryResolveManifestAssetPath`，ContractTests 新增
  fixture 覆盖正常拼接与四类逃逸拒绝；
- Web：`cloud-client.resolveSelectedRuntimeUrls` 额外透传 `pointManifestAccessToken`，
  `main.ts` 加载点时用 `GetManifestAssetURL` 换 URL，不再直接拼绝对 URL；
- live acceptance 已验证：新 manifest `datasets[0].url` 为纯相对路径、换发 URL 可读
  WGP1、四类逃逸在真实 Server 上全部返回 InputError（Code=800）。

`PointIngestContract.DatasetURLDuration` 已不再被引用，保留为兼容常量并标注 DEPRECATED。

### 4.2 本地验收环境（已解除）

原先记录的两个阻塞都已处理：

1. `launchSettings.json` 的 `local-acceptance` profile 现在带
   `ASPNETCORE_ENVIRONMENT=Development` 与 `TIMEMACHINE_LOCAL_OSS_ROOT`，
   `LocalFileOss.Enabled` 为 true（用户已明确授权改配置）。该后端仅在 Development
   下启用，`/dev_local_oss/read|write` 只认签名过期 token，不得进生产。
2. 不再需要 seed `plate_model_version`。PlateModel 通过既有接口自举：
   `FileParseOpenAPI.ParseGPML`（真 multipart：`GpmlFile` + `RotFile`，响应是
   ByteStream 二进制）拿到 `PlateModelTO` 字节，原样拼进
   `UserPlateModel.Create` 的 ByteStream 请求体。落库 PlateModel ID=1，
   471 features / 505 polygons / 1516 rotation sequences，无一条直写 SQL。

调 ByteStream RPC 时的三个坑：`ViEnum32<T>` 在 JSON 边界上是 `{"Value": n}` 而非裸数字；
ByteStream 响应外层是 `int32 Code` + packed-length UTF-16 `Message` + `Data`；
presigned PUT 必须显式带 `Content-Type`，否则 ASP.NET 会把裸 body 当表单解析。

## 5. 验证结果

| 项目 | 结果 |
| --- | --- |
| `npm test -- --run` | 17 files / 85 tests passed（含 2 个默认 skip 的 live 用例） |
| `npm run build` | 成功，220.52 kB JS / 49.42 kB CSS |
| `npx tsc --noEmit` | 无错误 |
| `dotnet build DPlanet/Server/Server.sln` | 成功，0 warning / 0 error |
| ContractTests | 6 个 fixture section 全部通过 |
| GeneratorCli 二次运行 | `new=0, changed=0, same=1838, deleted=0`（幂等） |
| 本地端到端验收 | 已通过，见 5.1 |

### 5.1 本地端到端验收（已执行）

对真实运行的本地 Server（`--launch-profile local-acceptance`，MySQL 3307/`d_planet`）跑完整链路：

| 环节 | 结果 |
| --- | --- |
| PlateModel seed | ID=1 PALEOMAP，471 features / 505 polygons / 1516 rotation sequences |
| CSV 上传 | 174231 bytes，md5 `0d91d4a4d09910eb992a6f4c0ef14aa7` → OssFile 1 → PUT `/dev_local_oss/write` → complete |
| Job | ID=1，stage `done`，Status Succeeded |
| DatasetVersion | ID=1 Ready，5000 行，0.0–539.99 Ma |
| manifest | `basePointCount=5000 maxPlateId=992 validityPolicy=source_intervals`；`source.plateModelId=1` / `plateModelName="PALEOMAP PlateModel"` |
| 质量 | accepted 5000 / rejected 0 |
| Plate 分配 | `dplanet-static-partitioner` v1，assigned 4870 / unassigned 130，208 个唯一板块，0.058s |
| 活跃曲线 | `datasets[0].activeCountsByIntegerMa` 恰好 1101 项，peak 37 |
| `.wgp` | 100064 bytes = 64 + 5000×20，header magic/version/stride/maxTimeDeciMa 全部匹配；record[0] ` | xyz | =1.000000` validFrom 2440 validTo 2398 plateId 102 occurrences 3 |
| 发布（3E） | `PublishDatasetVersion(1, Public)` → AccessRange Public，`DisplayPublicDatasetVersions` 返回该版本且 manifest token 可用 |

浏览器传输层由 `src/phase3/live-acceptance.test.ts` 覆盖：它直接用
`RPCInvoker` + 生成的 invoker（也就是浏览器实际走的那条路）打真实 Server，
默认 skip，`TIMEMACHINE_LIVE_ACCEPTANCE=1` 时执行，用来锁住 ByteStream/JSON
传输这类只在线上才暴露的问题。

C# fixture 覆盖：WGP1 头部逐字节断言、记录偏移、单位向量、deci-Ma 取整与 clamp、
1101 项活跃曲线、8 行 CSV 的四类拒绝原因计数、缺列、仅坐标的永久有效、20° 方格
板块判定、嵌套板块、以及 ingest 请求的规范化/哈希确定性/上传守卫。

Web 新增测试覆盖：RFC 1321 MD5 向量与 55/56/57/63/64/65/119/120/128 padding 边界、
流式与单缓冲一致性、分隔符探测、引号内分隔符与双引号转义、截断行丢弃、列名猜测、
以及 `validateSourceFile`/`validateMapping` 的前置守卫。
