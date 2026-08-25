# 分享文件再次分享复用上次分享名称 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 分享文件弹窗打开时，若该组文件路径之前分享过，预填充上次使用的分享名称到输入框（用户可改）。

**架构：** kernel 新增 `POST /api/share/name-for-paths` 端点，用 `hashPaths(paths)` 算 id 查 `state.json` 返回共享名；前端 `ShareResultModal` 挂载后调用，命中且输入框未被手动改过则回填。`hashPaths` 改用 `Bun.hash`（保留正/反斜杠归一化）。

**技术栈：** bun（kernel）、react + @testing-library/react（frontend）、bun:test（单测）。

---

## 文件结构

| 文件 | 职责 | 变更 |
|------|------|------|
| `packages/kernel/src/share/pack.ts` | `hashPaths` 改用 `Bun.hash` | 修改 |
| `packages/kernel/src/routes/share.ts` | 新增 `name-for-paths` 端点 | 修改 |
| `packages/frontend/src/share-client.ts` | 新增 `shareNameForPaths` | 修改 |
| `packages/frontend/src/components/ui/ShareButton.tsx` | 挂载后回填分享名 | 修改 |
| `packages/kernel/tests/share-pack.test.ts` | `hashPaths` 断言更新 | 修改 |
| `packages/kernel/tests/share-routes.test.ts` | 新增 `name-for-paths` 用例 | 修改 |
| `packages/frontend/src/components/ui/ShareButton.test.tsx` | 新增回填用例 | 修改 |
| `CHANGELOG.md` | 记录变更 | 修改 |

---

### 任务 1：`hashPaths` 改用 Bun.hash

**文件：**
- 修改：`packages/kernel/src/share/pack.ts:1-13`
- 测试：`packages/kernel/tests/share-pack.test.ts:17-29`

- [ ] **步骤 1：更新测试断言**（先确认现用 `node:crypto` sha256 的语义描述需要改为 Bun.hash；但测试断言本身 `toMatch(/^\b`) 不变）

现有测试 `share-pack.test.ts` 的 `hashPaths` 两条用例已断言「正/反斜杠一致」与「同集合同 hash / 不同集不同」，**断言本身不改**——它们约束的是行为契约，正好用于验证 Bun.hash 改法。此任务只需确保实现后测试仍通过。我们以此作为红灯（跑一遍确认当前通过，改实现后再跑确认仍通过，即为"行为契约保持"）。

- [ ] **步骤 2：运行现有测试确认基线通过**

运行：`cd packages/kernel && bun test tests/share-pack.test.ts`
预期：PASS（当前 sha256 实现下全绿，作为行为基线）

- [ ] **步骤 3：改写 `hashPaths` 用 Bun.hash**

`packages/kernel/src/share/pack.ts` 顶部去掉 `node:crypto` 的 `createHash` import，改 `hashPaths`：

```ts
/** 排序后路径拼接 → Bun.hash 产物（12 位 hex，id 格式合规） */
export function hashPaths(paths: string[]): string {
  // 输入路径先统一分隔符（正斜杠 /），否则 Windows 正/反斜杠同文件会得到不同 id
  const normalized = paths.map((p) => p.replace(/\\/g, "/"));
  const joined = [...normalized].sort().join("\n");
  return Bun.hash(joined).toString(16).padStart(12, "0").slice(0, 12);
}
```

同时删除文件顶部 `import { createHash } from "node:crypto";`（若 `readFileSync/statSync/readdirSync` 仍从 `node:fs` 引入则保留）。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd packages/kernel && bun test tests/share-pack.test.ts`
预期：PASS（行为契约保持：正反斜杠一致、同集合同 hash、输出 12 位 hex）

- [ ] **步骤 5：Commit**

```bash
git add packages/kernel/src/share/pack.ts packages/kernel/tests/share-pack.test.ts
git commit -m "refactor(kernel): hashPaths 改用 Bun.hash 生成分享 id"
```

---

### 任务 2：后端新增 `name-for-paths` 端点（含单测）

**文件：**
- 修改：`packages/kernel/src/routes/share.ts`（在 `createShareRoutes` 内、`upload` 端点之后新增）
- 测试：`packages/kernel/tests/share-routes.test.ts`（新增用例）

- [ ] **步骤 1：编写失败测试**

在 `packages/kernel/tests/share-routes.test.ts` 末尾新增：

```ts
test("name-for-paths：已分享组返回历史 name（同一组文件路径）", async () => {
  mockEdgeOne();
  const router = setup();
  // 先分享一次（自定义名「别名A」）
  const paths = [join(dir, "prod", "index.html")];
  await post(router, "/api/share/upload", {
    paths,
    name: "别名A",
  });
  // 再查同组路径 → 命中返回「别名A」
  const res = await post(router, "/api/share/name-for-paths", { paths });
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body.name).toBe("别名A");
});

test("name-for-paths：未分享过的组返回 { name: null }", async () => {
  mockEdgeOne();
  const router = setup();
  const res = await post(router, "/api/share/name-for-paths", {
    paths: [join(dir, "prod", "never-shared.txt")],
  });
  expect(res!.status).toBe(200);
  const body = await res!.json();
  expect(body.name).toBeNull();
});

test("name-for-paths：paths 为空返回 400", async () => {
  mockEdgeOne();
  const router = setup();
  const res = await post(router, "/api/share/name-for-paths", { paths: [] });
  expect(res!.status).toBe(400);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd packages/kernel && bun test tests/share-routes.test.ts -t "name-for-paths"`
预期：FAIL —— 路由不存在，返回 404（`router.handle` 命中不到该路径）

- [ ] **步骤 3：实现端点**

`packages/kernel/src/routes/share.ts` 中，在 `upload` 端点（`/api/share/upload`）之后新增：

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

`hashPaths` 与 `loadItems` 已 import，无需新增 import。

- [ ] **步骤 4：运行测试验证通过**

运行：`cd packages/kernel && bun test tests/share-routes.test.ts -t "name-for-paths"`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/kernel/src/routes/share.ts packages/kernel/tests/share-routes.test.ts
git commit -m "feat(kernel): 新增 name-for-paths 端点，按同组路径查询历史分享名"
```

---

### 任务 3：前端 share-client 新增 `shareNameForPaths`

**文件：**
- 修改：`packages/frontend/src/share-client.ts`（在 `shareUpload` 之后新增）

- [ ] **步骤 1：实现函数**

`packages/frontend/src/share-client.ts` 中 `shareUpload` 之后新增：

```ts
/** 按一组文件路径查询历史分享名（未分享过返回 { name: null }） */
export async function shareNameForPaths(
  paths: string[],
): Promise<{ name: string | null }> {
  return (await transport.post("/api/share/name-for-paths", { paths })) as {
    name: string | null;
  };
}
```

此函数无独立单测（由组件测试覆盖；`transport.post` 注入模式与现有 `shareUpload` 一致）。此任务不产生独立测试循环，作为交付物并入任务 4。

- [ ] **步骤 2：Commit**

```bash
git add packages/frontend/src/share-client.ts
git commit -m "feat(frontend): share-client 新增 shareNameForPaths 查询"
```

---

### 任务 4：前端弹窗挂载后回填分享名

**文件：**
- 修改：`packages/frontend/src/components/ui/ShareButton.tsx`（`ShareResultModal`）
- 测试：`packages/frontend/src/components/ui/ShareButton.test.tsx`（新增用例 + mock 新增函数）

- [ ] **步骤 1：更新 mock 增加 `shareNameForPaths`**

`packages/frontend/src/components/ui/ShareButton.test.tsx` 中 `mock.module("../../share-client", ...)` 追加 `shareNameForPaths`：

```ts
const shareNameForPathsMock = mock(async () => ({ name: null }));
mock.module("../../share-client", () => ({
  shareSettings: shareSettingsMock,
  shareUpload: shareUploadMock,
  shareNameForPaths: shareNameForPathsMock,
  saveShareSettings: async () => {},
}));
```

并在 `beforeEach` 中加入 `shareNameForPathsMock.mockReset(); shareNameForPathsMock.mockResolvedValue({ name: null });`

- [ ] **步骤 2：编写失败测试**

在 `ShareButton.test.tsx` 末尾新增：

```ts
test("再次分享同组文件：弹窗预填充上次分享名", async () => {
  shareNameForPathsMock.mockResolvedValue({ name: "别名A" });
  render(<ShareButton paths={PATHS} />);
  fireEvent.click(screen.getByTestId("share-btn"));
  // 查询历史名并回填到输入框
  await waitFor(() =>
    expect(
      (screen.getByTestId("share-name-input") as HTMLInputElement).value,
    ).toBe("别名A"),
  );
});

test("无历史分享名：弹窗保持默认名（文件数）", async () => {
  shareNameForPathsMock.mockResolvedValue({ name: null });
  render(<ShareButton paths={PATHS} />);
  fireEvent.click(screen.getByTestId("share-btn"));
  await screen.findByTestId("share-name-input");
  expect(
    (screen.getByTestId("share-name-input") as HTMLInputElement).value,
  ).toBe("3 个文件");
});

test("用户已手动改过输入框：历史名回填不覆盖用户输入", async () => {
  // 先 resolve 一个历史名，但用户已经手动改了 → 不应覆盖
  let resolveLookup!: (v: { name: string | null }) => void;
  shareNameForPathsMock.mockImplementation(
    () =>
      new Promise((r) => {
        resolveLookup = r;
      }),
  );
  render(<ShareButton paths={PATHS} />);
  fireEvent.click(screen.getByTestId("share-btn"));
  await screen.findByTestId("share-name-input");
  // 用户手动改名
  fireEvent.change(screen.getByTestId("share-name-input"), {
    target: { value: "我改的" },
  });
  // 历史名查询此刻才完成
  resolveLookup({ name: "别名A" });
  await waitFor(() =>
    expect(
      (screen.getByTestId("share-name-input") as HTMLInputElement).value,
    ).toBe("我改的"),
  );
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`cd packages/frontend && bun test src/components/ui/ShareButton.test.tsx -t "再次分享同组文件"`
预期：FAIL —— `shareNameForPaths` 未在组件中调用，输入框值仍为文件名默认名

- [ ] **步骤 4：实现回填逻辑**

`packages/frontend/src/components/ui/ShareButton.tsx` 的 `ShareResultModal` 中：
- import `shareNameForPaths`：
  `import { shareSettings, shareUpload, shareNameForPaths } from "../../share-client";`
- 新增一个 ref 记录用户是否手动改过输入框：
  `const nameEditedRef = useRef(false);`
- 在输入框 `onChange` 中标记：`onChange={(e) => { setShareName(e.target.value); nameEditedRef.current = true; }}`
- 新增挂载 effect（在现有 token 检查 effect 之后）：

```ts
// 回填上次分享名：同一组文件路径命中历史分享记录时，预填其分享名（用户可改）。
// 仅在用户未手动改过输入框时生效，避免覆盖正在输入的内容。
useEffect(() => {
  let cancelled = false;
  shareNameForPaths(paths)
    .then(({ name }) => {
      if (cancelled || !name || nameEditedRef.current) return;
      setShareName(name);
    })
    .catch(() => {
      // 查询失败不影响分享主流程，保持默认名
    });
  return () => {
    cancelled = true;
  };
}, [paths]);
```

- [ ] **步骤 5：运行测试验证通过**

运行：`cd packages/frontend && bun test src/components/ui/ShareButton.test.tsx`
预期：PASS（新增 3 条 + 既有全部通过）

- [ ] **步骤 6：Commit**

```bash
git add packages/frontend/src/components/ui/ShareButton.tsx packages/frontend/src/components/ui/ShareButton.test.tsx packages/frontend/src/share-client.ts
git commit -m "feat(frontend): 分享弹窗挂载后回填同组文件的上次分享名"
```

---

### 任务 5：接口测试 + E2E + 更新 CHANGELOG

**文件：**
- 修改：`CHANGELOG.md`

- [ ] **步骤 1：接口测试（真实运行服务）**

先启动内核服务（dev），用 curl 验证：

```bash
# 分享一次（自定义名）
curl -X POST http://api/share/upload -H 'Content-Type: application/json' \
  -d '{"paths":["/绝对路径/prod/index.html"],"name":"别名A"}'
# 同组路径查询历史名（命中）
curl -X POST http://api/share/name-for-paths -H 'Content-Type: application/json' \
  -d '{"paths":["/绝对路径/prod/index.html"]}'
# 期望：{"name":"别名A"}
# 未分享路径（null）
curl -X POST http://api/share/name-for-paths -H 'Content-Type: application/json' \
  -d '{"paths":["/绝对路径/never.txt"]}'
# 期望：{"name":null}
# 空 paths（400）
curl -X POST http://api/share/name-for-paths -H 'Content-Type: application/json' \
  -d '{"paths":[]}'
# 期望：400 "paths 为空"
```

- [ ] **步骤 2：E2E（Playwright/浏览器）**

用浏览器走真实流程：
1. 打开一个文件 → 点分享 → 自定义分享名「别名A」→ 生成链接。
2. 再次对同一文件点分享 → 断言输入框已预填「别名A」。
3. 改名为「别名B」→ 生成链接，链接指向别名B。
> 说明：E2E 在开发环境按需执行，完成后清理产生的截图文件（不保留在项目内）。

- [ ] **步骤 3：更新 CHANGELOG.md**

在文件顶部新增（时间倒序）：

```markdown
## 2026-08-27
- 新增：分享文件弹窗再次分享同组文件时，预填上一次使用的分享名称（可用 `Bun.hash` 生成分享 id，新增 `name-for-paths` 端点）
```

- [ ] **步骤 4：Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: 记录分享名复用功能变更"
```

---

## 自检

**1. 规格覆盖度**：需求（再次分享复用上次分享名）+ 决策（同组路径判定 / 预填充可改 / Bun.hash 无兼容）全部落实：
- 同组路径判定 → 任务 2（`hashPaths` 匹配 `item.id`）
- 预填充可改 → 任务 4（回填 + `nameEditedRef` 不覆盖手动输入）
- Bun.hash → 任务 1

**2. 占位符扫描**：所有步骤含具体代码/命令，无 TODO/待定/占位。

**3. 类型一致性**：`shareNameForPaths(paths): Promise<{ name: string | null }>` 在任务 3 定义，任务 4 使用一致；`nameEditedRef` 仅在任务 4 内；`hashPaths` 签名在任务 1 重写后任务 2 调用不变。
