# Pixel Mascot Design

> 状态: v3 已接入 TUI welcome。母版是 `apps/wukong/src/constant/mascot-data.json`，渲染入口是 `apps/wukong/src/tui/constant/welcome-art.ts`。

## 目标

`wukong_cli` 使用的形象应和 `wukong_web` 同源：一个可爱的像素小悟空。CLI 侧不能依赖 PNG 或复杂图像渲染，所以母版必须是字符栅格和 token palette。

核心要求：

- 每个像素都是可变的 token，不是整张图。
- 同一组帧可以渲染成 ANSI block、ASCII、braille 或 web DOM pixel。
- 默认气质是可爱、机灵、可靠，不是重甲战斗角色。
- TUI 使用 Unicode 半块把 29 x 22 母版压成 29 x 11，保持官网 palette 和轮廓。

## 数据结构

源文件导出：

```ts
import {
  WUKONG_MASCOT_FRAMES,
  WUKONG_MASCOT_FRAME_NAMES,
  renderWukongMascotGlyphRows,
} from '#/constant/mascot';
```

帧名：

| Frame | CLI 用途 |
|---|---|
| `idle` | welcome、空闲 |
| `blink` | idle animation |
| `scan` | `/scan`、风险检查、secret 检查 |
| `happy` | verify passed、无高风险 |
| `staff` | `/verify`、执行命令、生成报告 |

## Token Legend

| Token | Meaning | Terminal role |
|---|---|---|
| `D` | outline | dark contour |
| `F` / `H` | fur | brown base/highlight |
| `S` / `L` | face | amber base/highlight |
| `G` | gold circlet | bright yellow |
| `g` | circlet highlight | pale yellow |
| `E` | fire eye | green highlight |
| `U` | happy eye | dim curved glyph |
| `P` | cheek | pink/red accent |
| `N` | nose and mouth | dark glyph |
| `K` | staff | gold line |
| `R` | staff cap | red accent |
| `C` | scan beam | green scan line |
| `T` | tail | brown block |

## 接入建议

1. Welcome 区域：只显示 `idle -> blink -> idle -> happy`，避免抢输入焦点。
2. `/scan` 面板：使用 `scan`，火眼和扫描线改为主题 warning/accent 色。
3. `/verify` 面板：执行中使用 `staff`，通过后使用 `happy`。
4. `/guard` 面板：未来可增加 `warning` 帧，金箍收紧但不要做恐怖表情。
5. 小宽度终端：形象与文字改为上下排列，避免裁掉角色。

## 约束

- mascot 使用官网品牌 palette；TUI chrome 和说明文字继续使用 theme palette。
- 不把 mascot 做成不可跳过的长动画；终端工具首要任务仍是清楚输出。
- 不使用 emoji 作为核心形象，因为不同终端渲染不可控。
