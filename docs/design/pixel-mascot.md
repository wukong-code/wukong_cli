# Pixel Mascot Design

> 状态: v1 数据帧已落地在 `apps/wukong/src/constant/mascot.ts`，暂未挂入 TUI 默认启动流程。

## 目标

`wukong_cli` 使用的形象应和 `wukong_web` 同源：一个可爱的像素小悟空。CLI 侧不能依赖 PNG 或复杂图像渲染，所以母版必须是字符栅格和 token palette。

核心要求：

- 每个像素都是可变的 token，不是整张图。
- 同一组帧可以渲染成 ANSI block、ASCII、braille 或 web DOM pixel。
- 默认气质是可爱、机灵、可靠，不是重甲战斗角色。

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
| `F` | fur | amber/brown block |
| `S` | face | yellow/orange block |
| `G` | gold circlet | bright yellow |
| `g` | circlet highlight | pale yellow |
| `E` | fire eye | green highlight |
| `U` | happy eye | dim curved glyph |
| `P` | cheek | pink/red accent |
| `M` | muzzle | pale block |
| `N` | nose and mouth | dark glyph |
| `K` | staff | gold line |
| `C` | scan beam | green scan line |

## Plain glyph preview

```text
         ▀▀▀
       ▀▀▄▄▄▀▀
      █████████
    ████▓▓▓▓▓████
   ███▓▓▓▓▓▓▓▓▓███
  ███▓▓▓▓▓▓▓▓▓▓▓███
 ███▓▓▓◆▓▓▓▓▓◆▓▓▓███
 ███▓▓▓▓▓•▓▓•▓▓▓▓███
  ███▓▓▓▓▓▪▓▓▓▓▓███
  ███▓▓░░░░░░░▓▓███
   ███▓▓░▪▪▪░▓▓███
    ███▓▓▓▓▓▓▓███
      ███▓▓▓███
       ██▓▓▓██
       █▓▓▓▓▓█   ━
      ██▓▓▓▓▓██  ━
       ██   ██  ━
      ██     ██━
```

## 接入建议

1. Welcome 区域：只显示 `idle -> blink -> idle -> happy`，避免抢输入焦点。
2. `/scan` 面板：使用 `scan`，火眼和扫描线改为主题 warning/accent 色。
3. `/verify` 面板：执行中使用 `staff`，通过后使用 `happy`。
4. `/guard` 面板：未来可增加 `warning` 帧，金箍收紧但不要做恐怖表情。
5. 小宽度终端：低于 60 columns 不显示完整像素图，只显示一行 `Wukong` 状态文案。

## 约束

- 不在 TUI 组件里直接硬编码颜色；接入时通过 theme palette 映射 token。
- 不把 mascot 做成不可跳过的长动画；终端工具首要任务仍是清楚输出。
- 不使用 emoji 作为核心形象，因为不同终端渲染不可控。
