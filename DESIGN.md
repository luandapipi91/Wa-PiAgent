---
version: alpha
name: WaPi Light
description: 一个干净、柔和、有层次感的浅色界面—— WaPi 的视觉语言。
  暖灰渐变背景（非纯白）承载近黑品牌字与柔和靛蓝强调色；卡片靠细边框和微阴影分层，
  大圆角贯穿全局；输入框是整页最精致的胶囊卡片，聚焦时靛蓝光晕呼吸。
colors:
  # —— 品牌与强调 ——
  brand: "#1D1D1F"
  brand-soft: "#2C2C2E"
  on-brand: "#FFFFFF"
  accent: "#5B5BD6"
  accent-soft: "#EEEEFF"
  on-accent: "#FFFFFF"
  # —— 文字层级 ——
  text-primary: "#1D1D1F"
  text-secondary: "#6E6E73"
  text-tertiary: "#A1A1A6"
  # —— 表面与背景 ——
  canvas: "#F5F5F7"
  canvas-grad-end: "#F0F0F3"
  surface: "#FFFFFF"
  surface-elevated: "#FAFAFA"
  surface-hover: "#F0F0F3"
  # —— 描边 ——
  hairline: "#E5E5EA"
  hairline-strong: "#D1D1D6"
  # —— 语义色 ——
  success: "#34A853"
  success-soft: "#E6F4EA"
  warning: "#B45309"
  warning-soft: "#FEF3C7"
  danger: "#DC2626"
  danger-soft: "#FEE2E2"
  on-danger: "#FFFFFF"
typography:
  display-lg:
    fontFamily: "MiSans, -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', 'Plus Jakarta Sans', sans-serif"
    fontSize: 26px
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.6px"
  display-md:
    fontFamily: "MiSans, -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', 'Plus Jakarta Sans', sans-serif"
    fontSize: 22px
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "-0.5px"
  title:
    fontFamily: "MiSans, -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', 'Plus Jakarta Sans', sans-serif"
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: 0
  body-md:
    fontFamily: "MiSans, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Plus Jakarta Sans', sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0
  body-sm:
    fontFamily: "MiSans, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Plus Jakarta Sans', sans-serif"
    fontSize: 13.5px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0
  caption:
    fontFamily: "MiSans, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Plus Jakarta Sans', sans-serif"
    fontSize: 11.5px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  label-caps:
    fontFamily: "MiSans, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Plus Jakarta Sans', sans-serif"
    fontSize: 11px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "0.6px"
  button:
    fontFamily: "MiSans, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Plus Jakarta Sans', sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0
  button-sm:
    fontFamily: "MiSans, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Plus Jakarta Sans', sans-serif"
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: 0
  mono:
    fontFamily: "'JetBrains Mono', MiSans, 'SF Mono', 'IBM Plex Mono', monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
rounded:
  none: 0px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 20px
  pill: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  base: 16px
  lg: 20px
  xl: 24px
  2xl: 32px
  sidebar-w: 264px
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-brand}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "11px 22px"
  button-primary-hover:
    backgroundColor: "{colors.brand-soft}"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.button-sm}"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
  button-ghost-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.brand}"
  button-danger-soft:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    typography: "{typography.button-sm}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  button-accent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.button-sm}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  send-button:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-brand}"
    rounded: "{rounded.sm}"
    padding: "0"
    size: "36px"
  send-button-disabled:
    backgroundColor: "{colors.hairline-strong}"
  msg-bubble-user:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.on-brand}"
    typography: "{typography.body-sm}"
    rounded: "14px 4px 14px 14px"
    padding: "10px 14px"
  msg-bubble-ai:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body-sm}"
    rounded: "4px 14px 14px 14px"
    padding: "10px 14px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
  sidebar:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.text-secondary}"
    width: "{spacing.sidebar-w}"
  sidebar-item:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "7px 8px"
  sidebar-item-hover:
    backgroundColor: "{colors.surface-hover}"
  sidebar-item-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
  sidebar-item-accent:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  topbar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    padding: "12px 20px"
  composer:
    backgroundColor: "{colors.canvas}"
    padding: "12px 24px 20px"
  composer-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "4px 6px 4px 14px"
  composer-card-focus:
    backgroundColor: "{colors.surface}"
  avatar-user:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.caption}"
    rounded: "{rounded.sm}"
    size: "30px"
  avatar-bot:
    backgroundColor: "transparent"
    rounded: "{rounded.sm}"
    size: "30px"
  fold-chip:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.text-tertiary}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: "3px 8px"
  fold-chip-ok:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success}"
  queue-panel:
    backgroundColor: "{colors.surface-elevated}"
    textColor: "{colors.text-secondary}"
    padding: "10px 20px"
  queue-steer:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.warning}"
    typography: "{typography.caption}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  new-session-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "0"
  empty-icon:
    backgroundColor: "linear-gradient(135deg, {colors.surface-elevated}, {colors.surface})"
    rounded: "{rounded.xl}"
    size: "72px"
  brand-mark:
    backgroundColor: "transparent"
    rounded: "7px"
    size: "28px"
---

## Overview

WaPi Light 是一套参考腾讯 Marvis 马维斯官网视觉语言的浅色设计系统。马维斯的设计
精髓在于"克制中的精致"——大面积暖灰留白、近黑的品牌字、极少的色彩干扰，靠层次和圆角
而非阴影堆砌来区分界面元素。

整套界面的基底是暖灰渐变画布 `{colors.canvas}`（#F5F5F7 → #F0F0F3），而非纯白。纯白
背景过于刺眼且扁平；暖灰带有温度，降低眩光的同时为白色卡片（`{colors.surface}`）提供
了一个可浮起的对比层。卡片与画布之间靠 1px `{colors.hairline}` 细边框 + 微阴影分层，
不用厚重的投影。

品牌色用近黑 `{colors.brand}`（#1D1D1F）——与马维斯 Logo 的纯黑（#0F0F0F）同源。近黑
同时承担"用户消息气泡"和"主 CTA 按钮"的高对比角色。唯一的强调色是柔和靛蓝
`{colors.accent}`（#5B5BD6），用于思考中状态、聚焦光晕、活跃会话行等需要"提亮"的场景，
用量克制，不喧宾夺主。

整页的记忆点是输入框：大圆角（`{rounded.lg}` = 16px）的胶囊卡片，聚焦时靛蓝光晕
（`box-shadow: 0 0 0 3px {colors.accent-soft}`）柔和呼吸——这是整页最精致的交互细节。

**Key Characteristics:**
- 暖灰渐变画布，永不使用纯白背景——纯白仅限于卡片表面 `{colors.surface}`。
- 近黑品牌色 `{colors.brand}` 承载所有高对比 CTA 和用户消息气泡。
- 单一强调色 `{colors.accent}`（靛蓝）用于交互反馈和聚焦态，全页用量 < 10%。
- 大圆角贯穿全局：卡片 16px、按钮 8-12px、头像 9px，柔和一致。
- 输入框胶囊卡片是整页记忆点——聚焦时靛蓝光晕呼吸。
- 字重对比强烈：标题 800 vs 正文 400，靠字重而非字号建立层级。

## Colors

### Brand & Accent
- **Brand**（`{colors.brand}` — #1D1D1F）：近黑品牌主色。用于 Logo、主 CTA 按钮
  背景、用户消息气泡背景。高对比但不纯黑，比 #000 更柔和。
- **Accent**（`{colors.accent}` — #5B5BD6）：柔和靛蓝。唯一的强调色，用于思考中
  状态指示、输入框聚焦光晕、活跃会话行高亮、品牌强调链接。用量极其克制。
- **Accent Soft**（`{colors.accent-soft}` — #EEEEFF）：靛蓝的浅底版本。用于活跃
  会话行背景、聚焦光晕的扩散层。

### Surface
- **Canvas**（`{colors.canvas}` — #F5F5F7）：页面主背景。暖灰，带轻微渐变到
  `{colors.canvas-grad-end}`（#F0F0F3），营造深度。永不使用纯白做主背景。
- **Surface**（`{colors.surface}` — #FFFFFF）：卡片表面。纯白，用于消息气泡、
  输入框卡片、弹窗等需要"浮起"的元素。是界面中唯一的纯白。
- **Surface Elevated**（`{colors.surface-elevated}` — #FAFAFA）：次级表面。用于
  侧边栏、队列面板、折叠块背景——比主背景稍浅，比卡片稍灰。
- **Surface Hover**（`{colors.surface-hover}` — #F0F0F3）：悬停态背景。

### Hairlines
- **Hairline**（`{colors.hairline}` — #E5E5EA）：默认描边色。用于卡片边框、
  分割线、输入框边框。1px，极淡。
- **Hairline Strong**（`{colors.hairline-strong}` — #D1D1D6）：强调描边色。用于
  虚线按钮边框、禁用态背景。

### Text
- **Text Primary**（`{colors.text-primary}` — #1D1D1F）：主文字色。与品牌色相同，
  用于标题、正文、强调内容。
- **Text Secondary**（`{colors.text-secondary}` — #6E6E73）：次级文字。用于元信息、
  侧边栏项、描述性文字。
- **Text Tertiary**（`{colors.text-tertiary}` — #A1A1A6）：占位符、提示文字、
  不可交互的辅助信息。

### Semantic
- **Success**（`{colors.success}` — #34A853）：成功状态。工具调用完成 ✓、idle 状态点。
- **Danger**（`{colors.danger}` — #DC2626）：危险/错误。停止按钮、错误消息。
- **Warning**（`{colors.warning}` — #B45309）：引导中状态。排队队列的引导消息。

## Typography

字体系统基于苹果系统字体栈，优先 SF Pro Display / SF Pro Text，中文回退 PingFang SC。
不使用 Inter、Roboto 等泛用字体——它们太常见，缺乏辨识度。

| Token | Family | Size | Weight | Line Height | Letter Spacing | 用途 |
|---|---|---|---|---|---|---|
| `{typography.display-lg}` | SF Pro / PingFang | 26px | 800 | 1.15 | -0.6px | 新建会话页主标题 |
| `{typography.display-md}` | SF Pro / PingFang | 22px | 800 | 1.2 | -0.5px | 空状态标题 |
| `{typography.title}` | SF Pro / PingFang | 14px | 700 | 1.3 | 0 | 顶部栏会话标题 |
| `{typography.body-md}` | SF Pro / PingFang | 14px | 400 | 1.55 | 0 | 输入框文字、正文 |
| `{typography.body-sm}` | SF Pro / PingFang | 13.5px | 400 | 1.55 | 0 | 消息气泡文字 |
| `{typography.caption}` | SF Pro / PingFang | 11.5px | 400 | 1.4 | 0 | 元信息、折叠块标签 |
| `{typography.label-caps}` | SF Pro / PingFang | 11px | 700 | 1.4 | 0.6px | 侧边栏分组标题（大写） |
| `{typography.button}` | SF Pro / PingFang | 14px | 600 | 1 | 0 | 主按钮文字 |
| `{typography.button-sm}` | SF Pro / PingFang | 12px | 600 | 1 | 0 | 次级按钮、标签按钮 |
| `{typography.mono}` | SF Mono / JetBrains Mono | 12px | 400 | 1.5 | 0 | 代码、工具调用参数 |

### Principles
字重对比（800 vs 400）是建立层级的主要手段，而非字号跳跃。标题靠粗字重 + 负字距
（-0.5px ~ -0.6px）产生紧凑感；正文保持 1.55 行高确保可读性。侧边栏分组标题用
大写 + 0.6px 正字距，与正文形成节奏区分。

### Note on Font Substitutes
SF Pro 和 PingFang SC 是 Apple 平台原生字体，在非 Apple 环境下回退到
'Plus Jakarta Sans' → 系统 sans-serif。代码字体回退到 'JetBrains Mono' → 'IBM Plex Mono'
→ 系统 monospace。不引入网络字体加载，保证首屏速度。

## Layout

间距系统采用 t-shirt 尺寸 + 语义命名混合制：

| Token | Value | 典型用途 |
|---|---|---|
| `{spacing.xs}` | 4px | 微间距、图标与文字间距 |
| `{spacing.sm}` | 8px | 小间距、列表项内边距 |
| `{spacing.md}` | 12px | 中间距、卡片内边距 |
| `{spacing.base}` | 16px | 基准间距、消息间距 |
| `{spacing.lg}` | 20px | 大间距、卡片 padding、顶部栏 |
| `{spacing.xl}` | 24px | 超大间距、消息列表 padding |
| `{spacing.2xl}` | 32px | 区块间距 |
| `{spacing.sidebar-w}` | 264px | 侧边栏固定宽度 |

整体布局是经典的「固定侧边栏 + 自适应主区」双栏结构。侧边栏 `{spacing.sidebar-w}`
（264px）固定不动，主区 flex-1 填充剩余空间。消息列表区域内容最大宽度约束在 78%
避免长行不可读。输入框卡片最大宽度 860px 居中，保证大屏下输入区不会过宽。

留白哲学：宁可多留，不要拥挤。消息之间 16px 间距，区块之间用 padding 而非分割线
分隔。侧边栏项目之间 6px 间距，密集但不压迫。

## Elevation & Depth

这套系统刻意压制阴影的使用——深度感主要靠「背景色差 + 细边框」而非投影实现。
仅在三处使用阴影，每处都是多层柔和叠加：

| 层级 | 定义 | 用途 |
|---|---|---|
| `shadow-sm` | `0 1px 2px rgba(0,0,0,.04), 0 1px 3px rgba(0,0,0,.03)` | 活跃侧边栏项、AI 消息气泡、头像 |
| `shadow-md` | `0 4px 12px rgba(0,0,0,.06), 0 2px 4px rgba(0,0,0,.04)` | 输入框卡片、空状态图标、按钮悬停 |
| `shadow-lg` | `0 12px 32px rgba(0,0,0,.08), 0 4px 8px rgba(0,0,0,.04)` | 整体 frame 外壳、弹窗 |

所有阴影透明度极低（0.03 ~ 0.08），多层叠加产生柔和感而非硬边。绝不使用单层高透明度阴影。

输入框聚焦态不使用阴影，而是用 `box-shadow: 0 0 0 3px {colors.accent-soft}` 形成靛蓝
光环——这是马维斯风格的典型手法：用色彩光晕代替投影表达焦点。

## Shapes

圆角是这套系统最统一的视觉特征，所有元素都遵循同一套圆角阶梯：

| Token | Value | 用途 |
|---|---|---|
| `{rounded.none}` | 0px | 无圆角（极少使用） |
| `{rounded.sm}` | 8px | 按钮、侧边栏项、头像、ghost 按钮 |
| `{rounded.md}` | 12px | 中型卡片、新建会话按钮 |
| `{rounded.lg}` | 16px | 输入框卡片、新建会话卡片、消息列表容器 |
| `{rounded.xl}` | 20px | 空状态图标、frame 外壳 |
| `{rounded.pill}` | 9999px | CTA 按钮、状态标签、停止按钮 |

消息气泡是特殊的非对称圆角：用户气泡 `14px 4px 14px 14px`（右上角小圆角指向头像），
AI 气泡 `4px 14px 14px 14px`（左上角小圆角指向头像），形成"对话指向感"。

## Components

**`button-primary`** — 主 CTA 按钮。背景 `{colors.brand}`，文字 `{colors.on-brand}`，
字号 `{typography.button}`，padding 11px × 22px，圆角 `{rounded.pill}`。用于"新建项目"、
"发送"等核心动作。悬停态 `button-primary-hover` 背景微调到 `{colors.brand-soft}`。
带 `{shadow-md}` 阴影，悬停时 translateY(-1px) 微浮起。

**`button-ghost`** — 次级/幽灵按钮。背景 `{colors.surface}`，文字
`{colors.text-secondary}`，字号 `{typography.button-sm}`，padding 6px × 12px，圆角
`{rounded.sm}`，1px `{colors.hairline}` 边框。用于"编排画布"等次要操作。悬停态
边框和文字变为 `{colors.brand}`。

**`button-danger-soft`** — 危险软按钮。背景 `{colors.danger-soft}`，文字 `{colors.danger}`，
圆角 `{rounded.pill}`。用于"停止"运行中的 agent。语义清晰但不刺眼。

**`send-button`** — 发送按钮（输入框内）。36px × 36px 方形，背景 `{colors.brand}`，
圆角 `{rounded.sm}`（10px），居中箭头图标。禁用态背景变 `{colors.hairline-strong}`。
非禁用悬停时 scale(1.05) 微放大——唯一的微交互动效。

**`msg-bubble-user`** — 用户消息气泡。背景 `{colors.brand}`（近黑），文字
`{colors.on-brand}`（白），非对称圆角 `14px 4px 14px 14px`，padding 10px × 14px。
右对齐，最大宽度 78%。高对比，强调"这是你说的"。

**`msg-bubble-ai`** — AI 消息气泡。背景 `{colors.surface}`（白），文字
`{colors.text-primary}`，1px `{colors.hairline}` 边框，`{shadow-sm}` 微阴影，
非对称圆角 `4px 14px 14px 14px`。弱化卡片感，强调内容本身。

**`card`** — 通用内容卡片。背景 `{colors.surface}`，圆角 `{rounded.lg}`，padding
`{spacing.lg}`。用于新建会话输入区、配置面板等。

**`sidebar`** — 侧边栏容器。宽 `{spacing.sidebar-w}`（264px），背景
`{colors.surface-elevated}`，右侧 1px `{colors.hairline}` 分割线。

**`sidebar-item`** — 侧边栏列表项。默认透明背景、`{colors.text-secondary}` 文字，
圆角 `{rounded.sm}`，padding 7px × 8px。悬停态背景变 `{colors.surface-hover}`。
活跃态有两种：普通活跃用白底 + `{shadow-sm}`；强调活跃（当前会话）用
`{colors.accent-soft}` 底 + `{colors.accent}` 文字。

**`topbar`** — 顶部状态栏。背景 `{colors.surface}`，底部 1px `{colors.hairline}`
分割线，padding 12px × 20px。包含 agent 头像、会话标题、元信息和操作按钮。

**`composer`** — 输入框区。背景 `{colors.canvas}`（与主区一致），padding
12px × 24px × 20px。内含 `composer-card`。

**`composer-card`** — 输入框卡片（记忆点）。背景 `{colors.surface}`，1px
`{colors.hairline}` 边框，圆角 `{rounded.lg}`（16px），`{shadow-md}` 阴影。
聚焦时边框变 `{colors.accent}`，叠加 `0 0 0 3px {colors.accent-soft}` 光晕——
整页最精致的交互。最大宽度 860px 居中。

**`avatar-user`** — 用户头像。30px 圆角方形（`{rounded.sm}`），透明底（无填充），
灰色文字（`{colors.text-secondary}`）"我"。靠 emoji/文字本身区分角色，不加背景色块。

**`avatar-bot`** — AI 头像。30px 圆角方形，透明底（无填充），🤖 emoji。
不使用渐变背景，保持视觉干净。

**`fold-chip`** — 折叠块标签（思考过程/工具调用）。药丸形（`{rounded.pill}`），
`{colors.surface-elevated}` 背景，1px `{colors.hairline}` 边框，
`{typography.caption}` 字号。成功态 `fold-chip-ok` 用 `{colors.success-soft}` 底 +
`{colors.success}` 文字。

**`queue-panel`** — 运行队列面板。背景 `{colors.surface-elevated}`，底部 1px 分割线。
agent 运行中时显示，含 spinner 动画、计时器、停止按钮。

**`queue-steer`** — 引导消息块。背景 `{colors.warning-soft}`，左侧 3px
`{colors.warning}` 竖线，`{typography.caption}` 字号。

**`empty-icon`** — 空状态图标。72px 圆角方形（`{rounded.xl}`），浅灰渐变背景，
1px 边框，`{shadow-md}`，居中大 emoji。

**`brand-mark`** — 品牌 Logo 标识。28px 圆角方形（7px），使用项目根目录的
`logo.svg`（翠绿底 + 线稿青蛙图标），不再使用渐变色块 + 字母占位。

## Do's and Don'ts

### Do
- ✅ 用暖灰渐变 `{colors.canvas}` 做主背景，纯白只留给卡片表面。
- ✅ 用户消息气泡用品牌深色，AI 消息用白卡片——靠对比区分角色。
- ✅ 输入框聚焦时用靛蓝光晕表达焦点，不用边框加粗或阴影。
- ✅ 圆角统一使用 token 阶梯，消息气泡用非对称圆角产生指向感。
- ✅ 字重对比（800 vs 400）建立层级，不靠多级字号跳跃。
- ✅ 语义色配浅底（success-soft / danger-soft），主色仅用于文字或小面积。
- ✅ 阴影多层低透明度叠加，绝不单层高透明度硬阴影。

### Don't
- ❌ 不要用纯白 #FFFFFF 做页面主背景——太刺眼且扁平。
- ❌ 不要用泛用字体（Inter、Roboto、Arial）——缺乏辨识度。
- ❌ 不要用厚重投影分层——靠背景色差 + 细边框就够了。
- ❌ 不要在同一界面混用暗色和浅色元素——全套浅色，保持一致。
- ❌ 不要让强调色 `{colors.accent}` 出现在 > 10% 的面积——它是点缀不是主色。
- ❌ 不要在加载状态省略反馈——100ms 内必须有视觉响应。
- ❌ 不要在表单错误时清空用户输入——保留内容，高亮错误。
