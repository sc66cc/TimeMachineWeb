# TimeMachineWeb Canonical UI

状态：**CANONICAL / SINGLE SOURCE OF TRUTH**

归档日期：2026-07-27

## 唯一真实参考

TimeMachineWeb 的 UI 设计、前端实现、视觉验收和交互评审，唯一以
[`canonical/index.html`](canonical/index.html) 为准。

以下内容均不具备规范效力：

- Codex 对话中的临时预览；
- 截图、设计草稿和历史 HTML；
- 旧版 WebGPlates、Unity 或实验页面中的界面；
- 未同步回本目录的 Figma、原型或实现分支。

## 归档内容

| 文件 | 用途 |
|---|---|
| `canonical/index.html` | 可独立打开的真实 HTML/CSS/JavaScript UI 实现 |
| `canonical/timemachine-reference-1to1.png` | 仅作为地球表面科学影像素材，不是页面截图背景 |
| `canonical/manifest.json` | 规范状态、逻辑分辨率、字体、主色和文件校验信息 |
| `canonical/SHA256SUMS` | 归档文件完整性校验 |

## 固定设计基线

- 逻辑画布：`1919 × 871`
- 字体：`Arial, Helvetica, sans-serif`
- 主色：`rgb(42, 130, 228)`
- 布局：顶部应用栏、左侧图层管理、中央地球画布、底部地质年代轴
- `Layer | Plate Model` 使用文字切页
- 年代轴字体加粗；深色年代区块使用白色文字增强对比度
- 控件、图层切换、播放、缩放和年代轴拖动必须保持真实可操作

## 变更规则

任何 UI 变更都必须：

1. 由产品负责人明确提出；
2. 直接修改 `canonical/index.html`，不能另建竞争性“最终版本”；
3. 验证独立打开、资源加载和关键交互；
4. 更新 `manifest.json` 与 `SHA256SUMS`；
5. 在项目决策文档中记录变更原因。

未经上述流程更新的页面，不得称为 TimeMachineWeb 的最终 UI 或实现基线。
