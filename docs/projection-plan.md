# 多投影实施计划（尚未交付）

状态：阶段 1 数学、阶段 2 线段、阶段 3A 球面裁剪及阶段 3B 平面三角化基础已验收；运行时与 UI 开关仍未交付，当前产品仍只有 3D。本文不是新的 Canonical UI，也不能作为已完成投影切换的证明。

> **Rectangle MVP 已交付（本轮）。** `globe` ↔ `rectangle` 已可真实切换：原生
> `SCENE2D + GeographicProjection(SPHERICAL_EARTH)`、CPU 板块帧经 GPU staging/
> 验证后提交、UI 选择框与 `projection.select` 共用同一最新请求控制、plate-only
> 能力 gate 与图层 guard、mode 相关 Home 与 globe 相机恢复，均由
> `src/projection/projection-controller.ts` 与 `PlateRenderer` 的
> stage/commit/restore 实现。Mollweide、rectangle 内的点/影像层仍未实现。能力
> 边界与对外合同见 [agent-api.md](agent-api.md) 的 “Projection MVP capability
> boundaries”。本文的阶段 4–6 表格保持原样，记录尚未完成的部分（Mollweide、
> 平面 GPU 点、投影瓦片网格、真实浏览器全图层验收）。

## 范围与边界

- 支持目标：`globe`、`rectangle`、`mollweide`。
- Rectangle 指 Plate Carrée 等距圆柱／经纬矩形，不是 Mercator。
- Rectangle 优先使用 Cesium 原生 `SCENE2D` 与 `GeographicProjection`。
- Mollweide 需要自定义平面绘制；Cesium 的 2D 模式不等于 Mollweide，不能用 CSS 拉伸或替换投影对象冒充实现。
- 不修改 Server、模型数据契约或两个独立原型。板块、点、Raster/图集及拾取必须保持同一年代与投影；不默默隐藏不兼容图层后宣称成功。
- 切换视图应保留地理视点。首版投影状态暂为会话态；不能把平面相机坐标写入现有 ECEF 相机快照。
- 后续 UI 控件遵循 Canonical UI 更新流程；对应能力通过现有 Agent facade 调用，不能仅绑定 DOM 点击。

## 已核实的 Cesium 限制

1. 当前板块 Primitive 用非 identity `modelMatrix` 表示有限旋转，这条路径只适用于 3D；不能直接切模式后认为板块面已正确投影。
2. 当前 GPU 点着色器使用旋转后的球面位置，需增加平面坐标、包围体和拾取分支；不能退化为百万点 CPU 逐点更新。
3. 原生 imagery 可服务 Rectangle，但不能自动得到 Mollweide 的弯曲经线和椭圆边界；后者需投影瓦片网格。
4. Atlas 帧已属于对应古地理年代，只选帧与投影，不再套板块四元数。

## 实施顺序

| 阶段 | 产物 | 验证门槛 |
| --- | --- | --- |
| 1. 数学基础 | `map-projection.ts`、数学测试 | 正逆投影、域检查、解析控制点、等面积 Jacobian |
| 2. 球面线段 | `projected-geometry.ts` 的 segment 部分 | 短弧交点、切缝两侧、极点、源关联 |
| 3. 球面三角形 | pole 拆分、球面裁剪、平面三角化 | 无地图贯穿、保持绕序、明确不支持诊断 |
| 4. Rectangle runtime | 板块、GPU 点、原生 imagery、拾取 | 年代／图层／视角一致，无资源泄漏 |
| 5. Mollweide runtime | 自定义平面板块、GPU 点、瓦片网格与拾取 | 与控制点／已知纹理对齐，椭圆外拒绝拾取 |
| 6. UI / Agent 接线 | 投影切换、状态和动作合同 | UI 与 Agent 共用实现，真实异步完成，无假成功 |

阶段 1 已通过 23 项数学测试，阶段 2 已通过 49 项线段测试，阶段 3A 已通过 19 项球面裁剪测试；父级独立全量验证基线为 336 passed / 5 skipped。

修正逆投影数组读取、有限值断言及弧长检查后，7,500 个确定性普通短弧案例通过；负对照证明验证器能发现原先的 NaN 漏检。三角形验证另覆盖 6,038 案例：6,037 个正常案例成功，1 个吸附导致精度损失的薄面明确 `unsupported`，而非误报退化；四种检查器负对照与尺度、旋转、反向等价控制有效。

阶段 3B 已独立验收：根目录 `src/test/projected-triangle.test.ts` 的 35 项测试通过；2,041 个定向／确定性案例通过，包括 Rectangle/Mollweide、中心经线 0°/30°、正反绕序、pole/seam、两档微小跨缝与自交拒绝，四种坏结果负控仍有效。面积断言比较同一 3A piece 的线性化投影边界与输出三角形之和，不是球面面积。

共线、区间、距离去重复和面积阈值现已分离。方向采用带误差界的浮点快路径和原始 IEEE754 坐标的精确 BigInt 后备。父级另用独立二进制字符串有理数 oracle 检查 516 个数值、4,003 个方向，零失败；内存中故意恢复错误指数掩码后检出 1,667 个失败，证明负数／负零／subnormal 检查不是空转。

mesh 基础验收时父级独立全测为 385 passed / 5 skipped、类型检查通过。mesh snapshot 的 14 项测试通过，网格缓存与生命周期基础已验收：真实 GPU 分配后，live non-owning collection 中的 renderer-first 清理销毁 3 个 owned 对象、保留 external 并清空缓存；默认 owning collection 的 Viewer-first 仍正常；non-owning collection 的 Viewer-first 仅保证迟到清理两次不抛错并清空自有状态，不声称已显式销毁仍存活的 3 个对象或立即释放全部 GPU。空 hole 保持 polygonCount=1、skipped=0，三种顺序均无 renderError。几何及资源基础验收不等于阶段 4–6 已交付。

独立真实 WebGL 诊断还证明：缓存的工作副本在 3D 及原生 2D 下可渲染／拾取，GeometryInstance 构建期烘焙 30°／180° 旋转（跨日期缝）成功，GPU 处理后缓存未变；移除唯一网格后黑像素／无拾取的负控有效。这不是生产投影切换、动态年代或所有图层对齐的验收。

### Rectangle 板块准备进度（仍非完整运行时）

CPU 帧准备已通过主 Agent 验收：`plate-rectangle-frame.ts` 从 retained snapshot 构造独立工作 geometry，按 plate 保存供实例构建期烘焙的矩阵，轮廓仅旋转一次并闭环；原 Globe 同步 `updateTime` 保持。prepare 的小句柄仅表示 CPU 就绪，不是视图提交。

初版的零矩阵、最后 yield 后 abort、失败 pending controller 与 feature 跨 yield 混合有效期问题已修正。父级独立全测为 412 passed / 5 skipped、类型检查通过。真实浏览器消费生产 builder，在原生 2D 30°/180°（跨缝）控制中验证 fill 红像素、洞黑像素且不可拾取、outline 黄像素、原 feature/polygon pick、identity Primitive/PolylineCollection 和 GPU 后源缓存不变；改变实例样式变绿，隐藏后黑像素／无拾取负控有效。

另有独立预热实验：Primitive 保持 show=true、各 instance show=false，PolylineCollection 保持 show=true、各 line show=false，可分配资源且不改变旧画面；切换 flags 显示新帧后可恢复旧帧。此实验不是生产 staging/commit 的验收。当前唯一 writer 正实现板块 GPU staging/commit/restore；GPU 点／拾取方案并行只读分析，main/UI/Agent 投影开关仍未接线。

## 数学合同

输入经纬度单位为 degree，平面坐标为 metre，球半径复用 `EARTH_RADIUS_METRES = 6371000`。

- 普通 `project(absLon, lat)`：减中心经线后归一化，再投影。
- 新增 `projectRelative(relativeLon, lat)`：经度闭区间 `[-180, +180]`，**不再归一化**。切出的 `+180` 顶点必须保留在右边界，不能翻到 `-180`。
- 非有限值与非法纬度明确拒绝；逆投影域外返回 `null`。
- Mollweide：`2θ + sin(2θ) = π sin φ`，`x = 2√2R/π · Δλ cos θ`，`y = √2R sin θ`。公式中的 `φ`、`Δλ`、`θ` 均使用 radian，接口负责 degree 转换。
- 精确极点输出 `x=0, y=±√2R`；逆投影极点经度不唯一，返回中心经线。

## 几何合同与支持域

输入为已按目标年代旋转、上游已细分的球面网格。单位化 Cesium 带半径的位置后，再绕 Z 轴旋转负的中心经线。

首版采用保守支持域：唯一短 great-circle arc，边角距小于 `π/2 − 1e-10 rad`；当前约 1° 网格满足这一条件。原始经差 340° 可以是跨缝的 20° 短弧，不应仅凭经差拒绝。

长弧、近反向点、大半球补集或极点归属不可靠时，返回带源 primitive ID 的明确诊断，不生成坏三角、不悄悄删面。非有限／零向量为 invalid，真实零面积为 degenerate。源支持域、面积和绕序必须在吸附清理前测量；若清理压平或反转非退化源面，报告 `unsupported`，不能重新定义源面为退化。洞已由上游三角网格表达，本阶段不重建任意环拓扑。

### 切分步骤

1. 先把边内／面内极点变成显式顶点，拆成保持原绕序的子面。
2. 沿完整 `y=0` 大圆分别裁剪到正、负半球。中央经线多切一次是允许的；只有 `x<0` 的交点属于反子午线。
3. 对异号端点，用 `t = a.y / (a.y-b.y)`，归一化 `(1-t)a+tb` 求短弧与平面的交点；不能线性插值经纬度。共面边单独处理。
4. 同一交点的左右副本共享球面位置，但 seam 经度分别为 `+180/-180`；索引共享边应按规范端点顺序计算以保持一致。
5. Rectangle 中，pole 在填充面边界上展开为前后边经度的两个副本；Mollweide 中 pole 收敛为同一个精确点。独立 polyline 不补 pole 水平连接线。
6. 每片最多四个有效顶点，验证边界与绕序后选合法对角线；不能靠翻转坏索引掩盖折叠。

这是对已有细分网格的平面近似，不声称自动控制所有缩放等级下的曲边误差。未支持的情形必须保留诊断供调用者处理。

## 必需控制点与回归

- 相对经度 `±180`：Rectangle 为 `±πR`，Mollweide 赤道为 `±2√2R`。
- 解析点：`lat = asin(0.5 + 1/π) × 180/π` degree、`lon = 90°` 时，Mollweide 输出 `(R,R)`。
- 线 `(170,10) → (-170,10)`：两段，交点纬度约 `10.1510817°`，两边副本纬度一致。
- 面 `[(170,0),(-170,0),(175,10)]`：各片不贯穿地图，源 ID 保持。
- seam 端点、整条 seam 边、中央经线边分别处理；独立 seam 线应有左右副本。
- `[(10,80),(40,80),(123,90)]`：Rectangle 极点经度取相邻边界 10/40，而非任意输入 123。
- `[(0,89),(120,89),(-120,89)]` 及其南极版本：检出内部极点；Rectangle 顶边／底边覆盖整条边界，绕序保留。
- 中心经线 30°、反向绕序、近 seam 容差、退化和不支持输入均需测试。

## 最终验收仍需完成

真实浏览器在多个年代验证所有可见图层对齐、拾取、显隐、透明度、Home、播放、加载期间切换和切回 3D；重复切换不持续累积资源。保留大点集 GPU 路径，并将功能正确性与真实硬件性能结论分开。
