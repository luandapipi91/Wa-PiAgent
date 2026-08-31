# 分享文件：再次分享时复用上一次分享名称 — 设计文档

**日期**：2026-08-27
**状态**：已批准（用户确认方案 A + 使用 `Bun.hash`）

## 原始需求

> 分享页面功能，分享文件弹窗，如果已经分享过的文件，再次分享的时候，使用上一次一样的分享名称。

## 已确认的决策点

1. **判定"同一个分享"**：按**同一组文件路径**判定（`hashPaths(paths)` 相同才算同一次分享）。
2. **复用名称的默认行为**：**预填充输入框，可改**（回填到分享名称输入框，用户仍可编辑后生成链接）。
3. **hash 算法**：改用 **`Bun.hash`**（而非现有 sha256），生成分享 id。**不做兼容性迁移**。

## 现状分析（关键结论）

- 分享事实源在 kernel：`{WA_PI_DIR}/share-workspace/state.json`，记录形如 `{ id, name, files, size, createdAt }`。
- `id = hashPaths(paths)`：对排序后的**原始 paths** 集合做哈希（`pack.ts`），是全库唯一标识。**items 里的相对路径 `files` 与用户选择的原始 `paths` 不直接对应**，前端光靠 `shareList()` 无法反推哪条记录对应本次 paths。
- 前端弹窗 `ShareResultModal`（`ShareButton.tsx`）当前每次挂载都用「项目名 → 会话反查项目名 → 文件名/目录名」规则重新计算默认名，**从不读取已存分享名**。
- `addItem` 对同 id 记录是"覆盖为最新"，因此匹配 `id` 恒能拿到最近一次该组文件使用的分享名。

## 方案：后端新增查询端点（方案 A）

### 数据流

1. 用户点击分享按钮 → `ShareResultModal` 挂载。
2. 挂载后并行：检查 token（现有）+ 调 `POST /api/share/name-for-paths`。
3. kernel 用 `hashPaths(paths)` 算 id → 查 `state.json` 里 `item.id === id` 的记录 → 返回 `{ name }` 或 `{ name: null }`。
4. 前端命中且输入框尚未被用户手动改过 → `setShareName(name)` 回填；用户仍可编辑。

## 改动点

### kernel：`packages/kernel/src/share/pack.ts`

重写 `hashPaths`，改用 `Bun.hash`，但**保留路径分隔符归一化**（`p.replace(/\\/g, "/")`），否则 Windows 正/反斜杠同文件会得到不同 id：

```ts
export function hashPaths(paths: string[]): string {
  const normalized = paths.map((p) => p.replace(/\\/g, "/"));
  const joined = [...normalized].sort().join("\n");
  // Bun.hash 确定性 bigint → 12 位 hex（保持与 SHARE_ID_RE 一致）
  return Bun.hash(joined).toString(16).padStart(12, "0").slice(0, 12);
}
```

- 移除 `import { createHash } from "node:crypto"`。

### kernel：`packages/kernel/src/routes/share.ts`

在 `createShareRoutes` 内新增端点：

```ts
router.add(
  "POST",
  "/api/share/name-for-paths",
  wrap(async (req) => {
    const b = await readJsonBody(req);
    const paths: string[] = b.paths ?? [];
    if (paths.length === 0)
      return Response.json({ error: "paths 为空" }, { status: 400 });
    const id = hashPaths(paths);
    const item = (await loadItems(workspaceDir)).find((i) => i.id === id);
    return Response.json({ name: item?.name ?? null });
  }),
);
```

- 复用已 import 的 `hashPaths` / `loadItems`；无需新增 import。

### frontend：`packages/frontend/src/share-client.ts`

新增封装：

```ts
export async function shareNameForPaths(
  paths: string[],
): Promise<{ name: string | null }> {
  return (await transport.post("/api/share/name-for-paths", { paths })) as {
    name: string | null;
  };
}
```

### frontend：`packages/frontend/src/components/ui/ShareButton.tsx`

`ShareResultModal` 增加一个 effect，挂载后调 `shareNameForPaths(paths)`：

- 用 `cancelled` 守卫防卸载后 setState。
- 命中且输入框尚未被用户手动改过 → `setShareName(name)`。
- 用 ref（如 `nameEditedRef`）标记用户是否手动改过输入框；只有当 `!nameEditedRef.current` 时才回填，避免覆盖用户正在输入的内容。

### i18n

无新增文案（复用现有 `share.name`）。不改。

## 边界与约定

- 只回填"同一组文件路径"（`hashPaths` 相同），不同组合不复用。
- 回填的是输入框预填值，**不自动提交**；用户确认后仍走现有 `shareUpload`。
- 该组路径从未分享过 → 返回 `{ name: null }` → 保持现有默认名规则（项目名/文件名）。
- 不使用 `Bun.hash` 做兼容性迁移（用户明确：不用考虑兼容性）。

## 测试分层（4 层）

1. **单元测试（后端）**
   - `packages/kernel/tests/share-pack.test.ts`：更新 `hashPaths` 用例——确定性、同集合任意顺序同 hash、正/反斜杠归一化一致、不同集合不同 hash、输出符合 `/\^[0-9a-f]{12}$/`。
   - `packages/kernel/tests/share-routes.test.ts`：新增 `name-for-paths` 用例——命中同 id 返回历史 name、无记录返回 `{ name: null }`、paths 空返回 400。

2. **组件测试（前端）**
   - `packages/frontend/src/components/ui/ShareButton.test.tsx`：mock share-client 传输，断言挂载后输入框回填历史 name；断言用户手动改过后不再被覆盖；断言无记录时保持默认名。

3. **API 接口测试**
   - curl 调 `POST /api/share/name-for-paths`（真实运行服务）：命中路径返回 name；未分享路径返回 `{ name: null }`；空 paths 返回 400。

4. **E2E（Playwright）**
   - 分享一组文件（自定义名「别名A」）→ 再次分享同一组文件 → 断言输入框回填「别名A」→ 用户可改 → 生成链接。

## 质量要求

- [ ] 所有组件正常工作
- [ ] 移动端适配（无需特殊处理，复用现有弹窗样式）
- [ ] 表单功能正常（分享名称输入/生成链接）
- [ ] 包含必要的自动化测试（4 层）
- [ ] 更新 `CHANGELOG.md`
