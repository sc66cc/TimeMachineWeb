# Terra Antiqua 地形工具链调研与 PaleoDEM 吸收方案

> 状态：文献 / 源码核读完成；获准原型增量已在 `prototypes/paleodem-editor` **实现并完成本轮测试 / CDP**。文档阶段的“已批准、待实现”记录予以保留为历史，不把当时文档改写成早已交付。已完成父级最终浏览器复核；验收限定于合成 DEM 原型，不代表地质精度验证。  
> 产品行为以[英文功能 PRD](./paleodem-editor-functional-prd.md)及其[中文版](./paleodem-editor-functional-prd.zh-CN.md)为准；[历史 PRD](./paleodem-editor-prd.md)保留原决策记录。  
> 研究目的：用地质任务解释工具，而不是把 QGIS 插件整体移植到网页。

## 1. 证据、版本与适用边界

### 已核实的事实

- Terra Antiqua 是 QGIS 插件：把已恢复到目标地质年龄位置的地形、水深及地质约束组合成古地形 DEM，再作区域修改和修整。板块位置恢复依赖 GPlates 等外部准备，不是 Terra Antiqua 自己完成的板块运动求解。[S01][S02]
- 本次官方 QGIS 插件页快照列出的最新稳定版为 **1.1**，发布日期为 2022-02-18，兼容栏为 QGIS **3.10.0–3.99.0**；仓库 `metadata.txt` 也为 1.1。部分手册页仍标注 Version 1.0，不能据此假定所有网页都严格对应同一发布包。[S03][S04]
- 已完整核读 **4 个主要工具 + 9 个辅助工具**的官方文字捕获，以及 Introduction、Preliminary Steps、Primary / Secondary tools、How-to 和首页。手册叙述与实现冲突时，下文分别列出，不把网页公式直接当作数值真相。
- 源码核对限定于仓库观察到的提交 `eb80ed3b46195babf66d2d6ca6b51b54c6ed0d42` 的 `core/standard_proc.py`，重点为冰负载补偿、海平面及年龄—水深计算。该提交不是经本次运行验证的 v1.1 发布包；未安装或运行 QGIS 插件。[S05]
- README 许可证为 **GPL-3.0-or-later**。本项目只吸收交互和方法思想、独立实现；不复制插件源码。将来如直接移植或分发其代码，先做许可证审查。[S04]

### 不应外推的结论

本证据包没有核实后续版本（包括任何 2.0 宣传）的可用能力，本文不将其列入已证实功能。合成 **96×54** 栅格上的可操作原型，也不等于具有真实 NetCDF I/O、地质精度、生产级性能、多源数据配准或板块旋转能力。

地质例子仅帮助理解工具，不代表这些地区的某一古高度、岸线或冰量已被证据确定。所有年龄、位置、海陆分布和高度假说都应有独立地质依据。

## 2. 地质学家如何理解这条工具链

可以把 DEM 看作每个网格单元记着一个高度的地形底稿：正值在海平面以上，负值在以下；**NoData 是未知，不是 0 m，也不是海洋**。掩膜相当于“只修改这片区域”的透明模板。计算能把假说变成连续的表面，却不能替代化石、沉积相、古高度或构造证据。

标准工作顺序是：

```text
确定目标年龄、证据与板块位置（外部 GPlates / GIS）
  → 编合陆地基岩、海洋水深、必要时的冰面
  → 根据古岸线多边形约束海陆
  → 优先修改仍有参考价值的既有地形
  → 仅为缺失的山系 / 海盆生成假设地形
  → 补小空洞、修接缝、适度平滑
  → 检查海陆边界、值域、NoData 与差异，保留来源及参数
```

这不是强制向导。官方 How-to 明确每个工具可独立使用；修一处接缝不必重做整张全球重建。[S01][S06]

## 3. 四个主要工具

### 3.1 地形 / 水深编合 — Compile Topography / Bathymetry

- **用途：** 把分散的陆块地形、海洋水深和可选冰面拼成目标年龄的一张工作底图。[T01]
- **输入 / 前置：** 已恢复到同一目标年龄位置的栅格；明确叠置顺序；可选大陆块多边形及其对应栅格。先核对栅格大小、分辨率、CRS 和空间对齐，不应把“能够叠加”理解成自动配准。
- **改变什么：** 列表上方栅格覆盖下方重叠值。可用大陆掩膜去掉不应穿透到陆块间隙的底层海深，并在边界建立 NoData 缓冲带；之后需要补洞或岸线处理。
- **地质例子：** 复原安第斯多个陆块后，块间裂缝可能漏出底层深海值；大陆掩膜可避免山系中出现并无地质根据的深海窄缝。
- **局限：** 叠置顺序会改变结果；遮去伪影留下的空白不是已恢复的古地形。手册操作作用于整份文件，局部工作需要外部裁切或后续 Copy/Paste。不能恢复被俯冲地壳，也不是板块旋转引擎。

### 3.2 古岸线约束 — Set Paleoshorelines

- **用途：** 让 DEM 的海陆分布符合有地质依据的古岸线多边形。[T02]
- **输入 / 前置：** DEM 和目标年龄的闭合岸线多边形；可依据海陆相化石、沉积记录和文献修订，引用旧岸线时须核对旋转模型与年龄。
- **改变什么：** 多边形**内部出露、外部淹没**。插值方式先移除与海陆约束冲突的值，再用邻近值填回，并把岸界固定于多边形周缘；也会处理 NoData。重缩放方式把待出露值映到 `0.1 m` 至指定最大值，把待淹没值映到指定负深度至 `-0.1 m`。
- **地质例子：** 某陆缘有海相化石，底稿却显示为正高程；用修订岸线使其变成浅海，而不是仅在旧岸边画一道凹槽。
- **局限：** 插值可能丢失原有纹理或产生岸边伪影；重缩放不填既有空洞。手册作用于整份文件。岸线多边形本身的可信度决定约束可信度。
- **与本项目的关键区别：** 现有线状 Coastline 只是**海岸抬升 / 降低（Coastal Uplift / Lowering）**，对线附近施加相对 `ΔE`；地貌选取中的“海岸线”也只是选择现有边界。二者都不是 Set Paleoshorelines。

### 3.3 区域地形 / 水深修改 — Modify Topography / Bathymetry

- **用途：** 保留可用地形的空间形态，同时让高度或深度符合古地质假说。[T03]
- **输入 / 前置：** DEM、区域多边形；目标最小 / 最大值或数学表达式。参数可逐多边形来自属性表；只处理选中的多边形是可选项。
- **改变什么：** 多边形栅格化为作用域，在其中线性重缩放既有值，或按用户公式修改。不同类型区域可分次执行，上次结果成为下次输入；近海区通常先约束古岸线。
- **地质例子：** 古高度和热年代学支持某山系在目标时代较低，可把现有山系的高度区间压低，保留山脊、沟谷的相对格局，而不是全区压成同一平面。
- **局限：** 高度变换不自动重建构造史或改变山系位置；异常极值影响缩放；可能改变海陆符号或形成边界接缝。无可信原地形时，缩放不会创造新证据。原型本次只吸收线性 rescale，不引入任意公式执行或矢量属性驱动。

### 3.4 合成山系 / 海盆 — Create Topography / Bathymetry

- **用途：** 对已消失、不能借用现代地形的地貌，构造参数受控的假设表面。[T04]
- **输入 / 前置：** DEM、封闭多边形；山系的最低 / 最高高程、崎岖度和坡宽，或海盆的深浅范围、陆架深度 / 宽度、陆坡宽度等。
- **改变什么：** 在多边形内放置随机点，依据距边界的距离赋高度 / 深度，再插值成连续表面。海盆参数塑造浅陆架与深盆；宽山体配窄山坡可形成高原状表面。默认擦除原有值；可选择保留更高山地 / 更深海域以与外部地貌衔接。
- **地质例子：** 沉积证据指示已消失的内海，可以在证据限定的范围内构造浅陆架—陆坡—盆底，用不同参数比较可接受假说。
- **局限：** 多边形各边受到类似处理，容易生成封闭、对称且人工感较强的地貌；不是神经网络生成，也不是构造 / 侵蚀过程模拟。官方建议优先 Modify，尽量保留真实地形复杂性。原型已有 Peak、Ridge、Lake Basin、Mountain Region 等独立工具，但并不复现 Terra Antiqua 的完整生成器。

## 4. 九个辅助工具

### 4.1 去除伪影 — Remove Artefacts

- **用途：** 局部清理来源或插值引入的异常尖峰、深坑和拼接错误。[T05]
- **输入 / 前置：** DEM、现场绘制的一个或多个多边形，以及“哪些值是伪影”的条件；手册例子 `H>2500` 指定局部超过 2500 m 的值，`NoData` 则只处理空值。
- **改变什么：** 仅在多边形内按条件移除值；可保留为空白或立即从邻近值插值。掩膜默认临时，可选择保存，以便复核。
- **地质例子：** 拼接线上出现一列异常深坑，圈定接缝再清理，避免误删真正的海沟。
- **局限：** “异常”由人定义，不能把极高山峰或海沟自动当错误。临时掩膜较难复现；插值可能再次造伪影。原型本次没有新增按条件擦为 NoData 的完整工具，不能用 Fill NoData 冒充去伪影。

### 4.2 整理区域掩膜 — Prepare Masks

- **用途：** 把分散的区域边界整理成可重复使用、互相有明确优先级的工作范围。[T06]
- **输入 / 前置：** GPlates / GIS 导出的多边形或多段线图层、优先顺序、分类名称。
- **改变什么：** 将线多边形化，修复无效几何，合并成一个 shapefile；上层掩膜裁去下层重叠部分，新增 `category` 属性保留来源分类。
- **地质例子：** 把山系、盆地和陆缘研究区整合；对重叠区先约定哪个区域假说优先，避免同一位置重复修改。
- **局限：** 几何有效不代表地质边界正确；顺序决定被裁去的范围。本项目当前栅格选区只是作用域类比，不具备 shapefile 导入、拓扑修复或属性表合并。

### 4.3 补空洞 — Fill Gaps

- **用途：** 给小型缺测空洞补上有明确方法来源的高度，而不是把未知一律当海平面。[T07]
- **输入 / 前置：** 带正确 NoData 标记的 DEM；可选区域多边形；选择插值或固定值。
- **改变什么：** 固定值方式填入指定值；插值方式用 GDAL 的反距离加权（IDW），让较近有效邻居贡献更大。可处理全图或限于多边形；还可附带平滑，区域限制也约束该平滑。
- **地质例子：** 陆块复原后两块之间留下窄空隙，周围地形连续时可局部插值，并检查是否产生人为山脊。
- **局限：** 空隙有时代表变形或俯冲丢失的地壳，并非普通缺测；大海盆不宜凭四周地形“补”出，应借助证据重建。原型的有界确定性 IDW 为独立实现，不声称与 GDAL 数值等价；本次平滑是独立操作，不偷偷附加到补洞结果。

### 4.4 冰负载均衡补偿 — Isostatic Compensation

- **用途：** 为暖期冰量减少给极区基岩一个简化回弹估计。[T08]
- **输入 / 前置：** 空间对齐、已恢复到目标年龄位置的冰面与基岩 DEM；移除冰量百分比；可选极区掩膜。自动找极区依赖掩膜的 `NAME` 字段和名称匹配，不是自动识别冰盖。
- **改变什么：** 先用冰面减基岩估算正冰厚，再按移除比例抬高基岩。不会输出新的冰厚或冰面图。
- **地质例子：** 比较暖期南极保留较多冰与较少冰的地形假说，先在同一基岩底图上估算失去冰负载后的抬升量。
- **局限与公式核对：** 手册文字说约三分之一，公式写 `0.3` 且百分比归一化不清楚。核读源码实际使用 **`ΔE = 0.3 × max(冰面−基岩, 0) × 移除百分比 / 100`**，不把负冰厚变成沉降；缺值不贡献补偿。[S05，L711–L729] 例如正冰厚 1000 m、移除 50%，简化抬升为 150 m，不是 15000 m。这不是随时间演化的冰后均衡调整（GIA）模型，没有黏弹性地幔、时间滞后或完整海平面反馈。

### 4.5 区域平滑 — Smooth Raster

- **用途：** 减轻修改区或合成地形边缘的过陡接缝，让高度过渡较连续。[T09]
- **输入 / 前置：** DEM、可选区域掩膜；均值或高斯滤波；平滑尺度。手册中的 smoothing factor 为像素半径，可从多边形属性读取。
- **改变什么：** 用局部邻域加权平均替换中心值；均值同权，高斯更重视近邻。半径越大，细地形越容易被抹平。
- **地质例子：** 合成山系与原有低地之间出现刀切式台阶，局部平滑接缝后检查山脊、河谷是否仍合理。
- **局限：** 可能削峰填谷、移动岸线。Terra Antiqua 的“固定古岸线”会按提供的岸线重新施加海陆约束，手册给出约 `-5…0 m` / `0…5 m` 的近岸重缩放；如果创建地形后岸线已经变化，旧多边形会覆盖新意图。Fill Gaps 附带平滑不提供该固定岸线选项。原型本次改为默认同海陆符号的局部均值，不复刻这一岸线重设步骤，也不借平滑填 NoData。

### 4.6 海平面升降 — Set New Sea Level

- **用途：** 在既定地形上试验相对于海平面的垂直偏移。[T10]
- **输入 / 前置：** 正高程向上的 DEM 和海平面变化量（m）。
- **改变什么：** **海平面上升为正：`E_new = E_base − seaLevelRise`**。正值使陆地相对变低、海底相对变深；负值相反。源码也是对有限值减去 shift，不是加高程。[S05，L753–L788]
- **地质例子：** 假定海平面上升 100 m，则原 `E=50 m` 的位置变为 `-50 m`，原 `-200 m` 的海底变为 `-300 m`。
- **局限：** 是垂直基准情景变换，不计算沉积、侵蚀、盆地沉降、连通海水漫灌或冰—海水体积耦合；NoData 仍未知。局部应用只能称区域相对基准情景，不能称全球一致海平面变化。

### 4.7 海洋年龄推算水深 — Calculate Bathymetry

- **用途：** 用海洋岩石圈随年龄冷却加深的简化关系，估计目标时代的海底基础水深。[T11]
- **输入 / 前置：** 已恢复到目标时代位置的海洋地壳年龄栅格、年龄数值的参考时代、目标重建时代（Ma）；“栅格摆在哪里”与“年龄相对哪一时代计”必须区分。
- **改变什么：** 先校正海底在重建时的年龄。例如以现今为参考的 80 Ma 海壳，重建到 30 Ma 时的年龄为 50 Ma；若输入已经相对 30 Ma 计龄则不要再减 30。
- **地质例子：** 为目标时代的洋中脊附近及较老洋壳建立不同的基础水深，随后结合海台、海山等独立资料修订。
- **重要冲突：** 手册显示 `Od = 2620 - 330 * Oa`，与核读实现的符号、平方根和老龄平台均不一致，**不能作为本项目正确公式直接抄入**。该源码对正的输入年龄减去 `重建时代 − 年龄参考时代`，仅为校正后正年龄计算 `E = -2620 - 330 × sqrt(age)`；`age > 90 Ma` 时置为 `-5750 m`，非正校正年龄不生成有效水深。[S05，L798–L827] 这是所检查实现的行为说明，不是对该模型科学正确性的背书。
- **局限：** 手册叙述提及保留海山 / 海台，但核读函数只读取年龄栅格，不读取现代水深残差；不能据此保证保留这些地貌。单靠年龄也不能恢复已经消失的洋壳。本次不实现该工具，后续需先确定年龄模型、NoData、零龄边界、残差资料及科学校验方法。

### 4.8 同位置栅格复制 — Copy / Paste Raster

- **用途：** 把可信区域重建的数值嵌入另一张地图。[T12]
- **输入 / 前置：** 源栅格、目标栅格、区域掩膜；手册要求相同大小和分辨率，使用前还应核对空间对应关系。
- **改变什么：** 把掩膜内源值写到目标栅格的**相同地理位置**，不是移动或旋转地貌。
- **地质例子：** 将某区域精细古地形成果嵌入同年代全球底图，再检查接缝。
- **局限：** 不提供跨年代板块迁移。本项目已有 `Copy From Previous Age` 是独立产品流程：在目标年龄发起拉取、保留已有目标工作、形成独立分组；当前仍是模拟。不能借 Terra Antiqua 的同位置复制证明本项目已有真实跨年龄栅格复制。

### 4.9 地图配色 — Change Map Symbology

- **用途：** 让高度、水深和异常更容易被人辨认。[T13]
- **输入 / 前置：** 待显示的栅格及色带；支持插件预置色带或自定义 `.cpt`，其首行 `#` 后注明名称。
- **改变什么：** 改变颜色映射，不改变 DEM 的高度值；“看起来更陡”不代表地形真的变陡。
- **地质例子：** 用分层色带看陆架深浅，用以零为中心的差异色带检查一次抬升或降低的影响。
- **局限：** 配色不能修复数据，也不能验证地质合理性。原型保留现有海陆配色和 Difference；本次不增加 `.cpt` 导入或新的制图输出格式。

## 5. 吸收到 PaleoDEM 的现在 / 以后矩阵

文档阶段“本次新增”曾指**已批准待实现**。本轮已在合成 DEM 原型中实现标注为新增的四项操作及地貌选取 / Quick / 地形工具命名；“保留”仍指既有原型契约，不表示对未改行为做了新的科学验证。仅吸收下表范围，不安装 Terra Antiqua 或新增 GIS 依赖。

| Terra Antiqua 能力 | 本次吸收 / 保留 | 后续能力与依赖 |
| --- | --- | --- |
| Compile Topo/Bathymetry | 说明多源叠置、先核对来源的工作方法 | 多源栅格导入、对齐、优先级与大陆掩膜；本次不放假运行按钮 |
| Set Paleoshorelines | 明确与地貌选取、线状海岸抬升 / 降低的区别 | 真实古岸线多边形、栅格海陆约束及可靠插值 / 重缩放 |
| Modify Topo/Bathymetry | **新增区域重缩放 / Regional Rescale**；保留 Set Value / Add Offset | 矢量属性驱动、任意公式及多掩膜优先级 |
| Create Topo/Bathymetry | 保留有名称的 Peak / Ridge / Valley / Canyon / Barrier / Lake Basin / Mountain Region；先修改后合成的原则 | 更完整陆架—陆坡—海盆模型、约束资料与科学验证；不声称生成器等价 |
| Remove Artefacts | 保留手动选区、数值编辑 / Blend Seam，并可配合本次 Fill NoData | 按条件擦为 NoData、保存伪影掩膜等完整流程 |
| Prepare Masks | 以栅格 Selection 作为显式作用域；新增 DEM 地貌选取并用 Quick 手工修边 | 矢量导入、多边形化、拓扑修复和属性合并 |
| Fill Gaps | **新增空洞填补 / Fill NoData**：固定值、独立有界确定性 IDW | 大空白区证据驱动重建、真实数据尺度与质量评估；不自动附加平滑 |
| Isostatic Compensation | 解释方法与百分比公式冲突，不执行 | 已对齐冰面 / 基岩、移除量、极区掩膜及模型审查 |
| Smooth Raster | **新增区域平滑 / Regional Smooth**：有界局部均值、默认保护海陆符号、不填洞 | 高斯 / 物理尺度和真实岸线约束；不自动套旧岸线 |
| Set New Sea Level | **新增海平面升降 / Sea-level Shift**：`E_new = E_base − rise`，范围可见 | 与冰量、沉降等耦合模型另行定义，不由简单偏移暗含 |
| Calculate Bathymetry | 记录手册 / 源码差异，不执行 | 海壳年龄及参考时代、消失洋壳资料、残差地貌与科学模型选择 |
| Copy/Paste Raster | 保留目标年龄发起的 Copy From 模拟，不改变其语义 | 真实同位置栅格复制、空间一致性检查；跨年龄迁移另需旋转数据 |
| Change Map Symbology | 保留现有配色 / Before / After / Difference / Split 检查 | `.cpt` 导入及扩展制图能力 |

### 按用户任务组织“地形工具 / Terrain Tools”

- **选定 / 定义区域：** 单网格选择、地貌选取（山脉 / 沟谷 / 海岸线）、快速选择、多边形、表达式。
- **修改既有地形：** 设置数值、叠加偏移、区域重缩放、海岸抬升 / 降低、海平面升降。
- **生成缺失地貌：** 山峰、山脊、山谷、峡谷、屏障、湖盆、山地区域。
- **修复 / 检查：** 空洞填补、区域平滑、接缝融合，以及已有差异 / 统计 / 值域检查入口；不新增技术测试面板。

将当前工具箱的 Algorithms / Processing / Tools 文案统一为 Terrain Tools，包含页签、搜索、菜单、标题、空结果及帮助；不是把所有无关 “Tool” 一词机械替换。每个条目和当前工具名都应说明地质用途，点 / 线 / 面只表达几何类型。保留现有算法 ID，不以文案改名迁移数据。46 px 图标侧栏和 100 ms 双语名称提示保持不变。

## 6. 本次实现契约与轻量工作流

### 选择与界面

- 地貌选取替代容差魔棒：从**已提交当前 DEM**以 2 格邻域的起伏 + 中心相对邻域的有符号残余找山脉（残余须 `> +阈值`）和沟谷（残余须 `< −阈值`），以有效海陆邻接找窄而连通的海岸带；不能用“高于阈值”“足够深”、全海洋或倾斜平面斜坡替代分类。确定性、有界邻域 / 敏感度，找不到时保留原选区并明确提示；NoData 不冒充地貌。它不是 AI 或科学精度保证，边界由地质人员复核。
- Quick 按画笔实际覆盖单元累加，包含任意高程与 NoData，连续两次点击取并集；移除容差 / 种子控制。稀疏指针事件间补齐笔触，跨日期变更线走最短环绕路径，极地截断。
- 通用选择保留 New/Add/Subtract/Intersect；Quick **只有 New/Add/Subtract**，独立记住模式，首次默认 Add 并保留原选区。显式 New 仅替换一个完整笔画，然后回 Add；**即使该笔画未改变掩膜也消费 New 并回到 Add**，不写多余 History。有效模式在 pointer-down 锁定，每个有变化笔画一条 History。
- Shift Add、Alt/Option Subtract 遵循 PS；Ctrl/Cmd Add 是保留的兼容扩展。Quick 组合键中 Alt 优先，不暗藏 Intersect；其他指针选择工具组合加选键与 Alt 仍为 Intersect。工具栏反映实际生效模式，keyup / blur / 换工具清除临时状态，文本框 / 对话框不触发文档快捷键。[S07]
- 选项栏**实际最左侧**先放取消选择 / Deselect、反选 / Inverse，再放当前工具和模式；Undo/Redo 可在右。保留平台快捷键和紧凑双语名称，不改成卡片或首页。

### 四个 DEM 操作的共同约束

以下数值边界经实现负责人确认，属于**原型工程契约，不是新增已获用户确认的科学模型**。具体有界半径、IDW 权重、分类敏感度由实现固定或提供受限参数，并在帮助、操作记录和测试中写清；网格尺度标为 `cells`，不得冒称 `km`。

| 操作 | 最小可验证行为 |
| --- | --- |
| Regional Rescale | 默认 Current Selection；取域内有效值 `smin/smax`，线性映到用户目标 `a/b`：`R = a + (E−smin) × (b−a)/(smax−smin)`。有限且合法的 `a ≤ b`；源值全等时阻止并指引 Set Value；NoData 不变。 |
| Fill NoData | 默认 Current Selection，只写域内 NoData。固定值填入有限目标值；插值从提交前冻结快照内的有界有效邻居作 IDW，可读作用域外邻居但不写域外。新填值不继续作为 donor；任一目标无 donor 则整次阻止，不部分提交。 |
| Regional Smooth | 默认 Current Selection；有界局部均值，读冻结快照，可读域外局部邻居但只写域内有效单元。跳过 NoData，默认仅同海陆符号邻居，`E=0` 保持 0，不补洞。 |
| Sea-level Shift | 默认明确显示 Whole DEM，允许显式选 Current Selection；对域内有效值执行 `R = E−rise`。正 rise 降低相对高程；NoData 不变。 |

共同规则：

1. 区域操作遇到空选区即阻止，不悄悄改全图；Whole DEM 只能由人明确选择。没有可改目标时提示，不写 History / outbox。
2. 使用当前已提交表面而非不可变源底图或尚未 Apply 的预览；显示工具、作用域、有效 / NoData / 改变数量及结果统计。
3. 按现有 **Preview → 检查 → 显式 Apply → Undo/Redo / 审计**执行；参数、作用域、选区或输入版本变化须刷新 / 标记预览过期。关闭 Live Preview 后保留旧预览并禁止直接应用，不自动提交。
4. 有效单元的变换保存派生 `ΔE = R−E_base`。填洞要另外记录 NoData→有效的状态变化和明确的有限填充值基准，不能计算 `R−NaN`，也不能静默把 NoData 当 0。Undo 恢复原值与 NoData 状态。
5. 参数或任一结果非法、超出 Float32 高程范围 `[-12000,12000] m`、预览过期、缺 donor 或无写入租约时，全次阻止，无部分图层 / History / outbox 写入；不自动 clamp。
6. 保留经度环绕、极地截断、源 NetCDF 只读、既有地形工具、目标侧 Copy From、派生层过期和云端 / 租约模拟边界。数据相关未来工具只解释，不做安慰性按钮。

### 原型内可以展示的简短指南

```text
选年龄并检查底图
  → 地貌选取 / 多边形定义区域，Quick 加减修边
  → 有地形：区域重缩放；小空洞：Fill NoData；缺失地貌：现有具名生成器
  → Preview 看 Before / After / Difference，确认后 Apply
  → 必要时局部平滑 / 接缝融合；海平面情景须先确认作用域和正负号
  → Undo/Redo、值域与 NoData 检查；较晚年龄按需 Copy From
```

指南应简洁、可跳过，不是强制步骤，也不把未来数据能力展示成已运行结果。

## 7. 验收、风险与待定事项

**文档阶段已做的核验（历史）：** 工具覆盖与来源核对、手册 / 源码冲突解释、双语产品契约对照、既有历史边界保留。当时未运行本增量原型，旧 Wand handoff 通过数不能作为新行为验收。

**本轮实现已记录：** 受控栅格三类地貌分类 / 孤立脊槽接受 / 倾斜平面斜坡拒绝 / NoData / 当前编辑 / 经度环绕；Quick 并集、稀疏环绕、New→Add（含未变化 New 仍回 Add）、独立三模式；最左 Deselect/Inverse 在作用域预览下刷新或标过期；地形工具命名与 1024/1280/1440 布局；四个 DEM 操作数值、空白/非法半径阻止且不静默 clamp、空选区阻止、缺 donor 原子拒绝、符号保护平滑、正海平面使 E 下降、无变化不写 History、结构化 Apply 审计（本地表面版本 ≠ 云模拟版本；有限 ΔE；填补有效性与有限 fillBase，IDW 含 donor 快照）。`node --check` 通过；原型 node 测试 46 通过 / 0 失败（Node v26.8.1）；`npm run build` 通过；专用 Chrome CDP smoke 退出码 0。固定默认值与算法 ID 见功能 PRD §17。

**不阻塞本次的剩余说明：** 邻域 / 权重 / 敏感度为网格尺度工程默认，不是科学模型。**阻塞未来能力的数据依赖：** 多源配准资料、可靠古岸线多边形、海壳年龄模型、冰面 / 基岩和科学校验集均未提供，不在合成 DEM 中假造。当前已批准范围无尚需用户选择的阻塞问题。

## 8. 来源索引

以下为实际核读的官方页面，编号对应正文。临时证据目录只用于本次核验，不应成为此文阅读依赖；公开链接和固定提交链接提供持久追溯。各工具页面的同名 `.txt` 是官方 HTML 的提取文字，已读完整正文，未把页面导航当作额外功能。

| 编号 | 官方来源 / 本地捕获名 |
| --- | --- |
| S01 | [Introduction](https://jaminzoda.github.io/terra-antiqua-documentation/Intro.html)；`Intro.txt` |
| S02 | [Preliminary Steps](https://jaminzoda.github.io/terra-antiqua-documentation/Preliminary_steps.html)；`Preliminary_steps.txt` |
| S03 | [QGIS Plugin Listing](https://plugins.qgis.org/plugins/terra_antiqua/)；`qgis-plugin.txt` 的版本 / 兼容性表；[手册首页](https://jaminzoda.github.io/terra-antiqua-documentation/) `index.txt` |
| S04 | [Repository](https://github.com/jaminzoda/terra-antiqua)；`README.md`、`metadata.txt`、`CHANGELOG.md`，下载自当时 master，版本信息与许可证已核对 |
| S05 | [固定提交 standard_proc.py](https://github.com/jaminzoda/terra-antiqua/blob/eb80ed3b46195babf66d2d6ca6b51b54c6ed0d42/core/standard_proc.py)；`standard_proc.py`，冰补偿 L711–L729、海平面 L753–L788、水深 L798–L827 |
| S06 | [How-to](https://jaminzoda.github.io/terra-antiqua-documentation/how_to.html)、[Primary Tools](https://jaminzoda.github.io/terra-antiqua-documentation/primary_tools.html)、[Secondary Tools](https://jaminzoda.github.io/terra-antiqua-documentation/secondary_tools.html)；`how_to.txt`、`primary_tools.txt`、`secondary_tools.txt` |
| S07 | [Adobe Quick Selection](https://helpx.adobe.com/photoshop/desktop/make-selections/automatic-color-based-selections/paint-a-selection-with-quick-selection-tool.html)；`adobe-quick-current.txt` 工具正文；[Shift / Alt 选区说明](https://www.adobe.com/learn/photoshop/web/add-to-subtract-from-selections)。Adobe 的三模式与沿图像边界扩展不等于本项目的 DEM 画笔覆盖并集；Ctrl/Cmd Add 不是 Adobe 标准 |
| T01 | [Compile Topo/Bathymetry](https://jaminzoda.github.io/terra-antiqua-documentation/compile_tb.html)；`compile_tb.txt` |
| T02 | [Set Paleoshorelines](https://jaminzoda.github.io/terra-antiqua-documentation/set_pls.html)；`set_pls.txt` |
| T03 | [Modify Topo/Bathymetry](https://jaminzoda.github.io/terra-antiqua-documentation/modify_tb.html)；`modify_tb.txt` |
| T04 | [Create Topo/Bathymetry](https://jaminzoda.github.io/terra-antiqua-documentation/create_tb.html)；`create_tb.txt` |
| T05 | [Remove Artefacts](https://jaminzoda.github.io/terra-antiqua-documentation/remove_arts.html)；`remove_arts.txt` |
| T06 | [Prepare Masks](https://jaminzoda.github.io/terra-antiqua-documentation/prepare_masks.html)；`prepare_masks.txt` |
| T07 | [Fill Gaps](https://jaminzoda.github.io/terra-antiqua-documentation/fill_gaps.html)；`fill_gaps.txt` |
| T08 | [Isostatic Compensation](https://jaminzoda.github.io/terra-antiqua-documentation/isostat_cp.html)；`isostat_cp.txt` |
| T09 | [Smooth Raster](https://jaminzoda.github.io/terra-antiqua-documentation/smoothing.html)；`smoothing.txt` |
| T10 | [Set New Sea Level](https://jaminzoda.github.io/terra-antiqua-documentation/set_sl.html)；`set_sl.txt` |
| T11 | [Calculate Bathymetry](https://jaminzoda.github.io/terra-antiqua-documentation/calc_bathy.html)；`calc_bathy.txt` |
| T12 | [Copy/Paste Raster](https://jaminzoda.github.io/terra-antiqua-documentation/copy_paste.html)；`copy_paste.txt` |
| T13 | [Change Map Symbology](https://jaminzoda.github.io/terra-antiqua-documentation/change_symbology.html)；`change_symbology.txt` |
