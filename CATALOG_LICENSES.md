# 天文目录来源与许可

本项目生成的目录快照保留以下来源的署名与许可要求：

## OpenNGC

- 项目：https://github.com/mattiaverga/OpenNGC
- 使用版本：v20260501，`database_files/NGC.csv`
- 用途：`static/deep-sky.json`、`static/messier.json` 与 `data/catalog.sqlite3` 中的 NGC/IC 数据
- 许可：Creative Commons Attribution-ShareAlike 4.0 International（CC BY-SA 4.0）
- 本项目的改动：排除标记为不存在或重复且没有独立坐标的条目；规范化编号；选择显示字段；生成搜索索引与紧凑 JSON。

## AT-HYG

- 项目：https://github.com/astronexus/ATHYG-Database
- 使用版本：v3.2，`athyg_32_reduced_m10.csv.gz`
- 用途：`data/stars-m10.npy` 与 `data/catalog.sqlite3` 中的恒星、名称及交叉编号
- 许可：Creative Commons Attribution-ShareAlike 4.0 International（CC BY-SA 4.0）
- 本项目的改动：选择绘图和搜索字段；转换为 NumPy 内存映射数组与 SQLite 索引；前端按视野和极限星等筛选。

AT-HYG 汇编了 Tycho-2、Gaia DR3、Hipparcos、Henry Draper、Harvard Revised／Yale Bright Star、Gliese 与 HYG 等来源。更完整的上游来源说明见 AT-HYG 的 `version-info.md` 和 `ACKNOWLEDGMENTS.md`。

上述目录的衍生数据按 CC BY-SA 4.0 提供；应用程序代码的许可不改变这些目录数据自身的许可。
