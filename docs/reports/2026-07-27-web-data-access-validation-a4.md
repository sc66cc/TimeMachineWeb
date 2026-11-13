# TimeMachine 地学数据 Web 接入与性能验证阶段报告

**日期：2026-07-27｜范围：盆地、板块运动、PBDB 点、时间图集与标量栅格**

> **结论：** Web/Cesium + Martin 技术路线已完成从“概念验证”到“可组合数据底座”的关键跨越，适合承担在线浏览、检索、分享和轻量分析主入口；Unity 不宜立即被整体替换，应保留为高端渲染、离线分析和专业工作站。两端共享同一套数据版本、manifest、瓦片服务和科学黄金值，形成“双前端、一数据底座”。

## 一、已验证成果

| 验证对象 | 关键结果 | 结论 |
| --- | --- | --- |
| 盆地与板块地图 | PostGIS → Martin MVT → MapLibre 链路打通；完成跨 180° 经线异常识别与接缝策略验证 | 矢量数据可按视口瓦片化发布，避免全量 GeoJSON |
| 球面板块重建 | 503 个多边形、649,905 个三角面、241 个 Plate ID；0–1100 Ma 时间轴；pyGPlates 黄金坐标误差控制在小数点后 8–9 位 | 刚性有限旋转、重建树、四元数与拾取链路正确 |
| PBDB 大规模点 | 275,347 行中接受 275,291 行；186 个 Plate ID；WGP1 二进制覆盖 10k–5M 点，5M 文件/GPU 顶点缓冲约 95.4 MiB，单 buffer、单 draw call | CPU 时间更新成本由点数 N 降为活动板块数 P；具备百万点扩展基础 |
| PALEOMAP 时间图集 | 90 个真实帧生成 JPEG 95、z0–z4 MBTiles（约 302 MiB）；151 个 5 Ma 节点按最近真实帧解析；4,314 次瓦片请求通过 | 时间序列不再整图打包，支持按需加载与邻帧预热 |
| 标量 Raster + CPT | 9 个栅格、8 组色带生成 PNG MBTiles（约 66 MiB）；NoData 透明；346 次请求通过，34 个透明空瓦片 HTTP 204 符合预期 | NetCDF/GeoTIFF、色带和透明区可统一进入数字地球 |
| 工程质量 | 13 个测试文件、57 项测试通过；TypeScript 与 Vite production build 通过 | 已形成可持续回归的 Web runtime，而非一次性 Demo |

**性能口径说明：** 自动化浏览器使用 SwiftShader，只能证明 5M 点、Raster 和图集链路可加载、可交互、无 WebGL 错误，不能代替目标显卡上的 FPS、P95 帧时和显存验收。

## 二、与当前 Unity 方案对比

| 维度 | Web/Cesium + Martin | 当前 Unity 方案 |
| --- | --- | --- |
| 访问与发布 | 零安装、URL 即开即用；易接入 Nginx、CDN、权限和业务页面 | 需要客户端安装、打包和升级；离线可控性更强 |
| 大数据传输 | MVT/MBTiles/manifest 按视口和时间加载，天然适合在线数据服务 | 现有全量 RPC、整幅 GZIP PNG、完整 LayerList 保存方式在大数据下压力较高 |
| 渲染与性能 | Worker + GPU buffer + shader；适合跨平台浏览，但受 WebGL、浏览器内存和 GPU 配额约束 | 原生 GPU、Compute Shader、内存控制和性能分析能力更强，适合极限规模和高保真效果 |
| 产品迭代 | Vue/TypeScript 易与搜索、目录、协作和云项目整合，部署迭代快 | 3D 交互成熟，但业务 UI、Web 分享和多端交付成本较高 |
| 科学能力 | 已验证刚性板块重建；适合标准化在线复现 | 更适合复杂桌面工作流、离线计算和后续高阶可视化；两端都尚需补充变形网络等能力 |

## 三、建议与下一步

1. **确定双前端架构：** Web 作为默认在线入口，Unity 作为专业工作站；不复制数据，通过统一 `DatasetVersion / PlateModelVersion / RasterTileSet` 引用同一资产。
2. **生产化数据平面：** 固化 PostGIS + 只读 Martin + Nginx/HTTPS + 对象存储/CDN；大文件导入改为异步 Job，发布不可变 manifest 和处理报告。
3. **完成同机 A/B 性能验收：** 在同一硬件、相同数据和相机条件下，对 Web/Unity 测试 275k、1M、5M 点与 90 帧图集，统一记录首屏时间、稳定 FPS、P95 帧时、CPU/GPU 内存和交互延迟。
4. **守住科学正确性：** 持续用 pyGPlates 黄金值校验多 Plate ID、多年代、反经线和球面接缝；复杂变形与连续时间 Raster 在服务端派生后再发布。

