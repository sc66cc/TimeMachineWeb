# 投影切换 UI / Agent 规格（主 Agent 审定稿，未实现）

本稿是增量设计与实现合同，不是已经可用的投影控件，也不是新的 Canonical UI。当前产品仍只有 3D。运行时合同见 [projection-runtime-contract.md](projection-runtime-contract.md)，几何进度见 [projection-plan.md](projection-plan.md)。

## 1. 已核实的基线

- Canonical 归档确实存在：`docs/ui-reference/canonical/index.html`；规范入口为 `docs/ui-reference/README.md`，逻辑视口 1919×871。
- 当前产品使用 Vue 3、Arial/Helvetica、主色 `rgb(42,130,228)`；保持科学工作台布局，不引入 React/Tailwind/新组件库或整站重设计。
- 归档中的 Major cities / place search 是独立定位控件；当前 AppShell 将它们放在 `.view-options` 的纵向容器中。
- 本稿只定义后续修改，不改变现有 Canonical 归档、manifest 或校验和。实现 UI 时须按归档流程同步并验收，不能把本稿当作另一个“最终界面”。

## 2. 最小控件与位置

在现有 `.view-options` 的 **Place search 之后**追加投影行，保留原城市开关和搜索框顺序／位置；不占用模块栏，不覆盖 Home 或年代轴。

- 原生 `<label>` + `<select id="projection-select">`，绑定 `data-action="projection.select"`。
- 标签 `Projection`，可访问名称可用 `地图投影 / Projection`。
- 选项：`Globe (3D)`、`Rectangle`、`Mollweide`，对应 `globe/rectangle/mollweide`。
- `Globe` 保持现有 3D 相机行为，不宣称它已改成 GPlates 的正交球面相机。
- 选择框宽度优先 210px，与现有搜索框一致，高度约 29px；沿用白底、`#d5d7d8` 边框和既有蓝色焦点样式，不加新卡片／装饰动画。
- 紧接状态段 `#projection-status`，通过 `aria-describedby` 关联，`aria-live="polite"`；错误使用现有 toast 和错误色，而不是新增弹窗。
- 模块栏折叠时仍能操作。窄视口保持纵向，不横向挤压控制；至少验收 1440×900、1280×800、1024×768。

概念结构：

```text
.view-options
  现有 Major cities
  现有 Place search
  label → select#projection-select [data-action="projection.select"]
  p#projection-status [aria-live="polite"]
```

## 3. 模式与生命周期

- Rectangle：原生 `SCENE2D + GeographicProjection(SPHERICAL_EARTH)`；源瓦片继续 WebMercator，不换 tile matrix。
- Mollweide：`SCENE3D` 承载自建正交平面，轴 `(depth,east,north)`，不是给 Cesium 注入任意 mapProjection。
- 中心经线首版固定 0。地图 XY 原点由宿主以正显示 depth 编码；不能误把 raw scene `(0,0,0)` 硬编码为有效平面顶点。
- 保留同一 Viewer、原始点 VBO、模型与 Raster controller，不因 mode 重新解析或下载模型。
- 投影只放在本次页面运行内存；reload 后默认 globe，不新增 sessionStorage/localStorage 字段，不更改 Server DTO。
- 模式切换保留年代、图层、样式和地理视点。平面相机不能保存成 ECEF，回 globe 恢复上次 globe 快照。

## 4. 一套无矛盾的请求策略

采用 **最后接受的请求获胜**，UI 与 Agent 使用同一运行时规则。

1. 已初始化且至少有可用模式时，选择框可用。
2. 核心准备期间仍允许选择另一个可用模式；展示 `Switching to X… Current: Y`，不要把请求中的 X 宣称为已显示模式。
3. 新请求使旧 staging 失效，旧请求须明确结算为被取代（例如统一 `busy/409`），不能永久 pending 或返回假成功。
4. 仅当目标已提交且没有不同的 pending 请求时，同模式选择才是无操作；请求返回当前 committed 状态。
5. 如果当前显示 globe、正在准备 Mollweide，此时重新选择 globe 必须取消 Mollweide 请求，不能因“已经是 globe”忽略它。
6. 旧请求被取代的完成／失败回调不得覆盖新状态或触发旧错误 toast。

UI 可在准备期间显示 requested 选项，但必须同时标注旧 committed 视图仍在显示；失败后回到 committed 选项。不能只靠原生下拉框值判断真正生效的模式。

## 5. 状态与可用性

计划的 `getState().projection`：

```ts
{
  requestedId: MapProjectionId,
  committedId: MapProjectionId,
  status: "idle" | "preparing" | "ready" | "error",
  revision: number,
  lastError?: { kind: AgentActionErrorKind, code: number, message: string },
  availableModes: [
    { projectionId: MapProjectionId, available: boolean, reason?: string }
  ],
  assets?: { status: "idle" | "loading" | "ready" | "error", message?: string }
}
```

`revision` 表示已提交视图版本；内部请求代际必须能阻止旧结果提交，不能把“已发请求”当作“已提交”。具体请求票据不必暴露成新的公共框架。

| 状态 | 控件 | 反馈 |
| --- | --- | --- |
| 运行时未初始化 | 整体禁用，Agent 同样返回明确不可用 | 准备视图中 |
| ready | 启用，显示 committed 模式 | 可无提示 |
| preparing | 仍允许新模式选择 | 请求模式、当前实际视图、准备状态 |
| 核心已提交但 tiles 加载中 | 启用，显示 committed 模式 | 独立报告资源 loading，不重新宣称核心尚未提交 |
| 最新请求失败 | 启用，恢复 committed 模式 | 短错误及 toast；旧视图保留 |
| 仅某模式不支持 | 只禁用该选项并提供原因 | 其他模式仍可用；Agent 直接请求同样返回 unsupported |
| 可见层不兼容 | 不提交该模式、不隐藏图层 | 明确层／原因，保留原模式 |

远程资源错误需报告实际显示帧／加载状态；不能把尚未到齐的瓦片说成已渲染。资源 loading 本身不应禁止用户换模式。

## 6. Agent 合同（计划，当前尚未注册）

唯一动作：

```js
await window.timeMachineAgent.execute("projection.select", {
  projectionId: "rectangle"
});
```

沿用现有四方法 facade 和结果类型，不增加第二个对外 `view.setProjection` 别名，不新增 HTTP 接口。

- `execute()` 返回的 Promise **解析为结构化结果**，不是向调用者泄漏原始 reject。
- 成功示意：`{ actionId:"projection.select", ok:true, data:{projectionId,revision} }`，必须等待核心视图真实提交；本动作不 reload 页面。
- 失败示意：`{ actionId:"projection.select", ok:false, error:{kind,code,message} }`。
- 无效枚举为 `validation/400`；不支持或图层不兼容为 `unsupported/501`；被新请求取代可用 `busy/409`；意外执行失败为 `internal/500`。
- 内部 runtime Promise 可以 reject，再由 facade 映射为上述结果；UI 薄调用与 Agent 相同 handler 后显示结果，不能另外直接改 mode 或模拟 DOM 点击。
- `getState()`、结果和错误沿用安全输出规则，不返回凭据或大网格/GPU 对象。
- `availableModes` 用于解释参数级可用性；不能因为 Mollweide 不可用而把整个 `projection.select` 禁掉。

## 7. 响应式与可访问性

- 使用原生 select；Tab 可达，方向键／Enter／Space 按系统行为操作。
- 可见焦点沿用现有蓝色样式；状态通过文本和 `aria-live` 表达，不只依赖颜色。
- 无需新动画；遵循已有 reduced-motion 约定。不得用 CSS 动画／拉伸假装投影。
- 异步失败不抢走焦点；取消旧请求不弹过期 toast。
- 不能只给控件加 data-action 标签就算完成，测试必须调用真正生产处理器并核对视图与状态。

## 8. 实现顺序与验收

1. 几何和 runtime 提交／取消合同先验收；原生 Rectangle 垂直切片优先。
2. 注册真实 `projection.select`、状态与模式级可用性，再加控件；不启用只有 UI 没 backend 的模式。
3. 同步 `docs/ui-reference/canonical/index.html`，按归档规则验证交互、更新 manifest/SHA256SUMS并记录变更；不另造竞争性最终稿。
4. GUI 与 Agent 分别测试普通切换、同模式无操作、准备中再选／返回旧模式、被取代请求结算、加载中切换、失败回退、不可见过期回调。
5. 验证板块/点/Raster 当前模式和已提交年代一致；控制点对齐、seam/pole/NoData/拾取、Home与回到globe视点正确，模式切换不重建原始数据。
6. 原账号私有模型端到端验收独立完成，不能以合成几何测试或本规格代替。

所有上述控件与公共动作均未因本文而实现；应以代码、测试和真实浏览器结果为验收依据。
