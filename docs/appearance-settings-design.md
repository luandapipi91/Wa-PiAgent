# 外观设置设计文档

**日期**: 2026-08-10  
**状态**: Draft  
**作者**: co (PM) + 用户

---

## 1. 问题陈述

当前应用只有浅色主题 + 固定绿色品牌色，用户无法自定义界面外观。需要在设置中新增「外观」选项卡，支持：
- **明暗主题切换**（跟随系统 / 浅色 / 深色）—— 完整实现深色模式
- **主题颜色切换**（绿 / 蓝 / 紫 / 黄 / 橙 / 红）
- **字体大小**（从「通用」迁移到「外观」）

### 证据
- 当前 `styles.css` 所有 CSS 变量只有浅色定义，无 `prefers-color-scheme` 支持
- 品牌色硬编码为 `#4ba26f`，无法切换
- 字体大小在「通用」设置中，逻辑上更适合放在「外观」

---

## 2. 已确认的设计决策

### 2.1 深色模式风格：深灰风格（方案 A）

灵感来源：macOS / GitHub Dark / VS Code

| 变量 | 浅色值 | 深色值 |
|------|--------|--------|
| `--canvas` | `#f5f5f7` | `#1a1a1e` |
| `--canvas-grad-end` | `#f0f0f3` | `#131315` |
| `--surface` | `#ffffff` | `#2c2c2e` |
| `--surface-elevated` | `#fafafa` | `#343436` |
| `--surface-hover` | `#f0f0f3` | `#38383a` |
| `--text-primary` | `#1d1d1f` | `#f5f5f7` |
| `--text-secondary` | `#6e6e73` | `#aeaeb2` |
| `--text-tertiary` | `#a1a1a6` | `#8e8e93` |
| `--hairline` | `#e5e5ea` | `#38383a` |
| `--hairline-strong` | `#d1d1d6` | `#48484a` |

### 2.2 主题颜色（6 种）

| 名称 | key | 色值 | 深色模式色值（调亮） | 备注 |
|------|-----|------|---------------------|------|
| 青蛙绿 | `green` | `#4BA26F` | `#5CB87F` | 默认 |
| 天际蓝 | `blue` | `#3B82F6` | `#5B9BFA` | 新增 |
| 靛紫 | `purple` | `#7C5CF6` | `#957FFA` | |
| 深琥珀 | `yellow` | `#C8941F` | `#DCAE42` | 偏褐 |
| 活力橙 | `orange` | `#ED7D2D` | `#F59648` | |
| 玫瑰红 | `red` | `#F0556B` | `#F47085` | 调浅 |

**accent-soft 策略**：浅色模式用固定浅色值（如绿色 `#e8f5ee`），深色模式用 `rgba` 半透明叠加（如绿色 `rgba(75,162,111,0.15)`），自动适配深色背景。

### 2.3 UI 布局

三个控件，全部**即时生效**，无需保存按钮：
- **界面主题**：分段控制器（跟随系统 / 浅色 / 深色），带 emoji 图标
- **主题颜色**：6 个圆点色块，点击选中，选中态有 ✓ 标记 + 外圈高亮
- **文字大小**：滑块（12-32px），与当前通用设置一致，迁移过来

---

## 3. 方案概述

### 3.1 CSS 变量架构

当前所有设计 token 在 `:root` 中定义。重构为**属性选择器分层**架构：

```css
/* 基础色板：明暗模式控制 canvas/surface/text/hairline */
:root, :root[data-theme="light"] { /* 浅色 token */ }
:root[data-theme="dark"] { /* 深色 token */ }

/* 主题颜色：只控制 brand/accent/accent-soft/on-brand/on-accent */
:root[data-accent="green"][data-theme="light"] { --brand: #4ba26f; ... }
:root[data-accent="green"][data-theme="dark"] { --brand: #5cb87f; ... }
/* ... 其余 5 种颜色，每种 × 2 模式 = 12 组 */
```

`<html>` 元素上设置两个 data 属性：
- `data-theme="light|dark"` — 明暗模式（system 模式在 JS 侧解析为实际值后设置）
- `data-accent="green|blue|purple|yellow|orange|red"` — 主题颜色

### 3.2 主题应用机制（JS 侧）

在 `ui-prefs.ts` 中新增两个 apply 函数（与现有 `applyFontSize` 模式一致）：

```typescript
/** 解析 system 模式的实际值 */
function resolveThemeMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark' : 'light';
}

/** 应用明暗模式到 <html data-theme> */
function applyThemeMode(mode: ThemeMode) {
  document.documentElement.dataset.theme = resolveThemeMode(mode);
}

/** 应用主题颜色到 <html data-accent> */
function applyThemeColor(color: ThemeColor) {
  document.documentElement.dataset.accent = color;
}
```

**「跟随系统」监听**：当 `themeMode === 'system'` 时，监听 `matchMedia` change 事件，系统切换时自动更新。在 store 中管理一个 `MediaQueryList` 监听器的注册/注销。

**持久化恢复**：`onRehydrateStorage` 中同步调用 `applyThemeMode` + `applyThemeColor`，避免首屏闪烁（与现有 `applyFontSize` 一致）。

### 3.3 新建 AppearanceSection 组件

新建 `packages/frontend/src/components/settings/AppearanceSection.tsx`：

- **界面主题**：分段控制器，三个选项，点击即时切换 store 值
- **主题颜色**：6 个圆点 `div`，点击切换 store 值，当前选中态加外圈
- **文字大小**：滑块 + 实时数值显示（从 GeneralSection 迁移）。字号从当前「草稿态 + 保存生效」改为**即时生效**（拖动即写入 store），与主题模式/颜色保持一致。GeneralSection 的全局保存按钮保留（仍管理重试配置、回收站、导出轮数、语言）。

### 3.4 GeneralSection 改动

从 `GeneralSection.tsx` **移除**字体大小相关代码：
- 移除 `fontSize` / `setFontSize` store 引用
- 移除 `draftFontSize` 草稿状态
- 移除字号 label + slider + value DOM
- 移除 `handleSave` 中的 `if (draftFontSize !== fontSize) setFontSize(...)` 逻辑

### 3.5 导航新增「外观」

- `settings.ts`：`SettingsSection` 类型新增 `"appearance"`
- `SettingsModal.tsx`：导航新增按钮，**位置在「通用」之后**
- 默认 section 不变（仍为 `"general"`）

### 3.6 硬编码颜色修复

`main.tsx:36` 硬编码 `background: "#4BA26F"` → 改为 `background: "var(--brand)"`。

---

## 4. 技术考量

### 4.1 涉及文件

| 文件 | 改动类型 |
|------|----------|
| `packages/frontend/src/styles.css` | 重构 CSS 变量分层（明暗 + 主题色） |
| `packages/frontend/src/store/ui-prefs.ts` | 新增 themeMode / themeColor 状态 + apply 函数 + 媒体查询监听 |
| `packages/frontend/src/store/settings.ts` | SettingsSection 新增 `"appearance"` |
| `packages/frontend/src/components/settings/AppearanceSection.tsx` | **新建**：外观设置面板 |
| `packages/frontend/src/components/settings/GeneralSection.tsx` | 移除字体大小相关代码 |
| `packages/frontend/src/components/SettingsModal.tsx` | 导航新增「外观」按钮 |
| `packages/frontend/src/main.tsx` | 修复硬编码 `#4BA26F` → `var(--brand)` |
| `packages/frontend/src/i18n/locales/zh.ts` | 新增外观相关翻译键 |
| `packages/frontend/src/i18n/locales/en.ts` | 新增外观相关翻译键 |

### 4.2 深色模式覆盖验证

需要逐组件验证深色模式正确性的区域（CSS 变量覆盖即可，无需改组件代码）：
- 主界面：侧边栏、会话列表、聊天气泡、输入框
- 设置面板：导航、各 section
- 弹窗：Modal、Toast、ConfirmDialog
- 代码块：Prism 语法高亮 token 色（可能需要深色变体）
- Markdown 渲染：链接、代码、表格、引用块

### 4.3 已知风险

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| 某些组件硬编码颜色未走 CSS 变量 | Medium | 深色模式下局部不协调 | 全局 grep hex 色，逐个替换为 var() |
| Prism 代码高亮在深色模式下对比度不足 | Medium | 代码可读性差 | 预留 Prism 深色主题 CSS |
| `color-mix()` 兼容性 | Low | accent-soft 计算失败 | Electron Chromium 111+ 支持，项目使用最新版，不使用 color-mix，改用预定义 rgba |
| 首屏闪烁（FOUC） | Low | 刷新时先浅后深 | onRehydrateStorage 同步应用 + main.tsx 内联脚本提前设置 data-theme |

### 4.4 i18n 新增键

```
settings.nav.appearance: "外观" / "Appearance"
settings.appearance.themeMode.label: "界面主题" / "Theme"
settings.appearance.themeMode.desc: "选择浅色、深色或跟随系统" / "..."
settings.appearance.themeMode.system: "跟随系统" / "System"
settings.appearance.themeMode.light: "浅色" / "Light"
settings.appearance.themeMode.dark: "深色" / "Dark"
settings.appearance.themeColor.label: "主题颜色" / "Accent Color"
settings.appearance.themeColor.desc: "点击选择你喜欢的强调色" / "..."
settings.appearance.fontSize.label: "文字大小" / "Font Size"（复用现有键或新建）
```

---

## 5. 验收标准

### 5.1 功能验收

- [ ] 设置导航新增「外观」选项，位于「通用」之后
- [ ] 点击「外观」展示分段控制器 + 颜色圆点 + 字号滑块
- [ ] 切换主题模式（跟随系统/浅色/深色）即时生效，全界面响应
- [ ] 切换主题颜色即时生效，按钮/选中态/滑块/强调元素全部变色
- [ ] 字号滑块拖动即时生效
- [ ] 「通用」中不再显示字号设置
- [ ] 刷新页面后主题模式/颜色/字号保持上次选择
- [ ] 「跟随系统」模式下，切换 OS 明暗模式时应用自动跟随
- [ ] main.tsx 硬编码颜色修复为 `var(--brand)`

### 5.2 测试验收

- [ ] **单元测试**：ui-prefs store 的 themeMode/themeColor 状态管理 + apply 函数
- [ ] **组件测试**：AppearanceSection 渲染、分段控制器交互、颜色圆点交互、字号滑块交互
- [ ] **组件测试**：GeneralSection 不再渲染字号滑块
- [ ] **E2E**：打开设置 → 切换外观 → 验证 `<html>` data-theme/data-accent 属性变化

---

## 6. 不做的事（Non-Goals）

- **不做自定义颜色拾取器**（color picker）：只提供 6 种预设主题色
- **不做用户自定义深色色板**：深色模式色值固定，用户只能选择 3 种模式
- **不迁移其他通用设置项**到外观（如导出轮数、重试配置等留在通用）
- **不做主题预览**（切换前的小窗口预览）：直接即时生效
- **V1 不做动画过渡**：主题切换不做平滑过渡动画（如需可后续加 transition）
