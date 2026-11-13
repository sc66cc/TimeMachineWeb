# 阶段 2：图层管理、点在线加载与自定义可视化

更新日期：2026-07-28

状态：已完成。

## 1. 完成范围

- 左侧图层卡片由 `ProjectSession` 的有序状态生成，支持搜索、显隐、透明度和拖拽；
- 提供 `Data layers` 与 `Reconstruction` 完整图层组，支持折叠、组级显隐、
  组级透明度、组内排序和跨组移动；
- 组透明度与子图层透明度相乘，组显隐不覆盖子图层自己的开关状态；
- 保持 Canonical UI 的紧凑卡片，样式控制只在当前选中图层下展开；
- Atlas、单幅 Raster、GPU 点和板块面均接通组/层运行时状态；
- Atlas 与 Raster 的拖拽顺序同步为 Cesium imagery layer 叠放顺序；
- DatasetVersion 选择解析版本化 manifest，项目只保存
  `resource:dataset-version:<id>`，不复制点数据；
- 图层与组编辑立即保存本地草稿；已有云项目时，900 ms debounce 后保存新 revision；
- 云端 `baseRevision` 冲突继续由阶段 1B 的乐观锁链路显式报告。

## 2. 项目模型与图层组

`ProjectSession` 是图层顺序、组归属、显隐、透明度、样式和资源引用的客户端真源。
Vue 只通过窄事件契约提交用户编辑，`main.ts` 负责更新状态、驱动 Cesium runtime、
保存本地草稿和调度云 revision。

生成的 `ProjectDocumentV2TO` 继续作为云项目契约：

- `LayerList` 数组顺序保存全局叠放顺序；
- `ProjectLayerTO.PathTreeNodeID` 保存组归属；
- `LayerPathTree.ChildList` 保存组名称、显隐和透明度；
- `ProjectLayerTO.Active` / `Alpha` 保存图层自身显隐和透明度；
- 折叠状态和 point style 进入受控的 `LegacyExtensions`；
- 旧的无组本地草稿和云项目会迁移到默认组。

本阶段没有新增 Server Entity、数据库字段或 RPC。

## 3. 声明式点样式

点样式采用受限且可序列化的 `PointStyleExpression`，只允许：

- 颜色：Plate ID、单值、occurrence 分级；
- 大小：固定像素、occurrence 驱动；
- 形状：圆、方；
- 过滤：Plate ID、最小/最大 occurrence；
- 受边界约束的点大小、比例和十六进制颜色。

解析器采用白名单、数值钳制和颜色校验。任意 JavaScript、未知字段和恶意颜色不会进入
项目状态。样式修改只更新 shader uniform，不重新 fetch、解析或创建点缓冲。

`GpuPointRenderer` 保持一个交错 GPU buffer 和单 draw call，在 shader 中完成：

- Plate ID → 四元数纹理查找；
- 球面旋转与时间有效性；
- 字段过滤；
- 颜色、点大小、形状和图层透明度。

## 4. 点数据生命周期与拾取

- Worker 支持 `AbortSignal`；取消加载会终止 worker 并返回 `AbortError`；
- `PointDatasetCache` 提供 128 MiB 默认容量的 LRU，命中时复用已校验的
  `ArrayBuffer`；
- 卸载先立即隐藏 draw command，随后在下一帧和空闲阶段释放 GPU/worker 资源；
- WGP1 的数组下标即稳定 row ID，拾取 worker 只返回最近 row ID；
- 主线程命中后只解码该 row 的 20 字节记录，不把整个点集变为 Vue 对象；
- 当前未切空间瓦片的 WGP1 资产在 500k 点以内启用拾取；更大压力集明确关闭拾取，
  等待后续空间索引，不执行主线程全量扫描。

## 5. 验证

- TypeScript 与 Vite production build：通过；
- Vitest：14 个测试文件、68 项测试通过；
- 1440×900 Chrome 图层组验收：
  - 组折叠刷新后保持；
  - 组透明度 42% 写入并恢复；
  - 关闭组显隐时子图层自身开关保持；
  - 点图层跨组移动到 `Reconstruction`，顺序和归属刷新后保持；
  - 页面脚本错误为 0；
- 点 runtime 与云项目回归：
  - 10k 点加载、GPU 样式更新和 row ID 拾取通过；
  - 275k 点在 100 Ma 保持 275,000 个可见点，时间交互无页面脚本错误；
  - 两阶段卸载后重新加载命中 LRU；
  - cloud revision 从 r1 自动保存到 r2；
  - 第二浏览器基于旧 revision 编辑时明确报告冲突且未覆盖 r2；
  - 页面脚本错误为 0。

验收截图：

```text
/private/tmp/timemachine-phase2-groups-1440x900.png
/private/tmp/timemachine-phase2-complete-1440x900.png
```

本机没有启动 Atlas/Raster 的 Martin 瓦片服务，因此相关 tile proxy 返回 502；这不影响
本阶段板块、点、项目、图层组和云 revision 验收。

## 6. 下一阶段

下一步进入阶段 3：数据上传、解析和发布。开始前应先确定 OSS 分片直传、Processing
Job 状态机、worker 部署方式及发布权限边界；任何数据库或生成实体变更必须先完成
MetaMaker 定义与 migration 评审。
