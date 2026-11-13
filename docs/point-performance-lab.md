# TimeMachineWeb 大规模点性能实验台

## 1. 本轮实现

页面右侧的 **PBDB GPU 点实验** 面板可分别加载：

- 10,000、100,000、275,000 点分层样本；
- 清洗后的 275,291 条真实 PBDB 记录；
- 1,000,000、3,000,000、5,000,000 点压力集。

1M、3M 和 5M 由 275,291 个真实点按固定顺序循环复用，目的是产生稳定、可复现的
GPU 负载。它们没有添加随机抖动，也不能作为新增科学观测使用。

当前默认是极限性能模式：每条测试记录在完整 `0–1100 Ma` 时间轴永久有效。
时间轴只改变四元数旋转，不再因 PBDB 来源年龄减少可见点数。

可通过面板独立开关点图层和板块面。关闭板块面可测纯点吞吐，打开两者可测真实的
混合渲染成本。时间轴拖动和播放使用同一条重建路径。

## 2. 数据制备与质量

运行：

```bash
npm run data:points
```

制备器 `scripts/prepare_point_fixtures.py` 执行：

1. 流式读取 XLSX 的经度、纬度、年龄、occurrence count 等数值列；
2. 校验坐标和 `max_ma/min_ma`；
3. 用 pyGPlates `PlatePartitioner`、本项目 GPML 和 `.rot` 在 0 Ma 分配 Plate ID；
4. 转换为单位球向量；
5. 写出确定性 WGP1 数据集和 SHA-256 清单。

实际质量结果：

| 指标 | 数值 |
|---|---:|
| XLSX 原始行 | 275,347 |
| 接受 | 275,291 |
| 拒绝 | 56 |
| 缺少必需值 | 36 |
| 年龄区间无效 | 20 |
| Plate ID 已分配 | 275,272 |
| 来源 Plate ID 未分配 | 19；性能导出时挂到锚定板块 0 |
| 使用的 Plate ID | 186 |
| 最大 Plate ID | 992 |

原始年龄字段仍保存在只读来源和 Plate ID 缓存中，但默认性能 WGP1 不采用它们：
所有记录统一写为 `validFrom=1100 Ma`、`validTo=0 Ma`。如需科学时间语义，可用
`--validity source --unassigned hide` 重新生成另一套数据。

19 条来源点没有 Plate ID。为了严格让所有测试记录参与绘制，性能导出阶段将它们
挂到锚定板块 0；它们会保持在全球锚定参考系。这个降级策略记录在 manifest 的
`unassignedPointPolicy`，不会回写 XLSX 或 Plate ID 缓存。

## 3. WGP1 二进制

WGP1 有 64 字节头，之后是 20 字节定长记录：

| 偏移 | 类型 | 字段 |
|---:|---|---|
| 0 | `float32 × 3` | 0 Ma 单位球坐标 |
| 12 | `uint16` | `validFrom × 10`；性能夹具固定为 11000 |
| 14 | `uint16` | `validTo × 10`；性能夹具固定为 0 |
| 16 | `uint16` | Plate ID；性能夹具不会留下未分配值 |
| 18 | `uint16` | occurrence count |

浏览器不创建数百万个 JavaScript 对象。Worker 校验 magic、版本、stride、点数和
精确文件长度，再转移原始 `ArrayBuffer`。20 字节/点就是主要 CPU 和 GPU 顶点
存储成本：1M 约 19.1 MiB，5M 约 95.4 MiB。

## 4. 正确的扩展路径

时间 `t` 变化时，CPU 只计算活动 Plate ID 的有限旋转：

```text
.rot → RotationModel(t) → Map<plateId, quaternion>
```

四元数按 `x,y,z,w` 写入一个 `RGBA32F` 纹理。每个顶点按 Plate ID 查表，在
vertex shader 中计算：

```text
t = 2 × cross(q.xyz, v)
v' = v + q.w × t + cross(q.xyz, t)
```

随后将 `v'` 乘球半径并交给 Cesium 的视图/投影矩阵。shader 仍保留通用的时间
有效期过滤，但默认性能数据在整个时间轴都会通过该条件。

因此：

- 时间变化的 CPU 成本与活动 Plate ID 数相关，而不与点数线性相关；
- 10k 到 5M 都是一个 GPU 顶点缓冲和一个 draw call；
- 不发生逐点 `Cartesian3` 重建、Entity 更新或每帧大数组回写；
- GPU 顶点工作仍为 O(N)。5M 是全量压力场景，后续产品化仍应增加空间瓦片、
  屏幕 LOD 和视锥/地平线层级剔除。

## 5. 页面指标如何读

| 指标 | 含义 |
|---|---|
| 文件 / GPU | WGP 文件字节 / 可计算的 GPU 顶点缓冲字节 |
| 加载 / 上传 | Worker fetch+校验 / 创建 GPU 资源的 CPU 提交时间 |
| 帧率 | 连续播放或拖动期间的渲染提交节奏 |
| P95 帧时 | 最近最多 240 个交互帧间隔的 P95 |
| 拖动响应 | 最近一次时间输入到 Cesium `postRender` 的主线程提交延迟 |
| JS 堆 | 仅 Chromium 的观察值；不能跨浏览器直接比较 |

GPU 真正完成一帧的时间和显存占用不能由这些 Web API 完整、可移植地获得。发布
报告还应使用 Chrome trace、系统 GPU 工具和固定硬件。

## 6. 验证

```bash
npm test
npm run build
python3 /Users/user/.codex/skills/webapp-testing/scripts/with_server.py \
  --server "npm run preview" --port 4173 --timeout 60 \
  python3 scripts/browser_point_smoke.py http://127.0.0.1:4173/
```

当前结果：

- 44 项解析、四元数、重建树、剖分、WGP1、永久有效期和纹理布局测试通过；
- 生产构建通过；
- 无头 Chromium 中 6 个数据集均成功上传和绘制，未出现 WebGL 或页面错误；
- 5M 数据的文件和 GPU 顶点缓冲均约 95.4 MiB。

自动浏览器识别到的 renderer 是 SwiftShader。其 FPS 是软件渲染结果，只能作为
功能回归，不能用于判断目标硬件是否达标。真实性能测试请在 `npm run preview`
后，用本机硬件浏览器打开 `http://127.0.0.1:4173/`，加载目标数据并连续播放至少
20 秒，再记录稳定后的面板指标。
