# Rectangle 投影 MVP 说明

状态：**已交付可操作闭环（plate-only）**。本轮只交付 `globe` ↔ `rectangle`
（Plate Carrée）可切换版本；Mollweide、rectangle 内的点/影像层、平面 GPU 点与
投影瓦片网格仍未实现，见 [agent-api.md](agent-api.md) 的能力边界。

## 平面相机 Agent 验收补充

`camera.zoom({ factor })` 乘当前视野宽度：大于 1 缩小地图，小于 1 放大；
范围 `[0.01, 100]`，返回实际 `mode/width/factor`（如实包含钳制）。
`camera.pan({ deltaX, deltaY })` 是 CSS 像素拖动量，正 X 内容右移，正 Y 内容下移，
每轴范围 `[-100000, 100000]`。非有限值/越界返回 400；Globe 暂返回 501。
Mollweide 与真实 wheel/ctrl-wheel、pointermove 共享底层方法；Rectangle 保留原生
单一输入控制器，API 调用公共 Camera zoom/move。Home 和原 Globe GUI 手感不变。

`getState().projection.camera` 是只读即时状态：实际 logical `mode`、CSS `viewport`、
平面视野米制 `width`、完整世界域 `worldBounds`（canvas-relative CSS）及 `worldRatio`。
Moll 使用 ellipse 四极值，Rectangle 使用完整 domain 四角而非 plate bbox。
这些调用不改变年代、投影选择或项目持久化，不暴露 Viewer/GL/大数组。

Moll → Globe 待 render 时由新 Globe 年代请求接管并成功后，会以原 renderer token
confirm 旧 swap、释放 retained 旧帧；之后 Rectangle 准备失败不得回滚到旧 Moll。
反方向的平面年代接管保留原 checkpoint/token，仅转移 controller owner；失败仍真实
rollback，并恢复 renderError 停掉的 loop。

## 这是什么

同一个 Cesium `Viewer` 上的原生 2D 板块视图：

- Rectangle = 原生 `SCENE2D` + `GeographicProjection(SPHERICAL_EARTH)`
  （等距圆柱 / Plate Carrée，非 Mercator）。源瓦片仍是 WebMercator，不换 tile
  matrix；本轮 rectangle 内不显示影像层。
- Globe = 既有 3D 场景与快路径，原样保留。
- 板块几何：CPU 帧（`plate-rectangle-frame`）出 per-plate geometry（未预旋转）、
  烘焙旋转矩阵与已旋转 outline 环；提交时用 `GeometryInstance.modelMatrix` 在建
  构期烘焙，Primitive 本体 identity，outline 用已旋转环 + identity collection，
  pick 仍是原 feature/polygon。不重解析/重三角化模型。

## 打开与操作

地址：**http://127.0.0.1:4183/**（本轮独立构建的预览；旧版 4173 未覆盖）。

若没有已载入的板块模型，先在 **Plate Model** 页显式点击本地 PALEOMAP 演示数据的 **Use**，或加载原账号有权访问的模型。本轮独立浏览器验收使用前者，不代表真实私有账号已端到端验证。

1. 顶部 `.view-options` 的 Place search 之后有 `Projection` 原生下拉框，选项
   `Globe (3D)` / `Rectangle` / `Mollweide`（禁用）。状态行显示 requested /
   committed 模式与年代。
2. **进入 Rectangle 前必须先关闭不兼容图层**：可见的 `Phanerozoic atlas`、
   `PBDB points`、`Single raster` 会阻止切换（它们仍是 globe-only）。用左侧图层
   开关把它们显式关闭，再选 Rectangle。系统不会替你隐藏图层。重新显示图层组、
   把图层移入可见组或重排导致这些层变为有效可见时，同样会在应用前被拒绝
   （GUI 与 Agent 一致，按有效可见性判断，父组仍隐藏时不误判）。
3. 进入 Rectangle 后可连续拖动年代/播放：最多一个 active 帧加一个 latest pending 年代；新输入只覆盖 pending，不取消 active，持续输入期间也会显示中间已确认帧。被覆盖的 pending 请求返回 409；active 请求确认自己的年代后成功，最终最新请求也必须等自己的真实 render。时间针保持最新输入，板块计数/inspector 使用 committed 年代。Home 显示全图，可平移缩放（globe 惯性已关闭）。仍有逐帧准备与 GPU 上传成本，不承诺播放帧率。
4. Agent 共用同一实现：`await window.timeMachineAgent.execute(
   "projection.select", { projectionId: "rectangle" })`，改为 `"globe"` 返回球面；
   `getState().projection` 读 `committedId` / `status` / `revision` /
   `committedTimeMa` / `availableModes`。Mollweide 返回 `unsupported`。

## 关键实现

- `src/projection/projection-controller.ts`：唯一请求控制，mode/source epoch 与
  Rectangle 单 active/单 latest 时间请求分离；切换/销毁/在途能力失效强取消 CPU、
  staging 与确认监听器并结算所有请求。requested/committed 分开，队列未追上保持
  preparing。`refreshCapabilities()` 不创建新帧；在途 Rectangle 能力失效会取消。
- `packages/cesium-runtime/src/plate-rectangle-frame.ts`：每 build 复用一个
  MessageChannel，在每 8 polygon 后作真正 macrotask yield，避免嵌套零 timer 的
  clamp；缺少能力时退回 timer。成功/失败/abort 均清监听器与 ports；保留最后
  yield 后的 abort guard，不以微任务冒充 UI yield。
- `src/main.ts`：`LayerController` 的 `publishState` 适配器先 `applyLayerState()`
  再 `refreshCapabilities()`，因此图层/组/排序等一切改变有效可见性的变更都会刷新
  Projection 下拉可用性与状态行（不可用时状态行直接给出原因与处理方式），无需
  reload；该适配器装在 controller 构造之后，不触碰早期绑定。
- `packages/cesium-runtime/src/plate-renderer.ts`：`stageRectangleFrame` /
  `commitRectangleFrame` / `restoreGlobeFrame` / `cancelRectangleStaging`，真实
  GL 预热（`show=true` + 每 instance/line `show=false`）、`primitive.ready` 后
  `getGeometryInstanceAttributes` 核验、`scene.renderError` 处理、取消/换请求/
  destroy 清理并释放自有 staging，不动已提交画面。
- `src/main.ts` / `AppShell.vue` / `style.css`：控件、状态、`time.set` 同一控制、
  相机按 mode 防护（2D 相机绝不写入 ECEF 快照，reload 默认 globe）。
- `src/agent-actions/actions.ts`：`projection.select` 动作与 `projection` 状态段。

## 验证

- 单测：`src/test/projection-controller.test.ts`（32）与
  `src/test/plate-rectangle-commit.test.ts`（8）覆盖 two modes / time /
  latest-wins / failed visible layer / Home / persistence guard，以及 mode+age
  事务交错（双方向在确认渲染前插入 age 变更）、pending rectangle 图层 guard、
  组/重排 guard、渲染等待器的即时取消。本轮新增外部有效可见性 blocked→allowed
  及反向时 `refreshCapabilities` 通知 UI sink 新 `availableModes`/reason 而
  mode/time/revision 不变、不准备/提交帧的回归。实时修复新增持续输入中间帧、
  pending 覆盖、最终确认、invalid age、切换/destroy/renderError/能力失效结算与
  恢复，以及 MessageChannel 复用/关闭、timer fallback、最终 8/16 batch abort
  等回归。父级独立全量 455 passed / 5 skipped、`tsc --noEmit` 通过。
- 浏览器 smoke（本机 PALEOMAP demo，端口 4183）：globe→关闭三图层→rectangle 出
  现 Plate Carrée 板块画面→`time.set(150)` 真实提交且 inspector 按 committed
  年代显示“已重建”→P1 组绕过（rectangle 中 `layer.group.setVisibility` 重新显示
  含不兼容子层的组）被 400 拒绝且状态不变→返回 globe 恢复 3D。真实账号/私有模型
  端到端由验收方独立完成。

### 实现方连续输入 smoke（本机 PALEOMAP，4183）

实现方独立浏览器 session 加载生产 bundle `index-CO1hGa-a.js`，按绝对时间每 50ms
安排一个 Agent `time.set`，共 60 个（同 timeline onChange 路径，无 prototype
patch）：3s 内 54 个真实确认提交，共 56 成功 / 4 个被覆盖 pending 返回 busy；
首帧 77.5ms，成功请求中位延迟 99.6ms，最终 227 Ma 在最后输入后 103.6ms
确认（3s 窗口结束后 55.3ms）。最终 requested/committed 均为 227，ready。
测量随本机负载波动，不作为固定 FPS/硬件上限承诺。

证据：`/tmp/timemachineweb-test/rectangle-production-realtime-3s.json`（含每次请求的
发送/确认时间与结果）。只重建 `/tmp/timemachineweb-test/rectangle-mvp-dist`，
未覆盖 root dist、未重启已有 4183/4173 服务。此修复优化的是原生调度，不是常驻
GPU renderer；原生 Primitive/outline 仍逐帧构建并上传，未减少顶点或隐藏轮廓。

### 主 Agent 独立复验

- 同一 50ms 持续输入测试：约 3.003s 发出 59 个请求，输入期间观察到 49 个不同的已确认年代（修复前为 0）；停止输入后约 86.9ms 对齐最终 128 Ma，状态 ready。
- 使用浏览器原生 mouse down/move/up，而非只调用 Agent：按住真实时间针并发送 181 个 trusted pointermove，**松手前**观察到 70 个不同 committed 年代；松手时 requested/committed 均约 179.8976 Ma。移动命令的计划时长不等于严格实际时长，此项不据此换算 FPS。
- 队列运行中切回 Globe：active 与 pending 全部以 busy/409 结算，Globe 正确显示最新 130 Ma，无挂起 Promise。
- 独立全测 455 passed / 5 skipped、类型检查通过；独立静态审查未发现本轮确定的 P1/P2。

49 次年代确认约对应本次测试每秒 16 次画面更新，不是显示器 render FPS；上述数字也不是 Cesium/GPU 的硬件上限。继续追求更高刷新率，需要另外评估常驻 GPU 几何与反子午线／极点／轮廓／拾取的正确性，不能直接把 native 路径的性能称为硬件极限。

复验证据：`/tmp/timemachineweb-test/rectangle-scrub-parent-after.json`、`rectangle-true-pointer-before-release.json`、`rectangle-true-pointer-after-release.json`、`rectangle-stream-mode-cancel-parent.json`。

### Mollweide 扩展接手验证（未验收，不替代以上 Rectangle 交付状态）

工作区新增了 Mollweide CPU 帧、正交平面相机及共用队列接线，当前仍有明确阻塞，不能把 UI 中可选择 Mollweide 当作端到端已交付。

- 真实 `GPlates-16c50bd7-f067-4348-b4aa-10002f0229d1#0#412` 保留 frozen oracle 的 unsupported；runtime 有界细分测试通过，共享边邻面同步拆分、原 buffer 不变、球面面积与绕序均验证。细分结果延迟替换已输出邻面，sourceTriangleIndices 保留原 face ordinal。深度/新增三角形预算与 abort 都有诊断路径；额外检查子面球面绕序和面积守恒，不能为成功吞掉非零子面。
- 真实 PALEOMAP 全模型 CPU 测试通过 0 / 100 Ma，但 **180 Ma 仍失败**：`GPlates-bca3ad77-3ed6-44bd-b960-113891b1a986#0#889` 的旋转后球面面积约 −1.67e−20 sr，oracle 判 degenerate，但不是严格零；当前细分耗尽深度预算，保留源 ID 报错，不丢面。该回归和全模型回归保留为失败，尚未改变退化定义或冻结 oracle。
- 4183 浏览器已显示真实 Mollweide 0 / 100 Ma 椭圆、轮廓与 graticule；Rectangle→Globe→Mollweide 动作均真实确认。opacity 动作成功。完整 world ellipse 最大 zoom-out 约 176×88 CSS px，canvas 1024×439，比例约 17.2% / 20.0%；ctrl+wheel 正向缩出、反向可缩回。三 aspect（1.6 / 3 / .75）的完整世界域 Home 65% / max 20% 单测通过。物理 MacBook 手势未测试，孔洞/native pick/Inspector 和失败回滚尚未完成端到端验收。
- 原始 Mollweide 连续输入测试在约 3 秒输入期间为 **0 个确认提交**；100 Ma active 约 10.94s 确认，最终 100.59 Ma 约 11.28s 确认，未达到目标。profile 后新增 compact vertex→face incidence 和叶结果缓存，100 Ma triangle 阶段从约 9.8s 降到约 265ms、0 Ma 从约 3.4s 降到约 521ms（Node CPU 测量，不是浏览器 commit 率）。优化后浏览器复测：100 Ma 进入约 516ms；3.002s 持续输入期间 **10 个**真实确认年代（约 3.3 commits/s，不是 10/s），但最终 100.60 Ma 遇到同一 `…bca3ad77…#0#889` 面的球面面积守恒诊断，保留最后合法 100.52 Ma、状态 error。最终年代对齐和性能门槛均未通过，不能称为实时交付。仍不是持久 GPU renderer。
- 同浏览器 Rectangle 持续输入约 3.010s，输入期间 47 个确认提交，最终 116 Ma 于约 3.123s 确认，单 active/latest pending 未退化。

证据位于 `/tmp/timemachineweb-test/`：`moll-completion-age0.png`、`moll-completion-home100.png`、`moll-completion-maxzoom100.png`、`moll-completion-stream3s.json`、`moll-completion-stream3s-profiled.json`、`moll-completion-three-mode.json`、`moll-completion-rectangle-stream.json`、`moll-profile-leafcache.log`。构建仅写独立 `rectangle-mvp-dist`，未覆盖 root dist / 4173，未重启既有服务。
