# 阶段 1B：登录、在线资源与云项目版本链

更新日期：2026-07-28

状态：代码实现完成。Server 契约、生成 SDK、业务 Service、Web UI、自动化测试和
Development-only 本地验收模式均已落地；连接部署环境前仍需由运维提供 MySQL、
Redis、OSS 与真实邮件验证码服务。

## 1. 本阶段闭环

- 使用已有 `LoginMail.SendMailCode/Login` 做邮箱一次性验证码登录，不复用旧客户端的
  固定密钥密码摘要链路。
- Access Token 只放在 `sessionStorage`；刷新同一标签页可恢复登录，关闭浏览器后需要
  重新验证码登录。
- 未登录即可通过公开目录 RPC 读取 `Public/Publish + Ready` 的
  `PlateModelVersion` 与 `DatasetVersion`；登录后再追加当前用户的私有资源和最新
  `ProjectRevision`。
- Web 的 `Plate Model` 切页始终展示内置 PALEOMAP 板块模型与 PBDB 点数据；配置
  Server URL 后，同一切页会继续加载在线公开目录，不要求登录。
- 板块模型与点数据以 `resource ID + version ID` 写入项目；运行时再通过
  manifest access token 换取短期 OSS URL。
- “Save to Cloud”首次创建 `ProjectEntity + ProjectRevisionEntity`，后续保存带
  `baseRevision`。另一浏览器已写入新 revision 时返回显式冲突，不覆盖远端状态。
- “Open”下载 canonical `DocumentJson`，恢复项目名、时间、相机、图层显隐和资源
  版本，再重新加载 runtime。

本阶段没有新增业务表，使用阶段 0 已定义的五张 V2 实体表。为兼容新增的长 RPC 路由，
既有 `system__api_request_statistics_do.api` 字段从 `varchar(64)` 扩展为
`varchar(128)`；Server 启动时会由现有数据库迁移机制完成转换。

## 2. 新增 RPC

生成契约源位于：

- `DPlanet/MetaMaker2/Define/DPlanet/Module/TimeMachine/TimeMachineV2Modules.cs`
- `DPlanet/MetaMaker2/Define/DPlanet/StructResult/TimeMachine/TimeMachineV2RO.cs`

无需登录的 `TimeMachineCatalogModule` 提供：

```text
DisplayPublicPlateModelVersions
DisplayPublicDatasetVersions
```

该模块挂载在 `LoginBefore`，允许 `Role.Everyone` 访问，只返回
`Public/Publish + Ready` 的版本，不会暴露 owner 的私有资源。

登录后的 `TimeMachineWorkspaceModule` 提供：

```text
DisplayPlateModelVersions
DisplayDatasetVersions
DisplayLatestProjectRevisions
GetProjectRevision
CreateProject
SaveProject
```

登录后目录读取执行 owner/public 权限过滤且只返回 `Ready` 版本。项目写入只允许
owner；保存前使用项目 Redis lock，并在事务中更新项目快照、插入不可变 revision。

## 3. 运行配置

复制示例配置：

```bash
cp .env.example .env.local
```

然后启动 DPlanet Server 与 Web：

```bash
cd DPlanet
dotnet run --project Server/Server/Server.csproj --launch-profile http
```

```bash
npm run dev
```

Web 地址：

```text
http://127.0.0.1:5173/
```

DPlanet `http` profile 地址：

```text
http://127.0.0.1:5130/
```

Server 启动前必须已有匹配的数据库、Redis、OSS 和邮件配置。仅启动代码仓库而没有这些
依赖时，Server 会停在基础设施初始化阶段；Web 未配置 Server URL 时保持本地兼容模式：
`Plate Model` 切页仍显示内置公开数据，登录弹窗仍完整显示邮箱、验证码与操作按钮，但
按钮会禁用并明确说明需要配置 `VITE_TIMEMACHINE_SERVER_URL`。

### 3.1 本地验收模式

本地验收模式只在 `Development` 环境且
`TIMEMACHINE_LOCAL_AUTH_ENABLED=true` 时生效，固定验证码为 `123456`。点击
“Send code”仍是必需步骤，但 Server 只把验证码写入本地 Redis，不会调用邮件服务。
生产环境即使误带该开关也不会启用固定验证码。

仓库提供 `local-acceptance` launch profile，默认连接：

```text
MySQL  127.0.0.1:3307 / d_planet
Redis  127.0.0.1:6379
Server 127.0.0.1:5130
```

依赖就绪后启动 Server：

```bash
cd DPlanet
dotnet run --project Server/Server/Server.csproj \
  --launch-profile local-acceptance
```

另开终端启动 Web：

```bash
npm run dev
```

开发模式未显式设置 `VITE_TIMEMACHINE_SERVER_URL` 时，Web 会自动连接
`http://127.0.0.1:5130`，并在登录弹窗中显示本地固定验证码。验收步骤：

1. 打开 `http://127.0.0.1:5173/`，点击右上角 “Not signed in”。
2. 输入格式合法的任意测试邮箱，点击 “Send code”。
3. 输入 `123456` 并点击 “Sign in”。
4. 右上角应显示当前账户；展开账户菜单可执行 “Sign out”。

如需接入真实邮件，不使用 `local-acceptance` profile，关闭
`TIMEMACHINE_LOCAL_AUTH_ENABLED`，并提供邮件服务的生产配置。

## 4. 资源 manifest

板块模型版本的 `Manifest` 文件必须至少包含：

```json
{
  "schemaVersion": 1,
  "rotationModelUrl": "./model.rot",
  "platePolygonsUrl": "./polygons.gpml"
}
```

相对 URL 以 manifest 所在 URL 为基准。DatasetVersion 的 manifest 直接使用当前
WGP1 point manifest 格式。项目只保存版本 ID，不保存会过期的签名 URL。

## 5. 验证

本轮完成：

- MetaMaker CLI：生成成功，0 warning / 0 error；
- DPlanet Server solution：0 error，只有既有 GeoCoding/Geometry warning；
- C# V1→V2 contract fixture：通过；
- TimeMachineWeb：13 个测试文件、61 项测试通过；
- TypeScript 检查与 Vite production build：通过；
- 1440×900 浏览器 smoke：无横向溢出；未登录的 `Plate Model` 切页可见内置
  PALEOMAP/PBDB 公开卡片；登录弹窗可见邮箱和验证码输入框；
- 时间指针命中区：44×44px，从可视线外 14px 起拖仍可由 0 Ma 拖到 162.4 Ma；
- 云文档 JSON：嵌套 `Map` 会转为 JSON object，不再丢失 camera/sourceRef；
- 云 revision 的 plain JSON 可恢复资源版本、时间与图层状态。
- 本地验收模式：真实浏览器完成 Send code → 固定验证码登录 → 显示用户信息 →
  Sign out，全程无页面脚本错误。

浏览器截图：

```text
/private/tmp/timemachine-local-auth-signed-in-1440x900.png
```

生产环境上线前还需用真实邮件、OSS 与数据库执行一次登录—选模型—创建—另一浏览器
打开—并发冲突的端到端验收；本机没有这些外部配置，因此本轮没有伪造“真实线上通过”。
