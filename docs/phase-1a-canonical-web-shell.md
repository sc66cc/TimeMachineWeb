# 阶段 1A：Canonical Web Shell 实施记录

更新日期：2026-07-27

状态：已完成。阶段 1A 将已归档的 Canonical UI 转成真实 Vue 3 应用外壳，并接入
现有 Cesium、板块重建、PBDB 点、Raster 和地质时间轴 runtime。它不是截图、背景图或
iframe。

## 1. 本阶段边界

阶段 1A 完成“可交互 Web Shell + 本地项目草稿”：

- 以 `docs/ui-reference/canonical/index.html` 为唯一视觉参考；
- 使用 Arial 字体、`rgb(42, 130, 228)` 主色和全视口响应式画布；
- 实现顶部应用栏、`Layer | Plate Model` 文字切页、紧凑图层列表、球面工具栏、
  播放控制器和高密度地质时间轴；
- 在 Vue Shell 内挂载真实 Cesium canvas；
- 连接板块面、PBDB 点、单幅 Raster 和古地理图集 runtime；
- 时间拖动和播放继续使用板块级/GPU 更新，不把大规模要素放入 Vue 响应式状态；
- 将项目名、时间、图层状态和相机映射到生成的 `ProjectDocumentV2TO`；
- 将未登录草稿保存到浏览器本地，并在刷新后恢复。

本阶段没有实现登录、在线资源目录、资源 ID/version、云项目 revision、分享、发布或
导出。这些属于阶段 1B；顶部对应入口仅表达产品信息架构，其中 “Save to Cloud”
当前保存本地草稿并明确提示云同步将在阶段 1B 接入。

## 2. 实现边界

Vue 只管理小规模 UI 状态和交互编排：

- `src/AppShell.vue`：Canonical 页面结构和组件状态；
- `src/main.ts`：Cesium 与各 runtime 的生命周期和 DOM 适配；
- `src/project/project-session.ts`：UI/runtime 状态与 `ProjectDocumentV2TO` 的映射；
- `src/ui/geological-timeline.ts`：时间轴拖动、播放和倒序空间映射。

GPU buffer、Cesium primitive、Worker 数据和大规模点集合仍由 runtime 持有，不进入
项目 JSON 或 Vue reactive object。`packages/generated-api` 只补充稳定导出，
`DPlanet/TypeScript/src/code_ex` 未被手工修改。

## 3. 项目草稿

本地草稿使用键 `timemachine:web:phase1a-project`，保存：

- schema version 和项目名；
- 当前 `timeMa`；
- 四个 runtime 图层的 ID、类型、显隐、透明度和 source reference；
- Cesium 相机 position、direction 和 up。

恢复前会验证 schema、时间、图层数组和相机字段。损坏或不兼容的草稿会被拒绝并回退
到默认项目，不会污染 runtime 状态。

阶段 1B 将把相同 DTO 边界接到生成 API SDK、在线资源版本和云端 revision；不会重新
设计项目模型。

## 4. 验收结果

全部通过：

| 验证 | 结果 |
|---|---|
| TypeScript type-check + Vite production build | 通过；135 modules transformed |
| Vitest | 13 files / 57 tests 通过 |
| Chromium 真实页面 smoke test | 通过；无 page error |
| Vue Shell 与 Cesium canvas | 真实挂载，可交互 |
| 时间轴与播放 | 0–538.8 Ma，古老时间在左、现代在右 |
| PBDB 点图层 | Worker/GPU runtime 实际进入“运行中” |
| 图层显隐与切页 | 通过 |
| 本地草稿 | 项目名、250 Ma、4 个图层和相机成功保存 |
| 1440×900 全屏布局 | 无上下留黑；地球、左栏、控制器和地质时间轴均完整落位 |

浏览器视觉验收曾发现默认相机过近，导致地球上下被裁切；默认 home camera 已调整，
复测后地球完整显示。

## 5. 下一步

阶段 1B 按以下顺序继续：

1. 登录和用户信息；
2. 在线板块模型与 DatasetVersion 目录；
3. 用资源 ID/version 替代本地数据 URL；
4. 通过生成 API SDK 创建、打开和保存云项目 revision；
5. 刷新与跨浏览器恢复云项目，并与黄金坐标做多年龄对照。
