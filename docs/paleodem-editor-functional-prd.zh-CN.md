# PaleoDEM Editor — 功能 PRD

语言 / Language：简体中文 · [English（权威版本）](./paleodem-editor-functional-prd.md)

> 本文为古地理图编制模块（Paleogeographic Map Authoring Module，UI 名称：**PaleoDEM Editor**）权威功能规格的完整中文版；如有歧义，以英文版为准。  
> 决策 / 历史记录：[`paleodem-editor-prd.md`](./paleodem-editor-prd.md)（D-001–D-033）。  
> 运维交接：[`paleodem-editor-handoff.md`](./paleodem-editor-handoff.md)。  
> 对标准 UI（Canonical UI）的影响：无。不得修改 `docs/ui-reference/canonical/index.html`。  
> Terra Antiqua 调研与吸收边界：[中文调研报告](./paleodem-terra-antiqua-research.zh-CN.md)。

**增量状态——原型实现已在本轮验证。** 地貌选取、Quick 画笔覆盖并集 / 三模式、最左侧选区操作、具名地形工具及四个有界 DEM 操作已在 `prototypes/paleodem-editor` 实现，并由 §14 证据覆盖。文档阶段曾标注 **已批准、待实现（approved pending implementation）**；该历史状态仅被本原型增量的实现记录取代，不把当时文档改写成“早已交付”。未改变的功能保留既有契约。历史 D-001–D-033 保留原记录，不重写。已完成独立的父级浏览器复核；此为原型验收，不是地质精度验证。

## 1. 产品目标与非目标

**目标。** 让地球科学研究人员能够在规则经纬度（lon/lat）栅格上，以类似 Photoshop 的选区交互和类似 QGIS 的参数设置，选择 PaleoDEM 网格单元、编辑数值并生成地形；同时保持源 NetCDF 只读，并确保每次提交都可预览、可撤销、可审计。

**非目标（首个版本 / 本原型）。**

- 通用矢量 GIS 或 Photoshop 图像合成。
- 编辑多个变量，或在同一画布上加载多个年龄的栅格。
- 考虑拓扑关系的板块重建。
- 多用户协同编辑。
- 替代 TimeMachineWeb 的 3D 地球。
- 在 HTML 原型中实现真实 NetCDF 输入 / 输出、Worker / 瓦片增量（tile-delta）性能优化、平移 / 缩放，或可实际操作的多年龄栅格。
- 本次不实现多源编合、真正的多边形古岸线约束（Set Paleoshorelines）、年龄—水深计算或冰负载补偿；这些需要外部数据与科学审查。
- 不移植 Terra Antiqua / QGIS、不复制其 GPL-3.0-or-later 源码，也不声称合成 DEM 启发式具备 Photoshop 图像分割能力或科学 / AI 精度。

## 2. 用户与角色

| 角色 | 需求 |
| --- | --- |
| 古地理学家 / 地球科学研究人员 | 无需编写 Python，即可选择网格单元并表达山脊、山谷、湖泊和海岸线。 |
| 技术评审人员 | 检查参数，对比修改前 / 修改后 / 差异（Before/After/Difference），并复现导出结果。 |

## 3. 前置条件

- 桌面视口（≥1000 px；目标尺寸为 1440×900、1280×800、1024×768）。
- 一份 PaleoDEM 年龄文件：NetCDF-4 / HDF5，规则的 `elevation(lat, lon)` 栅格，Float32 类型，单位为 m，取值范围为包含端点的 `[-12000, 12000] m`。
- 用户已确认高程变量映射（`E` 是源变量名的别名）。
- 经度约定为 `[-180°, 180°)` 或 `[0°, 360°)`；几何统一使用 `[-180°, 180°)`。
- 原型使用合成的 96×54 栅格，不打开或写入真实文件。

## 4. 输入 / 输出契约

| 契约 | 规则 |
| --- | --- |
| 输入容器 | 仅支持 NetCDF-4 / HDF5。NetCDF-3 在解析前即被拒绝。 |
| 网格 | 规则经纬度栅格；源数据的 `row` / `col` 是网格单元的身份标识。 |
| 高程 | 向上为正；`E=0` 表示海平面。 |
| 无数据值（NoData） | 可编辑。NaN 和有限数值的 `_FillValue` / `missing_value` 都属于 NoData。 |
| 地形 | 保存相对高程变化量 `ΔE`；`E_new = E_base + ΔE`。有限结果变换采用 `ΔE = result − E_base`；NoData 填补须有明确有限基准值及有效性状态变化，不能对 NaN 做减法（§7.8.2）。 |
| 合成 | 只读源数据 + 有序的编辑图层（Edit Layers）+ 选区掩膜。 |
| 导出 | 写入新的 NetCDF 副本；绝不静默覆盖源文件。原型仅校验设置。 |
| 项目 | 本地 `.pdemproj` 快照 + 云端变更记录。原型对两者均采用模拟实现。 |

## 5. 术语表

| 术语 | 含义 |
| --- | --- |
| 网格单元（Cell） | 一个栅格单元（`row`、`col`）。 |
| 选区（Selection） | 作为一等对象的掩膜。通用选择为 New / Add / Subtract / Intersect；Quick 仅有 New / Add / Subtract。 |
| 常驻模式（Persistent mode） | 记住的工具栏模式；Quick 独立保存状态，一次性 New 笔画完成后返回 Add。 |
| 临时模式（Transient mode） | 修饰键临时覆盖，不改写常驻模式。已经锁定的手势保留 pointer-down 时的模式。 |
| 地貌候选（Landform candidate） | 从已提交当前表面推断出的连通 DEM 地貌掩膜，不是满足高程容差的区域。 |
| 画笔覆盖并集（Brush footprint union） | Quick 所有笔刷印章覆盖单元的集合，包含任意高程及 NoData，不按相似度扩张。 |
| 实时预览（Live Preview） | 自动生成非破坏性的地形预览；仍须显式执行应用（Apply）。 |
| 从之前年龄复制（Copy From Previous Age） | 在目标年龄中，从较早年龄拉取内容；Apply 绝不向其他年龄推送内容。 |
| 写入租约（Write lease） | 云端最多允许一个写入方。租约状态不确定时，会改变项目的操作均为只读。 |

不要翻译变量名、单位、坐标参考系（CRS）ID 或算法 ID（`E`、`lon`、`source_lon`、`m`、`km`、`EPSG:4326`、`NetCDF-4`、`ΔE`）。

## 6. 功能清单

1. 数据集 / 年龄 / 变量 / 经度设置。
2. 选区工具：单网格选择（Cell Select）、地貌选取（Landform Select：山脉 / 沟谷 / 海岸线）、快速选择画笔（Quick Selection Brush）、按多边形选择（Polygon Select）、按表达式选择（Select by Expression）。
3. 通用四模式选择、独立的 Quick 三模式选择、临时修饰键，以及最左侧取消选择 / 反选。
4. 直接数值编辑（Direct Value Editing）：设置数值（`Set Value`）、叠加偏移（`Add Offset`）。
5. 具名地形工具（Terrain Tools）：保留山峰、山脊、山谷、峡谷、屏障、接缝融合、海岸抬升 / 降低、湖盆、山地区域；新增区域重缩放（Regional Rescale）、空洞填补（Fill NoData）、区域平滑（Regional Smooth）、海平面升降（Sea-level Shift）。
6. 实时预览（Live Preview）与应用（Apply）。
7. 图层（Layers）、历史（History）、差异 / 修改前 / 修改后 / 分屏视图（Difference / Before / After / Split View）。
8. 从之前年龄复制（Copy From Previous Age）。
9. 导出校验。
10. 云端同步与写入租约模拟。

## 7. 功能定义

每项功能均说明用途、入口、前置条件、行为、可见反馈、结果和例外情况。

### 7.1 选区运算模式

- **用途。** 以 PS 风格控件将候选掩膜与当前选区组合，并保留已明确要求的 PaleoDEM Ctrl/Cmd 兼容扩展。
- **入口。** 上下文选项栏的模式按钮，或在指针选择工具激活时按住修饰键。
- **前置条件。** 已激活 Cell Select、Landform Select、Polygon Select 或 Quick Selection Brush。按表达式选择在 Select 时使用通用常驻模式，不使用指针修饰键。
- **行为。** Cell / Landform / Polygon 及表达式选择保留 New / Add / Subtract / Intersect。Quick **仅显示 New / Add / Subtract**，独立记住状态（§7.4）。除已经锁定的手势外，修饰键覆盖常驻模式：

  | 按住的按键 | Cell / Landform / Polygon | Quick |
  | --- | --- | --- |
  | Ctrl/Cmd **或** Shift，未按 Alt | Add | Add |
  | Alt/Option | Subtract | Subtract |
  | Ctrl/Cmd+Alt **或** Shift+Alt | Intersect | Subtract——Alt 优先，不暗藏 Intersect |
  | 无 | 通用常驻模式 | Quick 常驻模式 |

  Adobe 文档记载 Shift Add、Alt/Option Subtract；Ctrl/Cmd Add 是产品扩展，不是 PS 标准。组合键 Intersect 扩展绝不应用于 Quick。参见 [§12](#12-adobe-引用)。
- **可见反馈。** `is-active` / `aria-pressed="true"` 显示实际生效模式；手势中即使按键变化，也显示已锁定的模式。松键、窗口失焦、换工具清除临时状态；没有锁定手势时恢复相应常驻模式。Quick 与通用工具互切不能覆盖彼此记住的模式。名称及修饰键提示紧凑、双语、中文优先。
- **结果。** 掩膜组合可撤销；只有掩膜改变才产生选区 History 命令。修饰键不改写常驻状态。
- **例外。** 文本框及已打开对话框不触发文档快捷键或选区临时模式；keyup 仍可清除残留状态。仅在选区工具激活的编辑画布上阻止上下文菜单，不全局拦截。macOS Ctrl-click 仍执行 Add，但 Quick 同时按 Alt 时执行 Subtract。

### 7.2 单网格选择（Cell Select）

- **用途。** 选择一个网格单元，包括 NoData。
- **入口。** 在工具侧栏选择单网格选择（`C`），然后点击画布。
- **前置条件。** 工具已激活。
- **行为。** 点击时按当前实际生效模式选择该单元。状态栏显示 row、col、lon/lat 和 `E`。
- **可见反馈。** 高对比度叠加显示；状态栏；历史条目 `单网格选择 / Cell Select`。
- **结果。** 将仅包含一个单元的候选掩膜与当前掩膜组合。
- **例外。** 忽略非主按钮事件，但 macOS Ctrl-click（button 2）除外，仍执行 Add。

### 7.3 地貌选取（Landform Select）

- **用途。** 根据 DEM 地貌特征选择既有地貌的边界候选。这是替代容差魔棒的实际行为，不是只改名称。
- **入口。** 工具侧栏地貌选取（`W` 与 Quick Selection 循环切换）；选山脉 / Mountains、沟谷 / Valleys 或海岸线 / Coastlines 后点击。
- **前置条件。** 使用**已提交当前 DEM**，包含已 Apply 编辑，不用未应用 Preview，也不只用不可变源数据。显式展示或说明有界邻域 / 敏感度及连通性；网格尺度参数标为 `cells`，不是 `km`。
- **行为。** 确定性地判断合格单元，返回所点击地貌处的连通候选，再按 §7.1 组合：

  | 类别 | 必须具有的区分依据 | 不得替代为 |
  | --- | --- | --- |
  | 山脉 / Mountains | 局部起伏，外加中心相对邻域均值为**正**且超过正向阈值的有符号残余 | 全部高值、高而平的高原内部，或倾斜平面梯度 |
  | 沟谷 / Valleys | 局部起伏，外加中心相对邻域均值为**负**且低于负向阈值的有符号残余 | 全部低值、无区分的深海，或倾斜平面梯度 |
  | 海岸线 / Coastlines | 相邻有效海陆单元形成的窄连通边界带，并明确零高程边界处理 | 整片海洋、陆地内部或把 NoData 边缘当海岸 |

  邻域在经度方向环绕、极地行处截断，不一次选出全图所有彼此不相连的合格地貌。Shift / Ctrl/Cmd 可添加另一个候选，Alt/Option 减去本次点击候选。用 Quick Add / Subtract 手工修正不确定边界。
- **可见反馈。** 当前类别名称、启发式 / 合成数据限制、候选 / 已选数量；必要时显示 `未找到匹配地貌 / No matching landform`。不声称科学或 AI 精度。
- **结果。** 每次点击仅在掩膜改变时写一条 History；不修改 DEM。同一已提交输入和设置产生同一候选。
- **例外。** 无合格候选或点击 NoData 时，即使 New 模式也保留原选区，不写 History。NoData 仍可由 Cell / Quick / Polygon / 表达式选择并编辑。组合未改变掩膜时提示 `选区未发生变化 / Selection did not change`。这既不是地形生成，也不是真正古岸线约束。

### 7.4 快速选择画笔（Quick Selection Brush）

- **用途。** 涂出画笔覆盖范围的精确并集，包含任意高程与 NoData，用于创建或修正选区。
- **入口。** Quick Selection Brush（`W` 循环切换）；点击或拖动。`[` / `]` 改 Size；移除 Tolerance / 种子 / 相似度控件。
- **前置条件。** Size 有效。Quick 独立记住 New / Add / Subtract，与通用四模式工具互不影响。**首次使用默认 Add，保留任何既有选区。**
- **行为。** 每个笔刷印章包含其覆盖的所有单元；在稀疏 pointer move 之间插补印章，保证笔触无洞；跨日期变更线走最短环绕路径，极地截断。Add 下两次点击 / 笔画得到 `S_new = S_old ∪ footprint_1 ∪ footprint_2`，第二次不能替换第一次。Subtract 只减去涂到的单元。显式 New 仅以一个完整笔画的覆盖范围替换选区，然后回 Add；临时 Add / Subtract 不得先清空旧掩膜。不允许暗藏 Intersect。
- **可见反馈。** 画笔光标半径与实时选区；工具栏显示**pointer-down 锁定、整个笔画不变的实际模式**，拖动中按键改变也不改操作。完成后显示当前适用的临时 / 常驻模式，松键恢复记住的模式。
- **结果。** 有变化的完整笔画只写一条 History，不按印章拆分；Undo/Redo 恢复整个笔画的掩膜变化。切走再回来仍记住 Quick 模式，不改通用状态。
- **例外。** 空 / 未变化笔画不写 History。Quick 的含 Alt 组合键始终 Subtract。画笔覆盖并集是用户指定的 DEM 适配，不是 Photoshop 图像边缘分割算法（§12）。

### 7.5 按多边形选择（Polygon Select）

- **用途。** 选择中心点位于多边形内的单元。
- **入口。** 按多边形选择（`L`）；点击添加顶点；Enter / 双击完成；Backspace 删除最后一个顶点；Esc 取消。
- **前置条件。** 至少有 3 个顶点才能完成。
- **行为。** 第一个顶点锁定该多边形的实际生效模式。在 `±180°` 附近对经度进行展开处理。产品规定支持按住空格平移，但原型未实现平移。
- **可见反馈。** 预览边线；顶点数量。
- **结果。** 完成时写入一条历史记录。
- **例外。** 少于 3 个顶点时显示轻提示，不执行选择。

### 7.6 按表达式选择（Select by Expression）

- **用途。** 类似 QGIS 的布尔表达式选择。
- **入口。** 表达式工具（`F`）或地形工具（Terrain Tools）。
- **前置条件。** 可用字段为 `E` / 已映射变量、`lon`、`source_lon`、`lat`、`row`、`col`、`is_nodata`。
- **行为。** 先校验（Validate），再选择（Select）。使用通用工具栏常驻模式，不使用 Quick 状态或指针修饰键。
- **可见反馈。** 语法状态、数量预览、错误信息。
- **结果。** 根据常驻模式替换或组合掩膜。
- **例外。** 无效表达式不改变掩膜。

### 7.7 直接数值编辑（Direct Value Editing）

- **用途。** 为选中单元设置数值或叠加偏移。
- **入口。** 选区非空后进入数值工具（`E`）。
- **前置条件。** 持有写入租约；选中数量 > 0；结果位于 `[-12000, 12000] m` 范围内。
- **行为。** `Set Value` 会填充 NoData。`Add Offset` 使用已声明的 NoData 基准值策略（原型使用局部有效邻居的均值）。预览 / 应用时显示数量与统计信息。
- **可见反馈。** 受影响数量；被阻止时的轻提示；编辑图层 01（Edit Layer 01）的操作数量。
- **结果。** 一次可撤销的编辑；新增一条待同步的云端发件箱（outbox）记录。
- **例外。** 超出范围或租约为只读时，不写入历史，也不写入图层。

### 7.8 地形工具与既有地形生成

- **用途。** 保留既有几何驱动地形功能，按地质任务组织，不只显示无具体名称的点 / 线 / 面控件。命名 / 组织变更已在原型工具箱实现。
- **入口。** 山峰（Peak，`P`）、当前具名线状地形（`G`）、当前具名面状地形（`A`）或地形工具 / Terrain Tools。几何仍是参数 / 工具族，当前名称和提示须写明实际地质操作。
- **前置条件。** 生成器几何已就绪（点；线 ≥2 个顶点；面 ≥3 个顶点）。Apply 需要写入租约。§7.8.2 四个作用域 DEM 操作不要求绘制几何。
- **行为。** 既有流程：绘制 → 参数 → Preview → 检查 → Apply，且**仅当前年龄**。保留 Peak；Ridge / Valley / Canyon / Barrier / Blend Seam；Lake Basin / Mountain Region。既有线状 Coastline 准确命名为**海岸抬升 / 降低 / Coastal Uplift / Lowering**：对线附近局部施加相对高程变化，**不是**多边形定义的 Set Paleoshorelines。既有几何宽度 / 半径继续用考虑纬度的 km；新增网格邻域如用单元尺度，必须明确 `cells`。
- **可见反馈。** 地质名称、预览统计、范围警告、After/Before/Difference/Split。显示名称变化不改变既有算法代码 ID。
- **结果。** 在 Edit Layer 01 上执行 `E_new = E_base + ΔE`，一条 History 命令，不向其他年龄传播。
- **例外。** 几何 / 参数无效、Preview 超范围或过期、只读租约，均禁用 Apply 且不写 History。

#### 7.8.1 具名地形工具目录

将当前**与工具箱有关**的 Algorithms / Processing / Tools 文案统一为**地形工具 / Terrain Tools**，覆盖页签、搜索标签 / 占位文案、菜单、标题、空结果和帮助。不要机械改名无关的 Tool properties。保留紧凑双语条目、中英文地质名称搜索、展开 / 重置行为和既有稳定算法 ID。新增操作在实现时分配稳定的带版本 ID，不因文案改名虚构数据迁移。

| 用户任务组 | 具名条目 / 既有检查入口 |
| --- | --- |
| 选定 / 定义区域 / Select / Define Region | 单网格选择 / Cell Select；地貌选取 / Landform Select；快速选择 / Quick Selection；多边形选择 / Polygon Select；按表达式选择 / Select by Expression |
| 修改既有地形 / Modify Existing Relief | 设置数值 / Set Value；叠加偏移 / Add Offset；区域重缩放 / Regional Rescale；海岸抬升 / 降低 / Coastal Uplift / Lowering；海平面升降 / Sea-level Shift |
| 生成缺失地貌 / Generate Missing Features | 山峰 / Peak；山脊 / Ridge；山谷 / Valley；峡谷 / Canyon；屏障 / Barrier；湖盆 / Lake Basin；山地区域 / Mountain Region |
| 修复 / 检查 / Repair / Check | 空洞填补 / Fill NoData；区域平滑 / Regional Smooth；接缝融合 / Blend Seam；既有 Difference / 统计 / 值域检查，不新增技术测试面板 |

简短可选指南：定义区域 → 修改可用地形 → 只生成缺失地貌 → 修复 / 检查。不做强制向导、首页 / 卡片重设计，也不为多源编合、真正 Set Paleoshorelines、年龄—水深计算或冰补偿放假按钮。[调研报告](./paleodem-terra-antiqua-research.zh-CN.md)解释全部 13 个 Terra Antiqua 工具、来源冲突及现在 / 以后依赖。

#### 7.8.2 四个有界 DEM 操作

**共同契约。** 输入为已提交当前合成 DEM，不只取源值，也不取未 Apply 的 Preview。区域工具默认**当前选区 / Current Selection**；该范围为空时阻止，绝不悄悄回退到整幅栅格。区域工具的**整个 DEM / Whole DEM**必须显式选用；Sea-level Shift 默认明确显示 Whole DEM，也可显式选 Current Selection。Apply 前始终显示范围 / 选中目标数量。没有合格或有变化目标时提示，不改变 History / outbox。

以下数值边界是**实现负责人确认的原型工程契约，不是用户已确认的科学模型**。有界半径、IDW 权重、分类敏感度须固定 / 受限，并在帮助、操作参数及测试中说明。网格距离 / 半径标为 `cells`，不能标为 `km`；物理尺度处理与科学验证留待后续。

| 操作 | 输入与确定性结果 | 校验 / 限制 |
| --- | --- | --- |
| 区域重缩放 / Regional Rescale | 处理域为范围内有效单元，源极值 `smin/smax`，有限目标 `a ≤ b`；`R = a + (E−smin) × (b−a)/(smax−smin)` | 目标上下限及结果位于 `[-12000,12000] m`。源全等值（`smin = smax`）时阻止并指引 Set Value。NoData 不变；海陆符号可能变化，须检查。 |
| 空洞填补 / Fill NoData——固定值 | 有限目标值；只对范围内 NoData 写该值 | 有效单元及范围外单元不变，提交前校验值域。 |
| 空洞填补 / Fill NoData——插值 | 独立的有界确定性 IDW：`R = Σ(w_i E_i)/Σw_i`，正反距离权重来自操作前冻结快照的局部有效 donor | 可读写入范围外的局部 donor，不能写范围外。新填单元不作为后续 donor。任一目标无 donor，整次阻止，不部分填补。说明半径 / 距离 / 权重，不声称与 GDAL 等价或能重建大海盆。 |
| 区域平滑 / Regional Smooth | 从操作前冻结快照算有界局部同权均值；只写范围内有效目标，局部读取邻居可在范围外 | 跳过 NoData，绝不填洞。默认只用同海陆符号邻居；`E=0` 保持 0。本次不要求无保护模式或重新套用古岸线多边形。 |
| 海平面升降 / Sea-level Shift | 有限 `rise`，单位 m；范围内有效单元 `R = E − rise` | 正 rise 降低相对高程：`50 m − 100 m = −50 m`。NoData 保留，超范围原子阻止。局部升降是相对基准情景，不是全球一致海平面。 |

- **预览 / 应用。** 复用 Live Preview → 检查 → 显式 Apply，包括 Live Preview 关闭时保留过期 Preview。参数、范围 / 选区或已提交输入变化须刷新或使 Preview 失效。显示工具 / 范围、有效 / NoData / 改变数量及结果 / 差值统计。这些操作不以绘制几何为前提。
- **存储 / 审计。** 有效单元变换保存派生 `ΔE = R − E_base`。填补另行记录 NoData→有效的状态变化及声明的有限填充值基准，不能计算 `R − NaN` 或静默将 NoData 当 0。Undo 恢复原值与有效性，Redo 恢复相同结果。既有操作 / History 审计路径记录算法 ID / 版本、输入修订、范围掩膜、方法 / 参数及 NoData 策略。
- **原子性。** 按 Float32 有限值语义与包含端点的硬值域校验全部参数及拟提交结果。参数无效、缺 donor、Preview 过期、超范围或没有写入租约时，全部不提交：无部分栅格 / 图层 / History / outbox 写入，也不静默 clamp。一次有变化 Apply 对应一次可撤销操作及待同步云端记录。
- **边界。** 经度环绕、极地行截断；范围外单元逐位不变；源 NetCDF 保持只读。Copy From、派生层过期 / 级联、写入租约和云端 outbox 保留既有语义 / 模拟标识。不增加真实多源 I/O 或生产级 GIS 后端。

### 7.9 实时预览 / 应用（Live Preview / Apply）

- **用途。** 在不提交的情况下展示地形结果；仅在执行 Apply 时提交。
- **入口。** 工具属性中的 `实时预览 / Live Preview`（默认开启，跨地形工具保留该设置）以及 Preview / Apply 按钮。
- **前置条件。** 生成器几何已就绪，或作用域 DEM 操作具有有效显式范围 / 合格目标；参数有效。
- **行为。** 开启 Live Preview 时，完成几何或更改高度 / 宽度 / 融合 / 种子 / 剖面 / 掩膜 / NoData 基准值，都会重新生成预览，无需点击 Preview。已批准扩展：作用域 DEM 参数、范围 / 选区及已提交输入变化也须刷新或使 Preview 失效；这些工具不要求几何。Apply 仍须显式执行，且仅在预览为最新、数值在允许范围内时启用。关闭 Live Preview 时，参数变更不会重新生成预览；上一次预览保持可见，并标记为 `预览已过期 / Preview out of date`，直到通过 Preview 或 Live Preview 刷新。
- **可见反馈。** 行内预览状态；画布上的过期标记；参数输入框保持焦点。不因每次按键都弹出轻提示。
- **结果。** 预览数组不破坏原数据；Apply 才写入工作高程面。
- **例外。** 自动预览超出范围时，显示违规情况，并保持 Apply 禁用。

### 7.10 图层 / 历史 / 差异（Layers / History / Difference）

- **用途。** 检查合成结果、撤销操作并进行对比。
- **入口。** 停靠面板的 Layers / History 页签；画布上的 After / Before / Difference / Split View。
- **前置条件。** 文档已打开。
- **行为。** 图层自下而上求值：底部为源数据，其上依次为 Edit Layers、Selection Mask，以及可选的 Copy From 分组。派生 `ΔE` 图层可能过期；已启用且过期的图层会阻止导出。重新计算受影响项（Recompute Affected）须显式触发，并级联重算上方已启用的派生图层，整个过程具有原子性。历史列出选区操作和编辑；撤销 / 重做（Undo/Redo）会恢复栅格与选区。Difference 对比当前年龄的变化，以零为中心使用发散色带。
- **可见反馈。** 过期标记；级联顺序；当前历史行；视图模式的 `aria-pressed` 状态。
- **结果。** 评审人员可以隐藏 / 显示演示分组、撤销操作并进行对比。
- **例外。** 级联失败时，回滚所有暂存瓦片，并写入一条失败历史事件。原型的过期 / 级联 UI 为明确标注的演示，不是真实的栅格求值。尚未实现图层移动。

### 7.11 从之前年龄复制（Copy From Previous Age）

- **用途。** 在较晚年龄中，从较早年龄拉取已有工作，形成独立分组。
- **入口。** 进入 90 Ma 或 80 Ma，然后选择 `从之前年龄复制 / Copy From Previous Age`。
- **前置条件。** 当前年龄不是最古老的年龄；持有写入租约。
- **行为。** 默认来源是前一个可用年龄（允许使用草稿）。默认复制前一个年龄的全部内容；若选择部分内容，则至少选中 1 项。确认复制（Confirm Copy）会在目标年龄现有工作**上方**新增 `来自 <source> / From <source>` 分组，绝不替换现有工作。画布切换到 Difference，对比当前年龄加入该组前后的结果。来源后续发生的编辑不会改变该副本；`来源已有更新 / Source has newer changes` 仅作信息提示。查看更新（Review update）不修改数据。引入更新（Bring in update）新增 `From <source> · Latest`。使用最新版本（Use Latest）或保留当前版本（Keep Current）结束比较。
- **可见反馈。** 对话框预览；分组名称 / 状态；Difference 提示；结束比较操作栏。
- **结果。** 目标年龄获得独立快照；每次 Confirm、Bring in update、Use Latest 或 Keep Current 各产生一条历史记录 / 待同步编辑。
- **例外。** 在源年龄执行 Apply 绝不触发复制。原型不加载 90 Ma / 80 Ma 栅格。

### 7.12 导出（Export）

- **用途。** 生成新的 NetCDF-4 副本及操作清单（operation manifest）。
- **入口。** `导出 / Export`。
- **前置条件。** 不存在已启用且过期的派生图层；所有有限高程值均在允许范围内；写入路径指向新文件。
- **行为。** 默认保留源数据布局；自定义设置包括 Deflate/Shuffle/chunks。原型仅校验，不写入文件。
- **可见反馈。** 对话框；通过 / 阻止的轻提示。
- **结果。** 校验消息明确指出已映射的变量名。
- **例外。** 存在过期图层、数值超出范围或只读状态时，对话框保持关闭或阻止确认；不写入历史。

### 7.13 云端状态与权限

- **用途。** 持久化本地快照，并以单写入方模式进行云端同步。
- **入口。** 页头同步状态标记；立即同步（Sync now）；演示场景中的其他写入方租约。
- **前置条件。** 先写入本地 `.pdemproj`；云端确认后才推进修订号（revision）。
- **行为。** 已提交的编辑向发件箱加入幂等记录。级联失败不加入任何记录。Sync now 按顺序确认记录（模拟）。每个项目仅有一个写入租约，其他客户端为只读。只读时仍可使用选区、视图和 Difference。绝不显示租约令牌。
- **可见反馈。** `本机写入 / This device` 或 `只读 / Read-only`；待同步数量；修订号。
- **结果。** 仅在收到模拟确认后清除待同步记录。
- **例外。** 租约状态不确定或由其他写入方持有时，会改变项目的操作显示只读轻提示，并保留本地项目包与发件箱。不包含真实后端、凭据或锁服务。

## 8. 用户场景

1. 已批准场景：地貌选取选择山脉候选，Shift/Ctrl 加另一个，Quick Add / Subtract 修边，再区域重缩放 Preview、检查、Apply。
2. 已批准场景：Quick 两次覆盖不同高程及 NoData，取足迹并集；一次性 New 后继续 Add，或以 Subtract 减选；Undo/Redo 恢复一个笔画。
3. 绘制山脊，保持 Live Preview 开启、微调宽度，仅 Apply 到 100 Ma；保留既有具名生成器。
4. 已批准场景：选择小 NoData 空洞，使用有界 IDW 填补、检查、Apply；另行平滑接缝，不填 NoData 或改变海陆符号。
5. 已批准场景：明确检查 Whole DEM 范围，预览海平面上升 +100 m，确认相对 E 降低，然后 Apply / Undo。
6. 进入 90 Ma，从 100 Ma Copy From、检查 Difference、保留 90 Ma 现有工作。
7. 重算过期派生图层、Sync now、校验后 Export；指定为模拟的功能继续标注模拟。

## 9. 端到端工作流

```text
打开年龄 → 映射 E → 定义区域（Landform / Cell / Polygon / 表达式；Quick 修边）
  → 修改可用地形、生成缺失地貌，或修复空洞 / 接缝
  → 显式范围 + 参数 → Live Preview → 检查 → Apply 当前年龄
  → 图层 / 历史 / 差异（Layers / History / Difference）
  → 可选：在较晚年龄执行 Copy From
  → 导出副本（存在过期图层或数值超出范围时阻止）
```

地形 Apply 绝不以其他年龄为目标。跨年龄复用始终由较晚年龄执行 Copy From。指南简洁可选，不是强制向导。外部数据准备、真正古岸线约束、多源编合是记录在文档中的未来工作流，不做假执行按钮。

## 10. 交互规则

- 中文优先，英文其次。不要翻译 `E`、单位、CRS、算法 ID。
- 保留高密度 PS / QGIS 桌面工作台。纯图标侧栏保持 **46 px**，**100 ms** 后显示双语地质工具名浮层，不使用原生 `title` 或常显侧栏标签。
- 已批准选项栏顺序：**取消选择 / Deselect → 反选 / Inverse → 当前工具 → 上下文模式 / 选项**。前两项在 DOM 与视觉上均为实际最左侧，不只是右侧分组内部排第一。Undo/Redo 可留右侧。1024 / 1280 / 1440 px 下保持紧凑可读的双语名称。
- 仅在画布获得焦点时，Tab 才切换面板的显示 / 隐藏。
- 撤销 / 重做、取消选择、反选保留平台组合键：⌘/Ctrl+Z、⇧⌘/Ctrl+Z、⌘/Ctrl+D、⇧⌘/Ctrl+I。
- 文本输入框和已打开的对话框不触发文档级工具快捷键。
- 选区修饰键显示实际操作，在 keyup / blur / 换工具时清除。Quick 保留独立三模式状态，其他工具保留通用四模式状态。
- Quick 在 pointer-down 锁定模式，多边形在首顶点锁定；手势反馈反映锁定模式，不反映后续按键。
- 仅在选区工具激活时阻止编辑画布上下文菜单，使 macOS Ctrl-click 可 Add；不阻止无关页面上下文菜单。

## 11. 校验与错误状态

| 状态 | 反馈 | 数据变更 |
| --- | --- | --- |
| 选区未变化 | 轻提示 | 不写入历史 |
| 无匹配地貌 / 点击 NoData | 明确无匹配反馈 | 保留原掩膜，不写 History |
| 当前选区范围为空 / 无合格目标 | 范围 / 数量反馈，阻止 Apply | 不回退 Whole DEM，不写 History / outbox |
| 参数无效 / 重缩放源全等值 / 缺 IDW donor | 原因与修正提示，阻止 Apply | 不部分编辑，不写 History / outbox |
| 表达式无效 | 行内错误 | 不改变掩膜 |
| 预览超出范围 | 警告；禁用 Apply | 不执行 Apply / 不写入历史 |
| 直接编辑超出范围 | 轻提示说明已阻止 | 不写入历史 |
| 已启用且过期的派生图层 | 过期标记 | 阻止导出 |
| 级联失败 | 轻提示说明已回滚；失败历史记录 | 恢复操作前的缓存 |
| 只读租约 | 页头状态 + 轻提示 | 保留发件箱 |
| Copy From 未选择任何项 | 禁用确认 | 不复制 |
| 原型中切换年龄 | 轻提示说明未加载栅格 | 仅切换上下文 |

## 12. Adobe 引用

须准确表述，不得夸大：

- 魔棒工具使用技巧（New / Add / Subtract / Intersect 控件）：  
  <https://helpx.adobe.com/photoshop/using/tool-techniques/magic-wand-tool.html>
- 添加到选区 / 从选区减去（Shift 添加；Windows Alt / macOS Option 减去）：  
  <https://www.adobe.com/learn/photoshop/web/add-to-subtract-from-selections>
- 当前 Quick Selection（New / Add / Subtract；涂画沿图像边界扩展）：  
  <https://helpx.adobe.com/photoshop/desktop/make-selections/automatic-color-based-selections/paint-a-selection-with-quick-selection-tool.html>

Adobe 文档记载 Shift Add 和 Alt/Option Subtract，**没有** Ctrl Add。PaleoDEM 为兼容保留 Ctrl/Cmd Add；Ctrl/Cmd+Alt Intersect 仅限通用指针选择工具。Quick 只有三模式，组合键中 Alt 优先。其覆盖并集是用户明确指定的 DEM 适配，不是 Adobe 图像分割；地貌选取是独立 DEM 启发式，不是改名的 Photoshop Wand 算法。macOS Ctrl-click 上下文菜单例外只限选区画布。

## 13. 业务层权限与云端同步

- 源 NetCDF 只读；导出写入新副本。
- 本地 `.pdemproj` 是离线快照。
- 云端项目：修订号单调递增、发件箱记录幂等、必须获得服务端确认。
- 单写入方租约；只读方保留视图 / 选区 / Difference 能力。
- 仅限原型：明确标注为模拟，无后端，无机密信息。

## 14. 验收标准（已实现的原型增量）

下列条目是已批准的实现契约。本轮已对照它们记录原型证据。不要用旧 Wand 截图证明新行为。产品完成签收仍需父级核验。

1. 受控栅格分别证明山脉突出度（拒绝高而平的内部及倾斜平面斜坡）、沟谷凹形（拒绝均匀深海及倾斜平面斜坡）、窄有效海岸带（拒绝海洋 / 陆地内部及 NoData 边缘）。孤立山脊 / 沟槽须被接受。候选确定且连通，无匹配及 NoData 点击保留原掩膜；已 Apply 编辑影响后续分类；日期变更线连续及极地截断通过。
2. Cell / Landform / Polygon 保留 New/Add/Subtract/Intersect，表达式使用通用常驻状态。Quick 只显示 New/Add/Subtract，独立记忆，首次 Add 保留已有选区，显式 New 替换一个笔画后回 Add。
3. 两次 Quick 点击 / 拖动对不同高程和 NoData 取完整覆盖并集；稀疏移动插补无洞并走最短经度环绕；Subtract 精确。一个有变化笔画一条 History，未变化不记，Undo/Redo 恢复掩膜。
4. Shift / Ctrl/Cmd Add、Alt/Option Subtract 正确；通用组合键 Intersect，Quick 组合键 Subtract。Quick 在 pointer-down、多边形在首顶点锁定。工具栏与锁定 / 实际模式一致，keyup、blur、换工具后不残留；Quick / 通用常驻状态互不覆盖。
5. 文本框及对话框不触发文档快捷键。选区画布 macOS Ctrl-click 可操作且不弹上下文菜单；无关页面 / 非选区场景不被全局拦截。
6. DOM 与视觉顺序均把 Deselect / Inverse 放在工具 / 模式之前的实际最左侧，快捷键保留。工具箱相关文案统一为地形工具 / Terrain Tools；任务组、当前地质名称、提示、双语搜索、空结果 / 重置及既有稳定算法 ID 一致。线状海岸抬升 / 降低不得误称 Set Paleoshorelines。
7. 1024 / 1280 / 1440 px 下主要操作可读，46 px 侧栏 / 100 ms 提示稳定，高密度工作台不变，不做卡片、强制向导或未来操作假按钮。
8. 四个 DEM 操作各通过已知栅格数值、已提交当前输入、仅选区写入、空选区阻止、显式全图、NoData、经度 / 极地、参数和硬值域测试。包含全等源重缩放拒绝、固定值 / 冻结 donor IDW 且缺 donor 原子拒绝、默认符号保护平滑并保留零值与空洞、正海平面上升使 E 降低。
9. 每项操作具有非破坏性的最新 / 过期 Preview、显式 Apply、准确的值 / 有效性 Undo/Redo、派生有限差值 / 明确填补基准审计及一次有变化 Apply / outbox 记录。无效、未变化、过期或只读情况不写部分结果或多余 History / 待同步变更。
10. 保留既有地形生成、过期 Preview 留存、Layers / History / Difference、目标侧 Copy From 及结束比较、导出保护、写入租约、云端 outbox 模拟的回归。只更新明确淘汰的 Wand / 相似度 / 四模式 Quick 断言，不能悄悄删除覆盖。
11. 记录原型 app / tests 的 `node --check`、`node --test prototypes/paleodem-editor/workbench.test.mjs`、`npm test`、`npm run build` 及真实浏览器 CDP 的准确结果；不能先假定初次失败是历史问题。干净的 100 Ma After 截图展示地貌选取、多笔画选区和具名地形工具，无无关 modal / 几何 / toast 残留。实现负责人完成最终浏览器验证后才能宣称完成。

## 15. 已知原型限制

- 使用合成的 96×54 栅格；无真实 NetCDF 读写。
- 90 Ma / 80 Ma 仅作为文档上下文。
- Copy From、过期图层级联重算、云端同步和写入租约均为明确标注的模拟。
- 尚未实现平移 / 缩放、真正的图层重排、Worker / 瓦片增量（tile-delta）机制或生产级性能。
- 原生焦点行为、指针操作手感和截图需要真实浏览器；JSDOM 测试不能证明像素级结果。
- 地貌启发式与作用域 DEM 操作是合成 96×54 栅格上的网格尺度近似，不是 km 级地质模型，也不声称科学精度。固定原型默认值见 §17。
- 调研涵盖官方 v1.1 时期文档及另行标明的源码提交，不涵盖未核实后续版本。多源编合、真正多边形古岸线、年龄—水深和冰负载补偿仍为依赖数据的未来能力；当前获准原型范围没有未决的阻塞产品选择。

## 16. 来源参考

- 原型：`prototypes/paleodem-editor/index.html`、`app.js`、`styles.css`、`workbench.test.mjs`
- 决策 PRD：`docs/paleodem-editor-prd.md`
- Terra Antiqua 调研 / 全部 13 工具官方引用及公式差异：[中文调研报告](./paleodem-terra-antiqua-research.zh-CN.md)
- Terra Antiqua 官方手册：<https://jaminzoda.github.io/terra-antiqua-documentation/>
- QGIS Terra Antiqua 插件页（捕获稳定版 1.1）：<https://plugins.qgis.org/plugins/terra_antiqua/>
- Adobe Quick Selection：<https://helpx.adobe.com/photoshop/desktop/make-selections/automatic-color-based-selections/paint-a-selection-with-quick-selection-tool.html>
- Adobe 魔棒：<https://helpx.adobe.com/photoshop/using/tool-techniques/magic-wand-tool.html>
- Adobe 添加 / 减去选区：<https://www.adobe.com/learn/photoshop/web/add-to-subtract-from-selections>
- QGIS 处理工具箱与表达式（作为产品模型参考，并非以 QGIS 实现）
- Google Maps 多边形绘制模式（点击顶点 / 预览边线）

## 17. 原型实现记录（本增量）

本文档阶段曾标注本增量 **已批准、待实现**。该记录予以保留为历史。下列默认值已在 `prototypes/paleodem-editor` 固定，并由本轮测试 / CDP 覆盖：

| 项 | 已实现默认 / ID |
| --- | --- |
| 地貌邻域半径 | `2` cells（有说明，不是自由控件） |
| 地貌连通 | `4` 或 `8` 邻接（`state.neighbors`，默认 `8`）；标注为邻接 / Connectivity，不是半径 |
| 地貌灵敏度 | 低 `relief 350 / residual ±180` m；中 `180 / ±90`（默认）；高 `80 / ±35`。残余为中心减去 2 格窗口内其他有限值均值；山脉要求残余 `> +阈值`，沟谷 `< −阈值`。水平平坦与倾斜平面斜坡（残余≈0）被拒绝。 |
| 本地表面版本 | `state.surfaceRevision` 仅在已提交 Float32 值 / 有效性变化时递增，与模拟云端 `project.lastSyncedRevision` 区分。 |
| Quick 首次模式 | Add；与通用 `selectionMode` 独立。显式 New 即使掩膜未变也会被消费并回到 Add。 |
| Fill IDW | 半径 `1–6` cells，默认 `3`；权重 `1/d^2`；冻结快照；缺 donor 整次阻止；空白 / 非整数 / 越界半径为无效（不静默 clamp） |
| Smooth | 半径 `1–3` cells，默认 `1`；同海陆符号；`E=0` 不变；跳过 NoData；半径 `0` / 非整数 / 越界为无效 |
| 算法 ID | `paleodem.rescale.v1`、`paleodem.fill.v1`、`paleodem.smooth.v1`、`paleodem.sea-level.v1` |
| 作用域 Apply 审计 | History extras 记录算法 ID、本地输入版本 / 谱系、精确范围掩膜、方法 / 参数、NoData 策略、有限 `ΔE` 行，以及显式旧 / 新有效性与有限填补基准（固定值或逐格 IDW 结果）。从不计算 `R−NaN`，也不写 `fillBase: undefined`。 |
| 无变化 Apply | 提交前比较提议与已提交的 Float32 值及有效性；恒等海平面 / 平滑 / 重缩放报告 `No change`，不增加编辑计数 / History / outbox。 |
| 作用域显示 / 统计 | 顶部范围提示跟随单选项；结果及差值统计只针对对应写入范围。 |
| 窄桌面选项栏 | 地貌控件换行时选项栏自动增高（1024 宽度下 77 px）；保留中文操作名，控件不被裁切。 |

**父级最终验收**（Node v26.8.1）

- `node --check prototypes/paleodem-editor/app.js` 与 `workbench.test.mjs`：通过
- `node --test prototypes/paleodem-editor/workbench.test.mjs`：47 通过 / 0 失败
- `npm run build`：通过（`tsc --noEmit && vite build`）
- `npm test`（vitest）：16 通过 + 1 跳过文件；83 通过 + 5 跳过测试；0 失败。早先子代理运行出现的 `node:` 导入失败未在父级最终运行中复现，相关项目测试文件未修改。
- CDP：`PALEODEM_EDITOR_URL=http://127.0.0.1:18222/prototypes/paleodem-editor/`，独立 headless Chrome 配置目录（用后关闭）；smoke 退出码 0；HTTP 200；无控制台 / 页面 / 请求错误；工具箱 20 个算法条目；山脉连通候选 151 单元（NoData 点击保留该掩膜）；Quick 真实指针点击后再拖动取并集；接缝融合为当前名；提示 `地貌选取 / Landform Select · W`；失焦后 Quick 恢复 Add。
- 布局 CDP：1440 / 1280 / 1024 保留中文取消选择 / 反选、46 px 侧栏、选项栏无溢出、无残留对话框 / toast。截图：`/tmp/paleodem-terra-antiqua-research/screenshots/100ma-after-landform-1440.png`、`100ma-after-landform-options-1024.png`、`100ma-after-quick-1440.png`、`100ma-after-terrain-tools-1440.png`、`100ma-after-scoped-preview-1440.png`（另有 1280/1024 展开地形工具）。
- 服务：复用已有 Vite PID 39887、端口 18222；仅关闭本轮测试 Chrome；18222 仍在监听。
