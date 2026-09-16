# 文件预览虚拟滚动 · 验收单

- **验收对象**：`packages/frontend/src/components/blocks/FileViewer.tsx`
  - 代码/文本分支：块级虚拟滚动（每块 200 行）
  - markdown 分支：块级虚拟滚动（按 md 顶层块切分，块高实测收敛）
- **验收方式**：在真实 Wa-Pi 里手工操作（个别项用 DevTools 读数）
- **预计耗时**：15 分钟

---

## 0. 准备

### 0.1 ⚠️ 先确认你验收的是"含本次改动的版本"

| 你的运行方式 | 是否已包含改动 | 需要做什么 |
| --- | --- | --- |
| `bun run dev`（dev 模式） | ✅ 热更新 | 直接验收 |
| 已安装的桌面应用 | ❌ 前端资源是旧的 | 先 `bun run build`，再重新打包/启动 |

> 这一条最容易踩坑：用旧安装包验收，看到的还是旧行为。

### 0.2 造两个大文件（终端执行）

```bash
# ① 40,000 行 / 约 3.2 MB —— 代码文本分支
python3 - <<'PYCODE'
line = b"2026-09-15T10:00:00.000Z INFO kernel step=%d path=/work/src/mod%d.ts cost=12.3ms\n"
with open("/tmp/big-preview.log", "wb") as f:
    for i in range(40000):
        f.write(line % (i, i % 97))

# ② 80,000 行 / 约 6.4 MB —— 超限拦截
with open("/tmp/huge-preview.log", "wb") as f:
    for i in range(80000):
        f.write(line % (i, i % 97))

# ③ 超大 markdown（约 3~4 MB）—— markdown 分支
out = []
for i in range(30000):
    if i % 20 == 0:
        out.append(f"## 第 {i // 20} 节\n")
    out.append(f"这是第 {i} 段正文，讨论接口改造与兼容层：涉及 `src/mod{i}.ts`，决策是保持向后兼容。\n")
    if i % 50 == 0:
        out.append("```ts\nconst x = 1; // 代码围栏\n```\n")
open("/tmp/big-preview.md", "w", encoding="utf-8").write("\n".join(out))
PYCODE

ls -lh /tmp/big-preview.log /tmp/huge-preview.log /tmp/big-preview.md
```

把 `big-preview.log` 与 `big-preview.md` **拷进你当前 Wa-Pi 项目的目录**（要用文件树能点到的位置）。

### 0.3 诊断脚本（备好，出问题时用）

打开 DevTools Console，粘贴：

```js
(() => {
  const body = document.querySelector('[data-testid="fv-body"]');
  if (!body) return "未找到预览区（弹窗没打开？）";
  const rows = [...body.querySelectorAll("[data-line]")];
  const mdBlocks = body.querySelectorAll("[data-md-block]");
  const nums = rows.map((r) => Number(r.dataset.line));
  return {
    模式: mdBlocks.length ? "markdown 块虚拟滚动" : "代码行虚拟滚动",
    渲染行数: rows.length,
    渲染 md 块数: mdBlocks.length,
    首个渲染行: nums.length ? Math.min(...nums) : null,
    最后渲染行: nums.length ? Math.max(...nums) : null,
    预览区节点数: body.querySelectorAll("*").length,
    滚动总高度px: body.scrollHeight,
    视口高度px: body.clientHeight,
    行高px: rows[0]?.offsetHeight ?? null,
  };
})()
```

参考值（40,000 行、视口约 600px）：**渲染行数几百～一千**、**节点数 3,000～6,000**。

---

## 1. 首屏（代码/文本分支）

- [ ] **1.1 秒开**：文件树双击 `big-preview.log` → 预览弹窗 ≤ 1 秒可见内容（超过 3 秒不通过）。
- [ ] **1.2 不被误拦**：3.2 MB 的文件应**正常预览**（只有 >5MB 才提示"文件过大"）。
- [ ] **1.3 无截断提示**：顶部**不应**出现"仅显示前 5000 行"之类横幅。
- [ ] **1.4 行号与着色**：行号从 **1** 开始；有语法着色（不是纯黑白）。

## 2. 滚动（代码/文本分支）

- [ ] **2.1 能滚到底**：拖到最底部 → 最后一行行号 = **40000**。
- [ ] **2.2 无空白**：快速上下拖动（含滚轮连滚），不出现空白块、不闪烁。
- [ ] **2.3 行号连续**：随机停 3 处，首/末渲染行号之差 ≈ 视口能容纳的行数，且内容与行号对得上。
- [ ] **2.4 流畅**：按住 `PgDn` 连滚 10 秒，不卡顿、不抖动。

## 3. 功能回归

- [ ] **3.1 选中复制**：选中若干行 → `Cmd+C` → 剪贴板为 `@<路径> :起-止` 形式。
- [ ] **3.2 复制全文（重点）**：点复制按钮 → `pbpaste | wc -l` 应约等于 **40000**（不能只有可视的几百行）。
- [ ] **3.3 横向滚动**：超长行能横向滚到行尾（长行不折行）。
- [ ] **3.4 小文件不受影响**：几百行的文件 → 着色、行号、滚动都正常。
- [ ] **3.5 字号缩放**：改字号后重开该文件 → 滚到底仍是第 40000 行（行高测量生效）。

## 4. 边界

- [ ] **4.1 超限拦截**：打开 `huge-preview.log`（6.4 MB）→ 提示「文件过大 (6.4MB > 5MB)」+ "用默认应用打开"，**不进入预览**。
- [ ] **4.2 空文件 / 单行文件**：不报错、不白屏。
- [ ] **4.3 图片预览**：仍走缩放视图（不受影响）。

## 5. 超大 markdown（独立分支，单独验收）

markdown 走的是 `ReactMarkdown` 渲染分支，与代码分支不同，本次也做了块级虚拟滚动。

- [ ] **5.1 秒开**：双击 `big-preview.md`（3~4 MB）→ ≤ 1 秒可见（超过 3 秒不通过）。
- [ ] **5.2 排版保留**：渲染的是 **markdown**（标题有层级、代码块有底色），**不是**源码文本。
- [ ] **5.3 能滚到底**：滚到最底部能看到**最后一个章节**（第 1499 节附近）。
- [ ] **5.4 无截断提示**：顶部没有"仅显示前 N 行"之类横幅。
- [ ] **5.5 块间无大空白**：快速拖动滚动条，不出现连续几屏空白；停下后内容立即补齐。
- [ ] **5.6 代码块未被劈开**：抽查若干代码块，围栏成对（没有半截代码块渲染成正文）。
- [ ] **5.7 链接/图片仍可用**：md 里相对路径链接能点开目标文件；图片能正常显示。
- [ ] **5.8 滚动位置稳定**：滚到底再回顶部，章节位置不漂移（块高实测后收敛）。

## 6. 不通过时给我这些

| 项 | 值 |
| --- | --- |
| 文件行数 / 大小 | |
| 打开到可见的耗时 | |
| 诊断脚本输出 | （整段粘贴） |
| 出问题的位置 | 例如"滚到 2 万行附近开始空白" |
| 截图 / 录屏 | |

诊断脚本的输出足以定位绝大多数问题：行高错 → 占位高度不对；渲染行数/块数暴涨 → 窗口计算没生效；首个行号不跟随 → 滚动监听没触发。

---

## 附：先看 demo 有个预期

打开 `~/Desktop/fileviewer-virtual-scroll-demo.html`（说明见 `FILE-PREVIEW-DEMO.md`）：

- 40,000 行：节点数稳定在 **约 3,000**，滚动切换 **< 20 ms**
- 同一份 10,000 行切"全量渲染"：节点数 **78,888**，主线程卡 **约 2.2 秒**

demo 是同一套思路的独立复刻，**验收以真实 Wa-Pi 的结果为准**。
