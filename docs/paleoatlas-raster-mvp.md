# PALEOMAP 时间图集 Raster 瓦片方案

## 验证范围

全量流程处理目录中全部 90 张原始 JPG，年代范围为 0–750 Ma。源图年代
并非严格每 5 Ma 一张，因此这里区分两个概念：

- 90 个“源数据帧”：只使用真实存在的 JPG 年代；
- 151 个“时间轴节点”：按 0、5、10 … 750 Ma 验证，缺少精确源帧时选择
  距离最近的真实帧，不生成伪插值图像。

输入图片采用已经确认的数据契约：

- 坐标参考系：`EPSG:4326`
- 左上角：`180°W, 90°N`
- 右下角：`180°E, 90°S`
- GDAL 注册参数：`-a_ullr -180 90 180 -90`

脚本将每帧重投影为 EPSG:3857，生成 z0–z4、256 像素 JPEG MBTiles。
JPEG 编码质量设为 95，并且最高层 z4 的全球横向像素数为 4096，与原图
3600 像素宽度接近，避免无意义的高倍放大。瓦片化改变的是传输和加载方式，
不会主动降低地图的显示分辨率。标准 Web Mercator 的有效纬度为约
`±85.0511°`，因此极区不属于本流程的正确性范围。

## 数据链路

```text
PALEOMAP JPG
  → GDAL 注册与重投影
  → 每时间帧一个 MBTiles
  → Martin 127.0.0.1:3002
  → Vite /atlas-tiles 同源代理
  → Cesium UrlTemplateImageryProvider
  → GeologicalTimeline
```

生成脚本：

```bash
npm run data:atlas
```

输出目录：

```text
data/generated/paleoatlas
```

其中 `manifest.json` 是浏览器使用的数据契约，不允许前端从文件名临时推断时间。

## 本地运行

终端一，启动 Raster Martin：

```bash
npm run serve:atlas
```

终端二，启动 TimeMachineWeb：

```bash
npm run dev
```

打开：

```text
http://127.0.0.1:5173/
```

若 5173 已被占用，可用 `npm run dev -- --port 5174`，再打开
`http://127.0.0.1:5174/`。

Martin 配置：

```text
deploy/martin/paleoatlas.yaml
```

主要接口：

```text
http://127.0.0.1:3002/atlas-tiles/catalog
http://127.0.0.1:3002/atlas-tiles/paleoatlas_000
http://127.0.0.1:3002/atlas-tiles/paleoatlas_000/{z}/{x}/{y}
http://127.0.0.1:5173/atlas-data/manifest.json
```

## 时间行为

- 时间轴仍然输出连续的 `timeMa`。
- 图集只在解析出的实际帧 ID 发生变化时切换，避免每个动画帧重建 Cesium 图层。
- 两帧距离相同时选择较年轻的一帧。
- 相邻帧的根瓦片会被预热。
- 切换采用 220 ms 双图层淡入淡出。
- 超出 0–750 Ma 时隐藏图集，不把边界帧冒充为无数据年代。
- 图集加载失败不会阻止板块模型和点数据继续运行。

## 验证

在 Martin 与 Vite 已启动时运行：

```bash
npm run test:atlas -- http://127.0.0.1:5174/
```

验收脚本检查：

- 90 个真实源帧均逐帧进入 `ready`；
- 0–750 Ma 的全部 151 个 5 Ma 节点均解析到正确的最近源帧；
- 755 Ma 的越界隐藏；
- 图集开关关闭与恢复；
- 90 个 Martin source 都产生实际瓦片请求；
- 所有观测到的图集瓦片响应均为 HTTP 200；
- 页面没有 Console Error 或未捕获异常。

八帧快速回归仍可使用 `data:atlas:mvp`、`serve:atlas:mvp`，但正式全量
验证以本页的无 `:mvp` 命令为准。
