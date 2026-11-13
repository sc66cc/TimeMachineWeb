# 验证报告

更新日期：2026-07-24

## TimeMachineWeb 自动化测试

执行：

```bash
npm test
```

结果：

```text
Test Files  11 passed (11)
Tests       52 passed (52)
```

覆盖内容：

- PLATES 六字段、禁用样本和 crossover 分段；
- GPML 471 个要素、503 个多边形、241 个 Plate ID；
- 全部 503 个多边形的 Cesium 球面三角剖分；
- 四元数方向、复合顺序、SLERP 最短路径；
- Cesium `modelMatrix` 与 GPlates 四元数向量公式的一致性；
- pyGPlates 黄金结果：Plate 101 的 5 个时间点；
- pyGPlates 多链路黄金结果：8 个 Plate ID、3 个时间点，共 24 组；
- WGP1 点数据、Worker 协议和 GPU 点 runtime；
- Raster/图集帧选择；
- MetaMaker RPC transport、capabilities 和 telemetry contract。

黄金坐标误差阈值为小数点后 8–9 位。

## TimeMachineWeb 构建

执行：

```bash
npm run build
```

结果：TypeScript 7 类型检查和 Vite 8 production build 均成功。

`DPlanet/` 是独立工作副本，根 Vitest 配置明确只收集 `src` 和 `packages` 下的测试，
避免扫描 Unity `Library/PackageCache` 中第三方 Jest 测试。

## DPlanet 阶段 0 验证

### MetaMaker

```bash
dotnet build MetaMaker2/GeneratorCli/GeneratorCli.csproj --no-restore
dotnet run --project MetaMaker2/GeneratorCli/GeneratorCli.csproj --no-build
```

结果：CLI 构建 0 warning / 0 error；第二次生成
`new=0, changed=0, same=1771, deleted=0`。

### Server 与 V1→V2 fixture

```bash
dotnet build Server/Server.sln --no-restore
dotnet build Server/ServiceDPlanet.ContractTests/ServiceDPlanet.ContractTests.csproj \
  --no-restore --target:Rebuild
dotnet Server/ServiceDPlanet.ContractTests/bin/Debug/net8.0/ServiceDPlanet.ContractTests.dll
```

结果：Server solution 0 error；兼容 fixture 通过。解决方案保留生产 x64 映射；
在当前 Apple Silicon 主机上单独以 AnyCPU 重建 fixture 依赖后运行。

### 生成 TypeScript

```bash
cd DPlanet/TypeScript
npm run build
```

结果：`vue-tsc` 和 Vite production build 通过。

### Unity

```bash
/Applications/Unity/Hub/Editor/2022.3.24f1/Unity.app/Contents/MacOS/Unity \
  -batchmode -nographics -quit \
  -projectPath /Users/user/Desktop/Work/CodeRepo/TimeMachineWeb/DPlanet/Unity \
  -logFile /tmp/timemachine-unity-stage0.log
```

结果：`Exiting batchmode successfully`，无 `error CS` 或脚本编译失败。

## 浏览器端到端基线

环境：Chromium headless，1440×900，WebGL/SwiftShader。

已验证：

- 首屏成功生成 503 个多边形和 649,905 个三角面；
- 0 Ma 显示 224 个活动 Plate ID、451 个多边形要素；
- 拖动时间轴到约 372 Ma 时指针和模型同步；
- 100 Ma 显示 124 个活动 Plate ID、174 个多边形要素；
- 播放、暂停、500 Ma 跳转有效；
- 点击球面可拾取 Plate 101；
- 页面无 JavaScript、资源加载或 WebGL 错误。

0 Ma 与 100 Ma 的多边形要素数比 pyGPlates 全部有效要素数少 2，差值对应两个
`gml:OrientableCurve`，不属于板块多边形渲染范围。

## 代码审查结论

- 严重问题：0；
- 阶段 0 必须修复项：0；
- 既有非阻塞告警：Server 9 个 GeoCoding DTO warning、DPlanet 管理端大 chunk、
  DPlanet TypeScript 依赖审计 12 moderate / 3 high；
- 科学范围限制：当前只实现刚性板块有限旋转，不实现变形网络、half-stage 海岭和速度场。
