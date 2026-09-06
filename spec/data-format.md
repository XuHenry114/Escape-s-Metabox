# 卡片转录数据格式规范（Escape's Metabox 关卡数据）

## 背景

来源：洛谷题解文章《爆肝万余字！2026 年洛谷愚人节比赛 O 题 T722404 Escape's Metabox 题解》中的
57 张「结构地图」图片。每张图是 7×7 = 49 张卡片，卡片标有 `#编号`、`大字状态`、`Xms/YYY` 三行信息。

游戏机制（总结自文章机制介绍）：
- 每个编号盒子 N (1..50) 有固定的 7×7 内部结构（本数据）。
- 玩家 AC 从 1 号盒子出发，穿过 2..49 号盒子，到达 50 号盒子（出口）。
- 卡片含义：
  - 大字 `WA` = 空地（可走）；`AC` = 主角（玩家初始/当前所在格，可走）。
  - 大字 `MLE/TLE/UKE` = 盒子，第二行 `Xms/YYY` 表明它是 X 号盒子的实例：
    - `YYY = 0B`：正常盒子，可推可进出。
    - `YYY = 1.00MB`（即 1MB）：单向盒，进去会转移到 X 号盒子对应的 0B 盒。
    - `YYY = 999.00MB`（即 999MB）：墙壁，不可推不可走。
  - 大字 `TLE` = 这个空间本身是 TLE 型（每次进入开辟新层、直接退出恢复初始状态）。
  - 大字 `UKE` = 这个空间本身是 UKE 型（共用空间；直接进入会把该盒子的空间信息改为 0B，即标记）。
  - 大字 `MLE` = 稳定共用空间的普通盒。
  - `0ms/0B` 用于 WA/AC 格（属于"当前空间"的空地）。

## 每张图的输出 JSON 文件

文件名：`data/box-{N:02d}.json`（N=1..50 或 0/51/52/53 彩蛋），内容：

```json
{
  "space": 2,                      // 盒子编号；0 表示彩蛋/悖论关
  "type": "MLE",                   // 该空间类型：MLE | TLE | UKE（由图中卡片大字确定）
  "ac": 22,                        // 该空间图的 AC 卡编号（1..49），玩家的进入/出生位置
  "cells": [                       // 长度 49，索引 0..48 对应卡号 1..49
    {"id": 1, "label": "MLE", "space": 2, "size": "999.00MB"},
    {"id": 2, "label": "MLE", "space": 2, "size": "999.00MB"},
    ...
    {"id": 23, "label": "AC", "space": 0, "size": "0B"},
    {"id": 27, "label": "MLE", "space": 2, "size": "0B"}
  ]
}
```

## 逐字段规则

| 字段 | 说明 |
|---|---|
| `space` | 盒子编号（1..50）。彩蛋关用 0（虚空悖论）等特殊值，转录时照抄图中数字。 |
| `type` | 本图所属空间的类型 = 图中卡片大字。若一张图里大字一致（通常如此）则照抄；若有混合，取最大多数并记录到 `notes`。 |
| `ac` | 图里大字 AC 的卡编号（每张图恰好 1 个，从 1 号盒开始所有图都有）。 |
| `cells[i].id` | 卡号 1..49（**必须与下标 i+1 一致**）。 |
| `cells[i].label` | 大字：`MLE` / `TLE` / `UKE` / `WA` / `AC`。 |
| `cells[i].space` | 第二行 `Xms/...` 的 X（0..50）。WA/AC 格是 0。 |
| `cells[i].size` | 第二行 `.../YYY`，原样字符串：`0B` / `1.00MB` / `999.00MB`。 |

## 读取规范（重要，抄错会毁掉整个游戏）

1. 用 `read_image` 工具查看 `D:\workplace\maps_png\<文件>.png`（已从 webp 转为 png）。
2. 图像是 7 列 × 7 行卡片（有的图顶部有标题行，勿计入）。行主序：i = (row-1)*7 + (col-1)。
3. **逐张卡片读出三样东西**：#编号（左上角）、大字（中间）、第二行（底部）。例如 `#23 / AC / 0ms/0B` → `{"id":23,"label":"AC","space":0,"size":"0B"}`。
4. 卡片上若有水印（如 "Memory Limit Exceeded" 或 "洛谷" 字样叠加在卡片上），**忽略水印**，以原始文本为准。
5. 图文件中可能包含不是 7 列 7 行的（如勘误评论截图），跳过并在 `notes` 里说明。
6. 编写 JSON 时使用 `write` 工具，确保 49 条记录、id 连续、`ac` 对应 AC 卡。
7. 最后 `notes`：可选，记录任何不确定点（例如某卡片文字被遮挡、字号模糊等）。

## 图片清单（文件 → 盒子编号）

| 盒子 | 文件 |
|---|---|
| 1ms | 2ef5r1lw.png |
| 2ms | 5tyw1ep3.png |
| 3ms | xlidsiog.png |
| 4ms | qsjyeg6i.png |
| 5ms | 8fo42nxs.png |
| 6ms | vfdow8vn.png |
| 7ms | r662vozf.png |
| 8ms | vuncicgt.png |
| 9ms | sify497u.png |
| 10ms | iy2qb1y1.png |
| 11ms | lzzdejyn.png |
| 12ms | zr96hd8p.png |
| 13ms | wabr5t49.png |
| 14ms | h1fkdpth.png |
| 15ms | 8m7vp051.png |
| 16ms | kx8czy8l.png |
| 17ms | esibzfaw.png |
| 18ms | d4zjcnd8.png |
| 19ms | qw1ulw61.png |
| 20ms | 1i80oje1.png |
| 21ms | ss9mpkf6.png |
| 22ms | 24v472e7.png |
| 23ms | 516u0yuc.png |
| 24ms | pecgjv0e.png |
| 25ms | yasaeg2c.png |
| 26ms | nvxu1l5i.png |
| 27ms | j7ymjdag.png |
| 28ms | w7p7vuhe.png |
| 29ms | 2s607qb4.png |
| 30ms | uxgmt8hu.png |
| 31ms | bzf3tlnt.png |
| 32ms | on8s4cno.png |
| 33ms | qkt4g1ge.png |
| 34ms | todd02ma.png |
| 35ms | j0dktmhi.png |
| 36ms | xccvkeak.png |
| 37ms | 7qu64obw.png |
| 38ms | u84fewxt.png |
| 39ms | xffvlw6a.png |
| 40ms | mpuqf6ak.png |
| 41ms | llbsiwo1.png |
| 42ms | 13ncwg1t.png |
| 43ms | kzh1c2k7.png |
| 44ms | tj5lhf1r.png |
| 45ms | 68oeamej.png |
| 46ms | b5ahoye7.png |
| 47ms | 1ph4ncno.png |
| 48ms | uj5x0wfg.png |
| 49ms | 7w70u1ky.png |
| 50ms | gh65c71r.png |
| 彩蛋 WA114514 | gg6j50k4.png |
| 彩蛋 WA999 | 9gxue1rz.png |
| 彩蛋 WA1 | 30vm6e3e.png |
| 彩蛋 WA0 | dcij9kmx.png |
| （勘误评论截图，跳过） | c4pd3dcs.png, jzvl3gul.png, sis865vs.png |

图片文件都在 `D:\workplace\maps_png\` 目录。
