# wa-pi 接入 MiSans 字体设计

**日期：** 2026-08-02
**状态：** 已批准（MiSans 主字体 4 字重 + JetBrains Mono 代码字体，中文回退 MiSans）

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
| 代码块/路径/工具参数 | JetBrains Mono + MiSans 回退 | Regular 400 + Bold 700 | 拉丁/数字等宽（编程体验），中文注释回退 MiSans（与主字体统一） |

> **决策记录（2026-08-02）**：最初选定 MiSans Mono（统一风），经核实 MiSans Mono **不是小米官方公开发布的字体**（官方字体站与全家桶 zip 均无），故改为 JetBrains Mono（拉丁等宽，OFL-1.1 免费商用）+ 中文回退 MiSans。这是中文开发工具的常见方案。

字体文件：woff2 格式（浏览器原生支持，桌面端本地加载无网络开销）。

## 3. 文件结构

**新增文件：**
- `packages/frontend/public/fonts/MiSans-Regular.woff2`
- `packages/frontend/public/fonts/MiSans-Medium.woff2`
- `packages/frontend/public/fonts/MiSans-Bold.woff2`
- `packages/frontend/public/fonts/MiSans-Heavy.woff2`
- `packages/frontend/public/fonts/JetBrainsMono-Regular.woff2`
- `packages/frontend/public/fonts/JetBrainsMono-Bold.woff2`
- `packages/frontend/public/fonts/LICENSE-MiSans.txt`（小米许可说明）
- `packages/frontend/public/fonts/LICENSE-JetBrainsMono.txt`（OFL-1.1 许可文本）

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
  font-family: "JetBrains Mono";
  src: url("/fonts/JetBrainsMono-Regular.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
/* JetBrains Mono Bold 700 同理 */
```

### 4.2 body 字体栈（styles.css）

```css
font-family: "MiSans", -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Microsoft YaHei", sans-serif;
```

### 4.3 tailwind.config.js

```js
fontFamily: {
  sans: ["MiSans", "-apple-system", "BlinkMacSystemFont", "SF Pro Display", "PingFang SC", "sans-serif"],
  mono: ["JetBrains Mono", "MiSans", "SF Mono", "monospace"],
},
```

> 注：mono 栈中 `MiSans` 放在 JetBrains Mono 之后——拉丁字符优先 JetBrains Mono 等宽，中文回退到 MiSans 与主字体统一。

### 4.4 ErrorBoundary（main.tsx:15）

```tsx
fontFamily: 'MiSans, system-ui, "PingFang SC", sans-serif',
```

## 5. 字体文件获取

- **MiSans（4 字重 woff2）**：从官方发布包 `MiSans_Global_ALL.zip`（用户已下载至 `C:/Users/co/Downloads/`）提取内层 `MiSans.zip` 的 `woff2/` 目录：`MiSans-Regular.woff2` / `MiSans-Medium.woff2` / `MiSans-Bold.woff2` / `MiSans-Heavy.woff2`（各约 5MB）。
- **JetBrains Mono（2 字重 woff2）**：从 JetBrains 官方 GitHub 仓库 `JetBrains/JetBrainsMono` 的 `fonts/woff2/` 目录下载 `JetBrainsMono-Regular.woff2` 与 `JetBrainsMono-Bold.woff2`（OFL-1.1）。
- 许可文件：MiSans 的《MiSans 字体知识产权许可协议》文本 + JetBrains Mono 的 `OFL.txt`，随字体文件放入 `public/fonts/` 并注明「软件使用了 MiSans 字体」（协议要求）。

**MiSans Mono 不存在**：官方字体站与 MiSans 全家桶 zip 均无 MiSans Mono（非小米官方公开发布），代码字体改用 JetBrains Mono + 中文回退 MiSans。

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 字体文件体积（~22MB） | 安装包增大 | 本地加载无网络开销；只打包 6 个文件、不打包全家族 |
| woff2 子集化不足 | 体积偏大 | 官方 woff2 已优化，可接受 |
| 字体下载来源不可靠 | 文件损坏/版权风险 | MiSans 用官方 zip（用户下载）；JetBrains Mono 用 JetBrains 官方 GitHub；校验文件大小 |
| splash 页字体不一致 | 启动瞬间观感差异 | 接受（技术限制，splash 显示时间极短），文档注明 |
| 旧字体测试断言 | 测试失败 | 全量测试回归确认；现有测试无字体断言（已验证） |

## 7. 测试

- **单元/组件测试**：现有 906 个前端测试全量回归，确认字体改动不破坏渲染（测试不含字体断言，预期全绿）
- **构建验证**：`bun run --filter @wa-pi/frontend build` 确认 `dist/fonts/` 包含 6 个 woff2 + 2 个许可文件
- **视觉验证**：启动应用，确认标题/正文/代码块/按钮均渲染 MiSans，代码块拉丁字符 JetBrains Mono 等宽、中文 MiSans；Windows 本机验证（macOS 由字体栈回退保证不崩）
- **E2E**：现有 quick-invoke / composer E2E 回归（字体不影响选择器与交互）

## 8. 不做的事（Non-goals）

- 不更换 splash 启动页字体（data URL 技术限制）
- 不更换 Mermaid 图内字体（SVG 限制）
- 不做字重可变字体（VF）优化（4 字重已覆盖，避免兼容性风险）
- 不引入 MiSans Mono（官方不存在）
- 不修改任何业务逻辑/组件结构
