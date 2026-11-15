# Mollweide 与平面缩放：主会话验收

## 结论

本轮 **通过**：主会话直接调用生产 Agent 接口、操作实际前端并检查实际画面；不是依据实现代理的完成报告签收。验收范围为本地 PALEOMAP 的板块重建、三种投影、连续年代交互和两个平面模式的相机操作。

候选由现有 **4183** 服务提供。正式应用资源：`index-CXrl6any.js`。只构建外部临时目录，未覆盖根目录 dist，未重启旧 4173 服务；DPlanet 原有 123 项状态保留。

## 主会话独立证据

| 项目 | 结果 |
|---|---|
| 全量测试 | **528 passed / 5 skipped**；TypeScript、构建、diff-check 通过 |
| Agent 连续 100→130 Ma | 60 个独立输入；40 次确认 / 3.1403 秒 = **12.74 Hz**；p95 确认间隔 98.4 ms |
| Agent 连续 0→30 Ma | 60 个独立输入；38 次确认 / 3.1259 秒 = **12.16 Hz**；p95 确认间隔 100.6 ms |
| 请求与终态 | 原始末票均成功，requested/committed 精确为 130 / 30；无错票、无非 busy 错误；未补发重复终点凑数 |
| 实际拖针 | 原生按下、180 步持续移动；**松手前 44 次不同年代确认**，仍处于 dragging；不是释放后才更新 |
| Agent 前端动作 | toolbar 折叠与 DOM 一致；sidebar 选择与实际 tab 一致；camera zoom/pan/reset；layer opacity；非法模式、非法缩放、不兼容组显示均正确拒绝 |
| 实际 UI | Projection 下拉框 Rectangle→Globe→Mollweide，等待真实 ready；Home、连续年代与原生拾取通过 |
| 原生拾取 | 点击不同填充区域，Inspector 分别显示 Plate 715 / 201；椭圆外点击未拾取另一板块 |
| 模式与年代竞态 | 年代请求被模式切换取消后，不晚提交旧平面；再次进入 Mollweide 成功 |
| 相机 | 两平面三个实际画布比例 0.75 / 1.6 / 3：Home 完整世界最长边占 65%，最大缩小占 20%；pan 不改变尺寸 |
| wheel | 在画布明确坐标发送可信普通／Ctrl wheel；两平面均可双向缩放。Rectangle 测量等待原生惯性结束 |

频率来自成功年代请求对应的实际确认帧，分母包含最后 drain；不是 rAF FPS，也不是硬件上限。Worker 复用生产 CPU 算法，准备与 GPU 预热流水并行；并非新的常驻 GPU 投影器。

## 真实绘制异常回归

主会话在独立浏览器中让 WebGL2 `drawElements` 一次性抛错，立即恢复原方法；不是直接伪造 renderError。

1. **CPU 等待空窗**：108 尚在 Worker 准备时真实绘制失败。108 / 110 返回 500，已被覆盖的 109 返回 409；旧 100 Ma 保留。立即 retry100 成功，实际 Widget 默认循环为 true，终态 ready。
2. **当前 GPU + 已准备后继 CPU + 最新待办**：记录到 109 的 CPU ready 早于绘制失败；108 / 109 / 110 全部返回 500，旧 100 Ma 保留；retry100 成功、循环为 true。诊断仅暂缓真实 postRender 通知，没有伪造成功帧。

因此修复了主会话最终检查发现的 CPU→GPU 错误监听空窗；不以错误面板是否消失判断循环活性，也不以超时当成功。

## 代码与依赖收尾

- 数学核心、裁剪 oracle、whole-source 数值退化政策未为性能放宽；新增细分遗漏在真实 sweep 中为零。
- 仅在 runtime 清单与锁文件补充当前已安装的 `@cesium/engine` 直接依赖声明，未下载、升级包或修改 Vite 配置。
- Worker 的 DedicatedWorker 类型视图有 SAFETY 说明。该文件错误级诊断为零；项目既有的无扩展名导入等辅助风格告警不等于 TypeScript 编译错误。

## 证据位置

外部验收目录：

`/tmp/timemachineweb-test/`

主要文件：

- `moll-parent-final-tests.log`、`moll-parent-final-build.log`
- `moll-parent-final-streams.json`
- `moll-parent-worker-api-acceptance.json`
- `moll-parent-worker-drag-before-release.json`
- `moll-parent-three-aspects.json`
- `moll-parent-trusted-ctrl-settled.json`
- `moll-parent-native-picking.json`
- `moll-parent-final-cpu-gap-retry.json`
- `moll-parent-final-prefetched-ready-error.json`
- `moll-parent-final-home.png`

## 边界

- 已测可信浏览器 wheel／Ctrl-wheel，**未冒充真实 MacBook 手指触控板验收**。
- 本轮使用显式选择的本地 PALEOMAP；**真实私有账号／私有模型端到端仍未验证**。
- 结果不保证任意模型、机器或浏览器都达到上述频率。
