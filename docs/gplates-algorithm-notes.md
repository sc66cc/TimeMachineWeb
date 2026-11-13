# GPlates 源码定位与 Web 映射

研究基线：

```text
repository: https://github.com/GPlates/GPlates
commit:     7f4b8fa85208c27fc69e660bd88bcb5ecf84363a
date:       2026-07-22
```

## 1. `.rot` 字段与序列

GPlates 在 [`PlatesRotationFormatReader.cc`](../GPlates/src/file-io/PlatesRotationFormatReader.cc) 的 `parse_pole()` 中按以下顺序读取六个字段：

```text
moving_plate_id  time_Ma  pole_latitude  pole_longitude  angle_degrees  fixed_plate_id
```

对应源码位置为 186–290 行。Web 实现在 [`plates-rotation-parser.ts`](../src/core/plates-rotation-parser.ts) 中使用相同字段顺序，并复现以下序列规则：

- 同一序列时间单调递增；
- moving/fixed 任一变化都会开启新序列；
- 相同或倒退时间通常开启新序列；
- moving Plate ID `999` 且固定板块不变时，样本属于当前序列但被禁用；
- 少于两个有效样本的序列不进入重建图。

## 2. 欧拉极到四元数

GPlates 在 [`UnitQuaternion3D.cc`](../GPlates/src/maths/UnitQuaternion3D.cc) 144–167 行构造：

```text
q.w   = cos(angle / 2)
q.xyz = sin(angle / 2) × axis
```

球面经纬度先转为单位向量：

```text
axis.x = cos(latitude) × cos(longitude)
axis.y = cos(latitude) × sin(longitude)
axis.z = sin(latitude)
```

Web 对应实现在 [`quaternion.ts`](../src/core/quaternion.ts) 的 `quaternionFromEulerPole()` 和 `lonLatToUnitVector()`。

## 3. 时间插值

GPlates 的最短路径 SLERP 位于 [`FiniteRotation.cc`](../GPlates/src/maths/FiniteRotation.cc) 365–451 行：

1. 计算 `dot(q1, q2)`；
2. 若点积为负，利用 `q` 与 `-q` 表示同一旋转的性质反转第二项权重；
3. 以 `(targetTime - t1) / (t2 - t1)` 为插值比例；
4. 在四元数单位球面上做球面线性插值并重新归一化。

Web 对应 `slerp()` 与 `interpolateSequence()`。

## 4. 重建树与乘法顺序

GPlates 在 [`ReconstructionTree.cc`](../GPlates/src/app-logic/ReconstructionTree.cc) 36–125 行选择包含当前时间的相邻旋转样本，在 129–142 行复合父子旋转：

```text
absoluteMoving = absoluteFixed × relativeFixedToMoving
```

底层 `compose(r1, r2)` 在 [`FiniteRotation.cc`](../GPlates/src/maths/FiniteRotation.cc) 493–507 行实现为：

```text
result = q1 × q2
```

这是 Hamilton 乘法且不可交换。Web 的 [`rotation-model.ts`](../src/core/rotation-model.ts) 保持相同的前乘顺序，并按 GPlates 的边插入优先级处理 crossover。对于反向树边使用相对四元数的共轭：

```text
absoluteFixed = absoluteMoving × inverse(relative)
```

## 5. 球面点旋转

GPlates 在 [`FiniteRotation.cc`](../GPlates/src/maths/FiniteRotation.cc) 272–307 行使用优化公式：

```text
v' = (2w² - 1)v + 2[w(qv × v) + (qv · v)qv]
```

Web 的 `rotateVector()` 使用同一公式。渲染时将 `{w,x,y,z}` 映射为 Cesium 构造顺序 `{x,y,z,w}`，再生成 4×4 球心旋转矩阵。

## 6. 几何重建语义

[`ReconstructMethodInterface.cc`](../GPlates/src/app-logic/ReconstructMethodInterface.cc) 68–87 行先取得 Plate ID 相对锚定板块的复合旋转，再把它作用于要素的 present-day geometry。

Web 采用同一语义：

1. GPML 坐标在当前参考位置完成一次球面剖分；
2. 同一 Plate ID 的所有几何实例合并成一个 Cesium `Primitive`；
3. 时间变化时只更新该 Primitive 的 `modelMatrix`；
4. GPML 有效时间只控制实例 `show` 属性，不改写顶点。

球面而非 WGS84 扁椭球是有意选择：GPlates 的刚性有限旋转定义在单位球面上，球心旋转在球面上保持半径与形状；任意轴旋转不能保持 WGS84 扁椭球面。

## 7. 时间轴

Cesium 内建 Timeline 使用 JulianDate 日历时间，不适合 `Ma` 地质年龄。应用因此使用自定义地质时间轴，但几何变换和相机仍完全由 CesiumJS 驱动。滑块向右代表更久远的地质过去，范围为 `0–1100 Ma`。
