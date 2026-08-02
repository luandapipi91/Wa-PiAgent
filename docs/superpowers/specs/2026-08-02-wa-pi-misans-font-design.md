# wa-pi 接入 MiSans 字体设计

**日期：** 2026-08-02
**状态：** 已批准（用户选择：MiSans 主字体 + MiSans Mono 代码字体 + 4 字重）

## 1. 背景与目标

wa-pi 桌面应用当前完全依赖系统字体栈（macOS 苹方 / Windows 微软雅黑），观感朴素且跨平台不一致。目标：接入好看的免费商用字体，统一跨平台视觉。

用户通过视觉伴侣对比后选定：**MiSans（小米）** 为主 UI 字体，**MiSans Mono** 为代码等宽字体。两者均为小米官方开源、**免费商用**。

## 2. 字体选型

| 用途 | 字体 | 字重 | 说明 |
|---|---|---|---|
| 主 UI（正文/按钮/标签） | MiSans | Regular 400 | 现代柔和，数字/拉丁字符漂亮 |
| 强调文本 | MiSans | Medium 500 | 列表项、重点 |
| 标题 | MiSans | Bold 700 | 区块标题、对话框标题 |
| 大标题/Hero | MiSans | Heavy 900 | 欢迎页、空状态大标题 |
| 代码块/路径/工具参数 | MiSans Mono | Regular 400 + Bold 700 | 与主字体风格统一 |

字体文件：woff2 格式（浏览器原生支持，桌面端本地加载无网络开销）。

## 3. 文件结构

**新增文件：**
- `packages/frontend/public/fonts/MiSans-Regular.woff2`
- `packages/frontend/public/fonts/MiSans-Medium.woff2`
- `packages/frontend/public/fonts/MiSans-Bold.woff2`
- `packages/frontend/public/fonts/MiSans-Heavy.woff2`
- `packages/frontend/public/fonts/MiSansMono-Regular.woff2`
- `packages/frontend/public/fonts/MiSansMono-Bold.woff2`

**修改文件：**
- `packages/frontend/src/styles.css` — @font-face 声明 + body font-family
- `packages/frontend/tailwind.config.js` — fontFamily.sans / fontFamily.mono 首项
- `packages/frontend/src/main.tsx` — ErrorBoundary 内联字体栈
- `DESIGN.md` — typography 规范同步

**不改动：**
- `packages/desktop/src/main.cjs` splash 页 — 内嵌 data URL 无法引用外部字体文件（技术限制，保持系统字体栈）
- `MermaidBlock.tsx` — SVG 内 `font-family="sans-serif"`（SVG 内无法继承，保持）
- 组件代码 — `font-mono` 工具类经 tailwind config 全局生效，无需逐个组件改
- 打包配置 — 字体进 `dist/fonts/` 后由现有链路（`resources/web` → electron-builder extraResources）自动携带

## 4. 技术实现细节

### 4.1 @font-face（styles.css，:root 之前）

```css
@font-face {
  font-family: "MiSans";
  src: url("/fonts/MiSans-Regular.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
/* Medium 500 / Bold 700 / Heavy 900 同理 */
@font-face {
  font-family: "MiSans Mono";
  src: url("/fonts/MiSansMono-Regular.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
/* MiSans Mono Bold 700 同理 */
```

### 4.2 body 字体栈（styles.css）

```css
font-family: "MiSans", -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif;
```

### 4.3 tailwind.config.js

```js
fontFamily: {
  sans: ["MiSans", "-apple-system", "BlinkMacSystemFont", "SF Pro Display", "PingFang SC", "sans-serif"],
  mono: ["MiSans Mono", "SF Mono", "JetBrains Mono", "monospace"],
},
```

### 4.4 ErrorBoundary（main.tsx:15）

```tsx
fontFamily: 'MiSans, system-ui, "PingFang SC", sans-serif',
```

## 5. 字体文件获取

MiSans / MiSans Mono 官方开源发布（小米），从可靠来源下载 woff2：
- 优先：小米官方发布渠道（hyperos.mi.com / miui 开发者站点）的 ttf/otf → 本地转换 woff2
- 备选：GitHub 镜像仓库中的 woff2 文件

下载后按字重拆分，命名按上文约定。验证：`fc-scan` 或字体查看器确认字重与字符集（MiSans 覆盖 GB18030 常用汉字，MiSans Mono 覆盖 CJK + 拉丁）。

**许可确认**：MiSans 免费商用授权（小米官方声明可免费使用于商业产品），需保留许可信息；实现时在字体文件旁放置授权说明（LICENSE-MiSans.txt）。

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 字体文件体积（~20MB） | 安装包增大 | 本地加载无网络开销；只打包 6 个文件、不打包全家族 |
| woff2 子集化不足 | 体积偏大 | 若下载源提供子集化 woff2 优先使用；否则接受全量 |
| 字体下载来源不可靠 | 文件损坏/版权风险 | 从官方渠道获取，校验文件（大小/字体名） |
| splash 页字体不一致 | 启动瞬间观感差异 | 接受（技术限制，splash 显示时间极短），文档注明 |
| 旧字体测试断言 | 测试失败 | 全量测试回归确认；现有测试无字体断言（已验证） |

## 7. 测试

- **单元/组件测试**：现有 906 个前端测试全量回归，确认字体改动不破坏渲染（测试不含字体断言，预期全绿）
- **构建验证**：`bun run --filter @wa-pi/frontend build` 确认 `dist/fonts/` 包含 6 个 woff2
- **视觉验证**：启动应用，确认标题/正文/代码块/按钮均渲染 MiSans；Windows + macOS 各看一次（本机 Windows 验证；macOS 由字体栈回退保证不崩）
- **E2E**：现有 quick-invoke / composer E2E 回归（字体不影响选择器与交互）

## 8. 不做的事（Non-goals）

- 不更换 splash 启动页字体（data URL 技术限制）
- 不更换 Mermaid 图内字体（SVG 限制）
- 不做字重可变字体（VF）优化（4 字重已覆盖，避免兼容性风险）
- 不修改任何业务逻辑/组件结构
