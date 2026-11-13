# SingleRaster + Colorbar 可视化 MVP

## 数据契约

所有输入栅格按统一全球配准处理：

- CRS：`EPSG:4326`
- 左上角：`180°W, 90°N`
- 右下角：`180°E, 90°S`
- GDAL 注册参数：`-a_ullr -180 90 180 -90`

数值栅格先使用对应 GMT CPT 色带转换为 RGBA，再重投影到
`EPSG:3857` 并生成 PNG MBTiles。NaN/NoData 像元保持透明，因此海底年龄
和扩张速率图层可以叠加在古地理底图上。

## 当前映射

| 栅格 | 默认色带 | 数值范围 |
| --- | --- | --- |
| PALEOMAP 古高程 | `elevation_scotese.cpt` | -11,000–10,500 m |
| 0/15 Ma 近地表温度 | `thermal.cpt` | -40–40 °C |
| 四组海底年龄 | `agegrid.cpt` | 0–350/443 Ma |
| 海底扩张速率分带 | `batlow.cpt` | class 1–5 |
| PALEOMAP JPG | 已着色参考图 | 无额外色带 |

温度原始网格只有 `361 × 180`，因此只生成 z0–z1；其余全球高分辨率网格
和参考 JPG 生成 z0–z4。低分辨率温度图放大后出现块状像元属于源数据分辨率，
不是瓦片服务降质。

## 生成与运行

```bash
npm run data:rasters
npm run serve:atlas
npm run dev -- --port 5174
```

打开 `http://127.0.0.1:5174/`，使用左侧“栅格色带验证”面板切换数据集、
开关图层和调整透明度。

Martin 同时挂载：

```text
data/generated/paleoatlas
data/generated/single-raster
```

浏览器使用的清单：

```text
http://127.0.0.1:5174/single-raster-data/manifest.json
```

## 验证

```bash
npm run test:rasters -- http://127.0.0.1:5174/
```

验收脚本逐一切换 9 个栅格，检查 8 个色带图例、图层开关、透明度和所有
Martin source。HTTP 200 表示有效 PNG；HTTP 204 表示 NoData 区域的全透明
空瓦片，两者都属于正常响应。
