# 投影运行时接线合同（规划，未实现）

本文整合场景／板块／GPU 点与 Raster 两份独立源码方案，记录主 Agent 的裁定。它不是已交付功能报告。当前产品仍只有 3D；几何阶段进度见 [projection-plan.md](projection-plan.md)，UI 与结构化动作语义见 [projection-ui-spec.md](projection-ui-spec.md)。

## 执行约束

- 复用既有 Server 和数据，不改后端／生成契约／数据库，不接两个独立原型。
- 用户本轮不允许临时隔离副本；共享工作区保持一个生产源码写入者。
- 当前平面三角化实现与后续运行时／UI 规划可并行；设计、测试、审查可独立推进。源码接线按依赖和文件所有权串行交接，不能互相覆盖。
- 主 Agent 核对实际文件、独立重放反例与测试，再决定验收和下一步；子代理的完成声明不等于验收。

## 已裁定的公共语义

| 项目 | 合同 |
| --- | --- |
| 模式 | `globe`、`rectangle`、`mollweide` |
| Rectangle | 原生 `SCENE2D` + `GeographicProjection(SPHERICAL_EARTH)` |
| Mollweide | `SCENE3D` 承载自建正交平面；不注入任意 `scene.mapProjection` |
| 平面轴 | `(depth, projectedEast, projectedNorth)` |
| 单位／半径 | metre；复用 `EARTH_RADIUS_METRES` |
| 中心经线 | 首版固定 0；数学基础可测试其他中心，经 UI 开放另行处理 |
| 生命周期 | 同一个 Viewer；保留原始点 VBO、模型数据与常驻 Raster controller |
| 持久化 | 首版投影为会话态，不改项目 DTO；平面相机绝不写成 ECEF 快照 |
| 对外动作 | 计划使用 `projection.select`，不另设 `view.setProjection` 别名 |

### 计划中的 Agent 合同

以下尚未注册，不能当作当前可调用接口。

- `projection.select({projectionId})`：与 UI 共用同一实现，验证模式枚举与当前可见层能力。
- Promise 在核心视图提交后结算；不能只启动切换便返回已完成。
- `getState().projection` 区分 requested／committed 模式、revision、准备／就绪／失败状态及可用模式原因。
- 显示请求年代与实际已提交年代；板块与点不能长期处于不同年代。
- source／view revision 过期的结果不提交；取消要结算旧 Promise 并销毁 staging，不能永久 pending。
- 模式不兼容时明确返回 unsupported，保留已提交视图，不悄悄隐藏可见层来伪装成功。
- 远程影像瓦片可能继续加载，需单独显示 loading/error 与实际显示帧；视图切换成功不等于所有瓦片已到齐。

## 场景宿主负责的接口

内部名称可按现有代码收敛，但语义归属必须唯一：

- 统一维护 `ProjectionState {id, centralMeridianDeg:0, revision}`。
- `setProjection()`、Home、地图 XY 与 scene 位置转换、屏幕射线与平面求交／逆投影。
- 统一分配显示深度和透明混合／depth-test/write 规则。Raster、fill、outline、point 不得各自发明 epsilon 高度，也不能只依靠 collection 插入顺序。
- 保留既有大类顺序：Raster 在底、plate fill、outline、point 在前；Raster 业务层内部继续遵循现有顺序。若要改变跨类型排序语义，须另行验证，不能在投影实现中悄悄更改。
- Mollweide 原生 Primitive 的平面 depth 保持正值，避免将地图原点作为无效的三维零向量；具体 band 和 near/far 精度由宿主集中实现并做像素验收。
- 只在 globe 启用自定义旋转惯性；平面使用平移／缩放。切换时取消旧 flight/momentum，返回 globe 恢复之前的地理视点。

## 板块：先保留网格，后接视图

现有 Primitive 使用 `releaseGeometryInstances:true`，不能从已提交 primitive 恢复 CPU 网格。

1. 模型构建时保留独立、只读的 positions、indices、feature/polygon/plate 关联和轮廓；提交给 Cesium 的数组不能与缓存共用，因为其管线会修改属性和位置。
2. 不在每个年代重新运行 PolygonGeometry 剖分，不重新解析 GPML 或下载模型。
3. globe 保留原 quaternion/modelMatrix 快路径。
4. Rectangle 的 Primitive 本身必须 identity。可用 GeometryInstance 的构建期 matrix 烘焙旋转，再由原生管线做 IDL/Geographic 转换；修改已建 instance matrix 不是动态时间更新。
5. Mollweide 消费已旋转网格与阶段 3B；按原 polygon 合批并保留 PlatePick，不把每个 piece 拆成独立 draw call。
6. 当前球面 graticule 也必须纳入 renderer 所有权与销毁／模式显隐；Mollweide 轮廓不能走自动球面弧生成。
7. CPU 准备合并连续年代请求，只提交最新完整 frame。记录 V/T/T′、准备／提交时间、上传字节与峰值内存，不凭推测承诺 FPS。
8. 确定性释放 GPU 资源须先 `renderer.destroy()`、后 `viewer.destroy()`。Viewer/Scene 已销毁时，迟到清理只清 renderer 自有状态／缓存引用，不再调用可能引用失效 shader/VAO 的 primitive destructor；不保证这些 primitive 的 `isDestroyed()`、全部 GPU 资源已显式释放或立即回收。Cesium Context 销毁不等于浏览器原生 WebGL context 丢失；不能用吞异常或改私有 shader 字段伪装完整释放。

## GPU 点与拾取

- 保留 20-byte interleaved VBO、Plate ID → quaternion texture 和样式过滤。模式只改 uniforms／包围体，不逐点 CPU 重写原始坐标。
- shader 先旋转单位球坐标，再按模式得到 sphere 或平面坐标；高纬／近极点必须对照 CPU 控制点，不能假定有限次 float 迭代等于 CPU 二分求根。
- 纬度计算应考虑 `atan(z, length(xy))` 的稳定性；近极点 `asin(z)` 和 `sin(latitude)` 的 float 精度需专门验证。
- 平面包围体来自平面范围，不继续使用球心／R 包围球。
- 拾取仍保留 ≤500,000 resident points 限制；平面按冻结的 scene→clip 矩阵、viewport、CSS 像素半径排名，不用角距离冒充屏幕距离。
- 模式、年代、过滤、显隐变化使旧 pick 无效；ellipse 外拒绝拾取。
- 数据上传期间切模式后，ready 结果必须应用最新 mode/time/style/visibility。初始化就绪与显示要区分，不能用会跳过 update 的 `show=false` 把 ready Promise 挂死。

## Raster／图集

### 原生 Rectangle

- 场景投影改 Geographic，但已有 manifest/XYZ 继续用 WebMercatorTilingScheme；不能把 1×1 根网格误换为 Geographic 的 2×1。
- 现有瓦片仅覆盖 ±85.0511287798066°，源注册范围写 ±90°不代表瓦片有极区数据。
- 父级真实 WebGL 控制已确认首个可见 imagery 的 base-layer 边缘拉伸：覆盖 ±85.0511287798066° 的合成 WebMercator 根瓦片在 88° 仍显示边缘颜色；先放全域透明底层后，80° 数据不变而 88° 保持无数据，GL/renderError 均为零。后续 native adapter/host 应在业务 imagery 之前安装全域、无网络的透明底层保护，业务排序／显隐不能把它移走。证据来自诊断 fixture，不代表产品 adapter 已接入或真实图集已端到端验收。

### Mollweide 自定义影像

- 复用当前 manifest／XYZ URL，不建立新投影瓦片服务。
- 在源 WebMercator tile 的 `(s,t)` 参数域生成／细分网格，按 Mercator 反算 lon/lat 后投影，UV 仍为原 tile 坐标；只翻转一次 Y。
- 3B 的 XY-only triangles 不是 imagery backend，缺少 UV、tile ownership 和误差协调，不能直接拿来贴图便宣称可靠。
- 中心经线 0 下保留 ±180 两侧，coverage/PNG alpha/204 empty 均正确处理；极区无数据不拉伸补齐。
- 几何细分与纹理 LOD 分开。遵守各 source min/max；父子 fallback 同区域只能贡献一次，避免透明度加深。
- 细分需共享边界策略，不能制造 T-junction；达到最大分辨率允许模糊，不制造细节。

### controller 规则

- source 变化更新内容 generation，mode 变化只更新 presentation epoch。
- 不因 mode 重新 setTime/select，不重建 controller，不把 Atlas 再套板块四元数。
- 完成中的 source 请求绑定最新 view；过期 mesh/GPU 结果检查两种代际。
- Atlas 保留现有 220ms 过渡和邻帧 warming，Single 保留直接替换，不把新增 crossfade 假称为已有能力。
- 请求合并／取消／内存上限须明确；native provider 的暂缓 `undefined` 不是空 tile，204 才是已就绪的 transparent-empty。
- TileStore/native adapter 重构是待裁定实施方案，不是现有能力。先交付 Rectangle 垂直切片不应无故被完整缓存框架重写阻塞。

## 文件所有权与推进顺序

这些是独占写入范围，不是同时抢写同一工作区的许可。

| 所有者 | 范围 |
| --- | --- |
| 几何 | 当前 `projected-triangle.ts` 及测试；验收后冻结 |
| scene/plate | projection runtime、mesh retention、PlateRenderer、相关测试 |
| GPU/picking | point renderer、picker/worker、数值对照测试 |
| Raster | raster-runtime backend/controller 与专门测试 |
| app integrator | main、AppShell、actions、公开 exports、Canonical 同步 |

优先在几何验收后交付原生 Rectangle 垂直切片，再接 Mollweide 所需的自建平面和影像。UI 可明确展示尚未实现的能力，但不能启用后返回假成功。

## 主 Agent 验收门槛

- 读取真实文件／差异，不以子代理汇总代替结果；核对工具与模型实际分配、修改范围与未测试项。
- 现有测试不退化；新增测试运行生产函数，不用复制的测试替代实现。
- 性质验证器先检查形状和 finite，再比较，并用已知坏结果负对照证明检查可触发。
- 真实浏览器验证控制点、pole/seam、NoData、图层顺序／透明度、拾取、Home、保存相机和三模式循环。
- 验证剖分仅随模型加载增加，点 VBO 上传不随 mode 增加；请求／GPU／监听器不会持续泄漏。
- 延迟旧帧、切时间／mode、取消／加载失败后，只显示最新合法提交，不长期混年代，不抹掉原已提交画面。
- 当前私有模型端到端仍需原账号权限，不读数据库摘要冒充用户、不改资源为公开来过测试。
