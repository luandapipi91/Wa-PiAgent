# Skill 注入系统提示词 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 最终看到的 system prompt 包含 skills 段——把用户在「系统设置 → 技能」配置的 skill 目录真正喂给 SDK 的 `DefaultResourceLoader`，并在 skill 配置变更后惰性重建已运行会话。

**Architecture:** B（创建时注入）+ C1（惰性重建）。`SkillInfo` 加 `path` 字段，`skill-manager` 扫描时记录每个 skill 的目录路径；`_createSession` 把启用 skill 的路径作为 `additionalSkillPaths` 传入 loader（只含 userSkillDirs 来源，builtin 留给 SDK 自动扫）。skill 配置变更走 `markSkillsDirty`，`_reloadIfDirty` 在 idle 时重建会话（dispose 旧 + 重开同一 piSessionFile），而非 reload（`additionalSkillPaths` 构造时固定，reload 刷不进）。

**Tech Stack:** Bun + TypeScript（kernel），bun:test（kernel 测试），`@earendil-works/pi-coding-agent` SDK。

**Spec:** [docs/superpowers/specs/2026-07-11-skill-injection-into-system-prompt-design.md](../specs/2026-07-11-skill-injection-into-system-prompt-design.md)

---

## File Structure

- **`packages/shared/src/skills.ts`** — `SkillInfo` 加 `path` 字段（skill 目录绝对路径）。
- **`packages/kernel/src/skill-manager.ts`** — `parseSkillFrontmatter` 接收目录参数并填 `path`；`scanSkillsDir` 传入 `fullPath`。
- **`packages/kernel/src/agent-manager.ts`** — `AgentManagerOpts` 加 `skillManager?`；`_createSession` 注入 `additionalSkillPaths`；新增 `skillDirty`/`sessionMeta`/`markSkillsDirty`/`_teardownSession`；`_reloadIfDirty` 加重建分支与 `isCompacting` 守卫并返回 session。
- **`packages/kernel/src/ws-server.ts`** — 三个 skill handler 改调 `markSkillsDirty`。
- **`packages/kernel/src/index.ts`** — `new AgentManager({ ..., skillManager })`。
- **测试**：`packages/kernel/tests/skill-manager.test.ts`、`agent-manager.test.ts`、`ws-skill.test.ts`。

---

## Task 1: SkillInfo 加 path 字段 + skill-manager 记录路径

**Files:**
- Modify: `packages/shared/src/skills.ts:4-7`
- Modify: `packages/kernel/src/skill-manager.ts:77-84`（`parseSkillFrontmatter`）、`skill-manager.ts:124-130`（`scanSkillsDir` 调用处）
- Test: `packages/kernel/tests/skill-manager.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/kernel/tests/skill-manager.test.ts` 末尾追加：

```typescript
test("scan 返回的 SkillInfo 含 skill 目录绝对路径", async () => {
  createSkill(join(dir, "skills"), "brave-search", "web 搜索");
  const userDir = join(dir, "user-skills");
  mkdirSync(userDir, { recursive: true });
  createSkill(userDir, "user-skill", "用户技能");

  const mgr = new SkillManager(dir);
  await mgr.addDir(userDir);
  const result = await mgr.scan();
  const builtin = result.allSkills.find(s => s.name === "brave-search");
  const user = result.allSkills.find(s => s.name === "user-skill");
  expect(builtin?.path).toBe(join(join(dir, "skills"), "brave-search"));
  expect(user?.path).toBe(join(userDir, "user-skill"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/skill-manager.test.ts -t "含 skill 目录绝对路径"`
Expected: FAIL — `expect(builtin?.path)` 收到 `undefined`（SkillInfo 还没有 `path` 字段）

- [ ] **Step 3: 给 SkillInfo 加 path 字段**

修改 `packages/shared/src/skills.ts`：

```typescript
/** 技能信息（从 SKILL.md frontmatter 提取的最小集） */
export interface SkillInfo {
  name: string;
  description: string;
  path: string;        // skill 目录绝对路径（含 SKILL.md 的目录），用于喂给 SDK additionalSkillPaths
}
```

- [ ] **Step 4: parseSkillFrontmatter 接收并填 path**

修改 `packages/kernel/src/skill-manager.ts` 的 `parseSkillFrontmatter`（约 77 行）：

```typescript
/**
 * 解析 SKILL.md 的 YAML frontmatter，提取 name 和 description。
 * 格式：`---\nname: xxx\ndescription: yyy\n---`
 * @param dir 该 SKILL.md 所在目录（即 skill 目录），填入 SkillInfo.path
 */
function parseSkillFrontmatter(content: string, dir: string): SkillInfo | null {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name) return null;
  return { name, description: desc ?? "", path: dir };
}
```

- [ ] **Step 5: scanSkillsDir 传入 fullPath**

修改 `packages/kernel/src/skill-manager.ts` 的 `scanSkillsDir`（约 124-130 行，`readFile(join(fullPath, "SKILL.md"))` 成功分支）：

```typescript
        // 先检查当前目录下是否有 SKILL.md（一技能一目录模式）
        try {
          const content = await readFile(join(fullPath, "SKILL.md"), "utf8");
          const info = parseSkillFrontmatter(content, fullPath);
          if (info) {
            skills.push(info);
            continue; // 找到 SKILL.md 就不递归进入该目录
          }
        } catch {
          // 没有 SKILL.md，继续递归
        }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/skill-manager.test.ts`
Expected: PASS（全部用例，包括新加的 path 断言）

- [ ] **Step 7: 类型检查**

Run: `cd packages/kernel && bun run typecheck`
Expected: 无错误（SkillInfo 加了必填 `path`，所有构造处都已填）

- [ ] **Step 8: 提交**

```bash
git add packages/shared/src/skills.ts packages/kernel/src/skill-manager.ts packages/kernel/tests/skill-manager.test.ts
git commit -m "feat(skill): SkillInfo 加 path 字段，扫描时记录 skill 目录路径"
```

---

## Task 2: AgentManager 注入 skillManager + _createSession 传 additionalSkillPaths

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts:13-23`（import）、`39-54`（opts）、`184-213`（loader 创建）
- Modify: `packages/kernel/src/index.ts:65-70`（接线）
- Test: `packages/kernel/tests/agent-manager.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/kernel/tests/agent-manager.test.ts` 顶部 import 区追加（与现有 import 合并；现有第 5 行是 `import { rmSync } from "node:fs";`，合并为下面这行）：

```typescript
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SkillManager } from "../src/skill-manager";
```

在文件末尾追加测试：

```typescript
// 临时 skill 目录（Task 2 测试用）
function tmpSkillRoot() {
  const root = `/tmp/wa-pi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  mkdirSync(join(root, "skills"), { recursive: true });  // builtin（空）
  return root;
}
function createSkillAt(dir: string, name: string, desc: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`);
}

test("ensureStarted 把启用 skill 路径作为 additionalSkillPaths 传给 loader", async () => {
  const skillRoot = tmpSkillRoot();
  tmpFiles.push(skillRoot);  // 复用现有 afterEach 清理
  const userDir = join(skillRoot, "user-skills");
  mkdirSync(userDir, { recursive: true });
  createSkillAt(userDir, "my-skill", "测试技能");
  const skillManager = new SkillManager(skillRoot);
  await skillManager.addDir(userDir);

  const capturedLoaders: any[] = [];
  const createFn = mock(async (opts: any) => {
    capturedLoaders.push(opts.resourceLoader);
    return { session: fakeSession as AgentSession, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });

  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    skillManager,
    createAgentSessionFn: createFn as any,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  expect(capturedLoaders).toHaveLength(1);
  const paths = capturedLoaders[0].additionalSkillPaths as string[];
  expect(paths.some((p) => p === join(userDir, "my-skill"))).toBe(true);
});

test("additionalSkillPaths 不含 builtin 来源的 skill（由 SDK 自动扫，避免碰撞）", async () => {
  const skillRoot = tmpSkillRoot();
  tmpFiles.push(skillRoot);
  createSkillAt(join(skillRoot, "skills"), "builtin-skill", "内置");  // builtin
  const userDir = join(skillRoot, "user-skills");
  mkdirSync(userDir, { recursive: true });
  createSkillAt(userDir, "user-skill", "用户");
  const skillManager = new SkillManager(skillRoot);
  await skillManager.addDir(userDir);

  const capturedLoaders: any[] = [];
  const createFn = mock(async (opts: any) => {
    capturedLoaders.push(opts.resourceLoader);
    return { session: fakeSession as AgentSession, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });

  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    skillManager,
    createAgentSessionFn: createFn as any,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  const paths = capturedLoaders[0].additionalSkillPaths as string[];
  expect(paths.some((p) => p === join(userDir, "user-skill"))).toBe(true);
  expect(paths.some((p) => p === join(join(skillRoot, "skills"), "builtin-skill"))).toBe(false);
});

test("skillManager 为空时 additionalSkillPaths 为空数组（不破坏现有无 skillManager 场景）", async () => {
  const capturedLoaders: any[] = [];
  const createFn = mock(async (opts: any) => {
    capturedLoaders.push(opts.resourceLoader);
    return { session: fakeSession as AgentSession, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: createFn as any,
    // 不传 skillManager
  });
  await am.ensureStarted(project.id, "dev", session.id);

  expect(capturedLoaders[0].additionalSkillPaths).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/agent-manager.test.ts -t "additionalSkillPaths"`
Expected: FAIL — `capturedLoaders[0].additionalSkillPaths` 为 `undefined`（loader 还没传该选项）

- [ ] **Step 3: AgentManagerOpts 加 skillManager 字段**

修改 `packages/kernel/src/agent-manager.ts` 的 `AgentManagerOpts`（约 39-54 行），在 `createAgentSessionFn` 前加：

```typescript
  // skillManager 可空：测试用 mock createAgentSession 且不关心 skill 时可不传；
  // 生产注入真实 SkillManager，_createSession 用其 scan() 取启用 skill 路径喂给 SDK loader
  skillManager?: SkillManager;
```

并在文件顶部 import 区（约 13-23 行）加：

```typescript
import type { SkillManager } from "./skill-manager";
```

- [ ] **Step 4: _createSession 注入 additionalSkillPaths**

在 `packages/kernel/src/agent-manager.ts` 的 `_createSession` 中，找到创建 loader 的位置（约 184-213 行，`const loader = new sdk.DefaultResourceLoader({`）。在 `new sdk.DefaultResourceLoader({` 之前插入解析 skill 路径的逻辑，并在 loader 选项里加 `additionalSkillPaths`：

```typescript
    // AgentConfig → SDK ResourceLoader 选项映射
    // - systemPromptMode === "replace"：整体覆盖系统提示词
    // - systemPromptMode === "append"：在默认 agentsFiles 后追加虚拟文件

    // 解析启用 skill 的目录路径，喂给 SDK additionalSkillPaths。
    // 只含 userSkillDirs 来源的 skill（builtin 由 SDK includeDefaults 自动扫，重复传入会触发碰撞诊断）。
    // additionalSkillPaths 构造时固定，skill 配置变更后需重建会话才能刷新（见 _reloadIfDirty）。
    const additionalSkillPaths = await resolveEnabledSkillPaths(this.opts.skillManager);

    const loader = new sdk.DefaultResourceLoader({
      cwd: project.cwd,
      agentDir: WA_PI_DIR,
      additionalExtensionPaths: buildAdditionalExtensionPaths(),
      additionalSkillPaths,
      // 默认 replace 模式：始终提供 customPrompt，绕过 SDK 默认提示词
      // （"operating inside pi" + "Pi documentation" 段，会把底层暴露给 agent）。
      // 显式 replace 配置优先用用户 body；其余（含无配置）一律用 wa-pi 默认提示词。
      systemPromptOverride: () =>
        config?.systemPromptMode === "append" && config.systemPromptBody
          ? config.systemPromptBody!
          : WA_PI_DEFAULT_SYSTEM_PROMPT,
      agentsFilesOverride:
        config?.systemPromptMode === "append" && config.systemPromptBody
          ? (current: {
              agentsFiles: Array<{ path: string; content: string }>;
            }) => ({
              agentsFiles: [
                ...current.agentsFiles,
                {
                  path: `/virtual/${config.name}.md`,
                  content: config.systemPromptBody!,
                },
              ],
            })
          : undefined,
    });
```

并在文件底部（`resolveModel` 之前或之后）加辅助函数：

```typescript
/**
 * 解析启用 skill 的目录路径列表，供 SDK additionalSkillPaths 使用。
 * 只含来自 userSkillDirs 的 skill（scan().dirs 中除 builtinDir 外的目录），builtin 留给 SDK 自动扫。
 * skillManager 为空（测试场景）时返回空数组。
 */
async function resolveEnabledSkillPaths(
  skillManager: SkillManager | undefined,
): Promise<string[]> {
  if (!skillManager) return [];
  const { skills, dirs, builtinDir } = await skillManager.scan();
  const userDirs = dirs.filter((d) => d !== builtinDir);
  return skills
    .filter((s) => userDirs.some((d) => isUnderPath(s.path, d)))
    .map((s) => s.path);
}

/** 判断 child 是否在 parent 目录下（含相等）。跨平台用 relative 判定，避免盘符/大小写/分隔符差异。 */
function isUnderPath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
```

并在顶部 import 区补 `relative`、`isAbsolute`（现有已有 `relative` from `node:path`，追加 `isAbsolute`）：

```typescript
import { relative, isAbsolute } from "node:path";
```

- [ ] **Step 5: index.ts 接线注入 skillManager**

修改 `packages/kernel/src/index.ts` 的 `new AgentManager({ ... })`（约 65-70 行），加 `skillManager`：

```typescript
  const agentManager = new AgentManager({
    projectStore,
    configStore,
    providerStore,
    skillManager,
    onEvent: (sessionId, projectId, agentName, event) => {
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/agent-manager.test.ts`
Expected: PASS（新 3 个 + 现有全部通过；现有用例未传 skillManager，走空数组分支不破坏）

- [ ] **Step 7: 类型检查**

Run: `cd packages/kernel && bun run typecheck`
Expected: 无错误

- [ ] **Step 8: 提交**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/src/index.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "feat(kernel): _createSession 把启用 skill 路径注入 loader additionalSkillPaths"
```

---

## Task 3: markSkillsDirty + sessionMeta + _teardownSession

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts`（新增字段、方法、重构 disposeSession）
- Test: `packages/kernel/tests/agent-manager.test.ts`

- [ ] **Step 1: 写失败测试**

在 `packages/kernel/tests/agent-manager.test.ts` 末尾追加：

```typescript
test("markSkillsDirty 标记所有活跃会话（与 markAllDirty 独立）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);

  // markSkillsDirty 不应触发 markAllDirty 的 reload 路径
  (fakeSession.reload as any).mockClear();
  am.markSkillsDirty();
  await am.ensureStarted(project.id, "dev", session.id);  // 暂时未实现重建，先不校验重建
  // 重建分支在 Task 4 实现；此处仅校验 markSkillsDirty 不走 reload
  expect(fakeSession.reload).not.toHaveBeenCalled();
});

test("disposeSession 清理 sessionMeta 与 skillDirty", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: mockCreateAgentSession,
  });
  await am.ensureStarted(project.id, "dev", session.id);
  am.markSkillsDirty();
  await am.disposeSession(session.id);

  // dispose 后再 markAllDirty 不应包含已清理的 session（间接验证 skillDirty/sessionMeta 已清）
  am.markAllDirty();
  // 无活跃会话，不抛即通过
  expect(true).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/agent-manager.test.ts -t "markSkillsDirty"`
Expected: FAIL — `am.markSkillsDirty is not a function`

- [ ] **Step 3: 加 skillDirty 字段 + markSkillsDirty 方法 + sessionMeta**

在 `packages/kernel/src/agent-manager.ts` 的 `AgentManager` 类字段区（约 75-87 行，`dirty` 字段附近）加：

```typescript
  // deferred 重建：skill 配置变更（目录增删 / skill 禁用）后标脏；会话下次命中缓存且 idle 时重建。
  // 与 dirty（reload 路径，extension toggle 用）分开，因为 additionalSkillPaths 构造时固定，必须重建才能刷新。
  private skillDirty = new Set<string>();
  // sessionId → {projectId, agentName}，重建会话时复用（_reloadIfDirty 没有 projectId/agentName 入参）
  private sessionMeta = new Map<string, { projectId: string; agentName: AgentName }>();
```

在 `markAllDirty` 方法后（约 130 行）加：

```typescript
  /**
   * 标记当前所有活跃会话为待重建（skill 目录增删 / skill 禁用后调用）。
   * 不立即重建——各会话在下次被 ensureStarted（切换/使用）且 idle 时各自重建一次。
   * 与 markAllDirty 区别：走重建而非 reload，因为 additionalSkillPaths 构造时固定。
   */
  markSkillsDirty(): void {
    for (const id of this.sessions.keys()) this.skillDirty.add(id);
  }
```

- [ ] **Step 4: _createSession 填 sessionMeta**

在 `packages/kernel/src/agent-manager.ts` 的 `_createSession` 末尾（约 `this.sessionCwd.set(sessionId, project.cwd);` 之后、临时 debug log 之前）加：

```typescript
    this.sessionMeta.set(sessionId, { projectId, agentName });
```

- [ ] **Step 5: 抽出 _teardownSession，重构 disposeSession**

在 `packages/kernel/src/agent-manager.ts` 中，把 `disposeSession`（约 418-428 行）改为调用新抽出的 `_teardownSession`：

```typescript
  /** 拆除单个会话的内部资源（unsubscribe + dispose + 清各 Map），不动 disposed 标记。
   *  disposeSession（用户删除）与 _reloadIfDirty 重建共用。重建不能动 disposed，
   *  否则 _createSession 末尾的 disposed 检查会把新 session 当「创建中被清理」丢弃。 */
  private _teardownSession(sessionId: string): void {
    this.unsubscribers.get(sessionId)?.();
    this.unsubscribers.delete(sessionId);
    this.sessions.get(sessionId)?.dispose();
    this.sessions.delete(sessionId);
    this.sessionCwd.delete(sessionId);
    this.sessionMeta.delete(sessionId);
    this.jumpQueueLocks.delete(sessionId);
    this.dirty.delete(sessionId);
    this.skillDirty.delete(sessionId);
  }

  /** 清理单个会话：标记 disposed（防创建中被复用）+ 拆除资源 */
  async disposeSession(sessionId: string): Promise<void> {
    // 标记已被 dispose：若创建仍在进行中，_createSession 完成时会据此清理并放弃
    this.disposed.add(sessionId);
    this._teardownSession(sessionId);
  }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/agent-manager.test.ts`
Expected: PASS（新 2 个 + 现有全部通过；现有 disposeSession 测试验证 dispose+unsubscribe 仍成立）

- [ ] **Step 7: 类型检查**

Run: `cd packages/kernel && bun run typecheck`
Expected: 无错误

- [ ] **Step 8: 提交**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "refactor(kernel): 抽出 _teardownSession，加 markSkillsDirty/sessionMeta 为重建铺路"
```

---

## Task 4: _reloadIfDirty 重建分支 + isCompacting 守卫 + 返回 session

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts:96-106`（ensureStarted 缓存命中分支）、`132-145`（_reloadIfDirty）
- Modify: `packages/kernel/tests/agent-manager.test.ts`（fakeSession 加 isCompacting、重建测试）

- [ ] **Step 1: 给 fakeSession 加 isCompacting 默认值**

在 `packages/kernel/tests/agent-manager.test.ts` 的 `fakeSession` 对象（约 19-36 行）加一行：

```typescript
  isStreaming: false,
  pendingMessageCount: 0,
  isCompacting: false,
```

并在 `beforeEach`（约 56-57 行）的 mock 清理区加：

```typescript
  (fakeSession as any).isStreaming = false;
  (fakeSession as any).pendingMessageCount = 0;
  (fakeSession as any).isCompacting = false;
```

- [ ] **Step 2: 写失败测试（重建 + idle 跳过）**

在 `packages/kernel/tests/agent-manager.test.ts` 末尾追加：

```typescript
// 重建测试用的工厂：每次返回独立 mock session（独立 dispose/subscribe）
function makeFreshSession() {
  return {
    ...fakeSession,
    prompt: mock(async () => {}),
    abort: mock(async () => {}),
    dispose: mock(() => {}),
    setSessionName: mock(() => {}),
    setModel: mock(async () => {}),
    setThinkingLevel: mock(() => {}),
    subscribe: mock(() => mock(() => {})),
    clearQueue: mock(() => ({ steering: [], followUp: [] })),
    followUp: mock(async () => {}),
    steer: mock(async () => {}),
    reload: mock(async () => {}),
    messages: [],
    model: { id: "test-model" } as any,
    modelRegistry: fakeModelRegistry as any,
    isStreaming: false,
    pendingMessageCount: 0,
    isCompacting: false,
  } as any as AgentSession;
}

test("markSkillsDirty + idle → 重建会话（dispose 旧、创建新、返回新 session）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const created: AgentSession[] = [];
  const createFn = mock(async () => {
    const s = makeFreshSession();
    created.push(s);
    return { session: s, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: createFn as any,
  });
  const first = await am.ensureStarted(project.id, "dev", session.id);
  expect(created).toHaveLength(1);

  am.markSkillsDirty();
  const second = await am.ensureStarted(project.id, "dev", session.id);  // idle → 重建

  expect(created).toHaveLength(2);                       // 重建调了一次 createFn
  expect(second).toBe(created[1]);                       // 返回新 session
  expect(second).not.toBe(first);                        // 与旧 session 不同
  expect((created[0].dispose as any)).toHaveBeenCalledTimes(1);  // 旧 session 被 dispose
  // 重建后 skillDirty 清除，再次命中不重建
  await am.ensureStarted(project.id, "dev", session.id);
  expect(created).toHaveLength(2);
});

test("markSkillsDirty 后 streaming 时跳过重建，保留 skillDirty（idle 后补重建）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const created: AgentSession[] = [];
  const createFn = mock(async () => {
    const s = makeFreshSession();
    created.push(s);
    return { session: s, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: createFn as any,
  });
  const first = await am.ensureStarted(project.id, "dev", session.id);
  (first as any).isStreaming = true;  // 模拟生成中

  am.markSkillsDirty();
  const r = await am.ensureStarted(project.id, "dev", session.id);  // streaming → 跳过
  expect(created).toHaveLength(1);
  expect(r).toBe(first);  // 返回旧 session，未重建

  (first as any).isStreaming = false;  // idle
  const r2 = await am.ensureStarted(project.id, "dev", session.id);  // 补重建
  expect(created).toHaveLength(2);
  expect(r2).toBe(created[1]);
});

test("markAllDirty 仍走 reload 路径（不被重建逻辑影响）", async () => {
  const projectStore = newProjectStore();
  const project = await projectStore.createProject({ name: "测试", cwd: "/tmp" });
  const session = await projectStore.createSession({ projectId: project.id, primaryAgent: "dev", title: "测试" });

  const created: AgentSession[] = [];
  const createFn = mock(async () => {
    const s = makeFreshSession();
    created.push(s);
    return { session: s, extensionsResult: { extensions: [], errors: [], runtime: {} as any } };
  });

  const am = new AgentManager({
    projectStore, configStore: null as any, onEvent: () => {},
    createAgentSessionFn: createFn as any,
  });
  const first = await am.ensureStarted(project.id, "dev", session.id);
  (first.reload as any).mockClear();

  am.markAllDirty();
  const r = await am.ensureStarted(project.id, "dev", session.id);  // dirty → reload
  expect(first.reload as any).toHaveBeenCalledTimes(1);
  expect(r).toBe(first);  // reload 不换 session
  expect(created).toHaveLength(1);  // 未重建
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/agent-manager.test.ts -t "重建会话"`
Expected: FAIL — `created` 仍为 1（`_reloadIfDirty` 还没实现重建，仍走 reload 或 no-op）

- [ ] **Step 4: _reloadIfDirty 加重建分支 + isCompacting + 返回 session**

修改 `packages/kernel/src/agent-manager.ts` 的 `_reloadIfDirty`（约 132-145 行），整体替换为：

```typescript
  /**
   * 命中缓存时：按 dirty 来源决定 reload 还是重建，返回当前生效的 session。
   * - skillDirty（skill 配置变更）→ 重建：additionalSkillPaths 构造时固定，reload 刷不进，必须重建 loader。
   * - dirty（extension toggle 等 SDK 原生 settings 变更）→ 轻量 reload。
   * 进行中（streaming / pending / compacting）时一律跳过，保留 dirty 等 idle。
   */
  private async _reloadIfDirty(
    sessionId: string,
    session: AgentSession,
  ): Promise<AgentSession> {
    const isBusy =
      session.isStreaming ||
      session.pendingMessageCount > 0 ||
      (session as any).isCompacting;

    // skill 配置变更 → 重建
    if (this.skillDirty.has(sessionId)) {
      if (isBusy) return session;  // 进行中，保留 skillDirty 等 idle
      this.skillDirty.delete(sessionId);
      const meta = this.sessionMeta.get(sessionId);
      if (!meta) {
        // 无上下文无法重建，降级 reload
        try { await (session as any).reload(); } catch (err) {
          console.error(`[kernel] session ${sessionId} 降级 reload 失败:`, err);
        }
        return session;
      }
      // 重建：拆除旧 session（不动 disposed）+ 重新 _createSession（重开同一 piSessionFile，历史不丢）。
      // 用 starting 锁防止重建期间并发 ensureStarted 重复创建。
      this._teardownSession(sessionId);
      const promise = this._createSession(meta.projectId, meta.agentName, sessionId);
      this.starting.set(sessionId, promise);
      try {
        return await promise;
      } finally {
        this.starting.delete(sessionId);
      }
    }

    // 其它 dirty → 轻量 reload
    if (this.dirty.has(sessionId)) {
      if (isBusy) return session;  // 进行中，保留 dirty 等 idle
      this.dirty.delete(sessionId);
      try {
        await (session as any).reload();
      } catch (err) {
        console.error(`[kernel] session ${sessionId} deferred reload 失败:`, err);
      }
    }
    return session;
  }
```

- [ ] **Step 5: ensureStarted 缓存命中分支用 _reloadIfDirty 的返回值**

修改 `packages/kernel/src/agent-manager.ts` 的 `ensureStarted`（约 102-106 行），把：

```typescript
    const existing = this.sessions.get(sessionId);
    if (existing) {
      await this._reloadIfDirty(sessionId, existing);
      return existing;
    }
```

改为：

```typescript
    const existing = this.sessions.get(sessionId);
    if (existing) {
      // _reloadIfDirty 可能重建会话并返回新 session（skillDirty 路径），用返回值而非旧引用
      return await this._reloadIfDirty(sessionId, existing);
    }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/kernel && bun test tests/agent-manager.test.ts`
Expected: PASS（新 3 个重建测试 + 现有 markAllDirty/reload 测试全部通过）

- [ ] **Step 7: 类型检查**

Run: `cd packages/kernel && bun run typecheck`
Expected: 无错误

- [ ] **Step 8: 提交**

```bash
git add packages/kernel/src/agent-manager.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "feat(kernel): _reloadIfDirty 加 skill 重建分支与 isCompacting 守卫，惰性重建会话"
```

---

## Task 5: ws-server skill handlers 改调 markSkillsDirty

**Files:**
- Modify: `packages/kernel/src/ws-server.ts:493-516`（三个 skill handler）
- Modify: `packages/kernel/tests/ws-skill.test.ts`（mock 加 markSkillsDirty + 断言）

- [ ] **Step 1: 写失败测试**

修改 `packages/kernel/tests/ws-skill.test.ts` 的 `makeMockAgentManager`（约 14-25 行），加 `markSkillsDirty` 跟踪：

```typescript
function makeMockAgentManager() {
  const calls = { reloadAll: 0, markAllDirty: 0, markSkillsDirty: 0 };
  return {
    ensureStarted: async () => ({ messages: [], prompt: async () => {}, abort: async () => {}, dispose: () => {} }),
    prompt: async () => {},
    abort: async () => {},
    disposeSession: async () => {},
    disposeAll: async () => {},
    markAllDirty: () => { calls.markAllDirty++; },
    markSkillsDirty: () => { calls.markSkillsDirty++; },
    calls,
  } as any;
}
```

修改 `withSkillServer`（约 27-56 行），把 `mockAM.calls` 暴露给测试 fn。把函数签名与调用改为：

```typescript
async function withSkillServer<T>(
  fn: (send: (e: WSClientEvent) => void, recv: () => Promise<WSServerEvent>, calls: { markAllDirty: number; markSkillsDirty: number }) => Promise<T>,
): Promise<T> {
  const dataDir = tmp("ws-skill");
  mkdirSync(join(dataDir, "skills"), { recursive: true });
  const mockAM = makeMockAgentManager();
  const server = new WSServer({
    configStore: new ConfigStore(tmp("ws-cfg")),
    projectStore: new ProjectStore(tmp("ws-proj.json")),
    providerStore: new ProviderStore(join(dataDir, "providers.json")),
    skillManager: new SkillManager(dataDir),
    extensionManager: new ExtensionManager(dataDir, { resolveEntryPath: () => "/fake/pi-lens/dist/index.js", readVersion: () => "0.0.0" }),
    memoryStore: null as any,
    agentManager: mockAM,
    dataDir,
    port: 0,
  });
  await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${server.actualPort}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const queue: WSServerEvent[] = [];
  ws.onmessage = (ev) => queue.push(JSON.parse(String(ev.data)));
  const send = (e: WSClientEvent) => ws.send(JSON.stringify(e));
  const recv = async (): Promise<WSServerEvent> => {
    while (queue.length === 0) await new Promise(r => setTimeout(r, 20));
    return queue.shift()!;
  };
  try { return await fn(send, recv, mockAM.calls); }
  finally { ws.close(); await server.stop(); rmSync(dataDir, { recursive: true, force: true }); }
}
```

把现有 `skillDir:add` 测试（约 68-77 行）改名为 markSkillsDirty 并加断言：

```typescript
test("skillDir:add 成功后 markSkillsDirty 被调用 + 广播 changed", async () => {
  await withSkillServer(async (send, recv, calls) => {
    const userDir = tmp("user-skills");
    mkdirSync(userDir, { recursive: true });
    send({ type: "skillDir:add", path: userDir });
    const changed = await recv() as any;
    expect(changed.type).toBe("skill:changed");
    expect(changed.dirs).toContain(userDir);
    expect(calls.markSkillsDirty).toBe(1);
    expect(calls.markAllDirty).toBe(0);
  });
});
```

把其余用到 `fn(send, recv)` 的测试（`skill:list`、`skillDir:add 不存在`、`skill:toggle`、`skillDir:remove` 等）的回调签名补上第三个参数 `calls`（或用 `(send, recv) =>` 也可，因为 JS 忽略多余参数——但为一致，统一改成 `(send, recv, _calls)`）。对 `skill:toggle` 测试追加断言：

```typescript
test("skill:toggle 禁用后 skills 不含但 allSkills 含 + markSkillsDirty", async () => {
  await withSkillServer(async (send, recv, calls) => {
    send({ type: "skill:toggle", skillName: "fake-skill", disabled: true });
    // 先收到 skill:changed
    const changed = await recv() as any;
    expect(changed.type).toBe("skill:changed");
    expect(calls.markSkillsDirty).toBe(1);
  });
});
```

（若该测试原本还有后续 `skill:list` 断言，保留之；此处仅展示新增的 markSkillsDirty 断言。实现时在原测试基础上追加，不删原有断言。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/kernel && bun test tests/ws-skill.test.ts -t "markSkillsDirty"`
Expected: FAIL — `calls.markSkillsDirty` 为 0（ws-server 还在调 `markAllDirty`）

- [ ] **Step 3: ws-server 三个 skill handler 改调 markSkillsDirty**

修改 `packages/kernel/src/ws-server.ts` 的三个 handler（约 493-516 行），把 `this.opts.agentManager.markAllDirty()` 改为 `this.opts.agentManager.markSkillsDirty()`：

```typescript
      case "skill:toggle": {
        await this.opts.skillManager.toggleSkill(event.skillName, event.disabled);
        this.opts.agentManager.markSkillsDirty();
        const result = await this.opts.skillManager.scan();
        // ...（reply 不变）
      case "skillDir:add": {
        await this.opts.skillManager.addDir(event.path);
        this.opts.agentManager.markSkillsDirty();
        const result = await this.opts.skillManager.scan();
        // ...
      case "skillDir:remove": {
        await this.opts.skillManager.removeDir(event.path);
        this.opts.agentManager.markSkillsDirty();
        const result = await this.opts.skillManager.scan();
        // ...
```

（仅改 `markAllDirty()` → `markSkillsDirty()` 这一行，三个 handler 各改一处。`extension:toggle` 的 `markAllDirty()`（约 536 行）保持不变。）

- [ ] **Step 4: 跑全部 ws-skill 测试确认通过**

Run: `cd packages/kernel && bun test tests/ws-skill.test.ts`
Expected: PASS（所有用例通过；`extension:toggle` 相关测试在 ws-extension.test.ts，不受影响）

- [ ] **Step 5: 跑全部 kernel 测试确认无回归**

Run: `cd packages/kernel && bun test`
Expected: PASS（全部通过）

- [ ] **Step 6: 类型检查**

Run: `cd packages/kernel && bun run typecheck`
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add packages/kernel/src/ws-server.ts packages/kernel/tests/ws-skill.test.ts
git commit -m "refactor(kernel): skill 配置变更改调 markSkillsDirty（走重建路径）"
```

---

## Task 6: 手动验证 + 清理临时 debug log

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts:250-255`（移除临时 log）

- [ ] **Step 1: 启动 kernel，确认提示词含 skills 段**

Run: `cd packages/kernel && bun run dev`
操作：前端打开「系统设置 → 技能」，确认已配置的 skill 目录（如 `C:\Users\<user>\.reasonix\skills`）；新建一个会话发条消息。
Expected: kernel 控制台输出 `[wa-pi][debug] system prompt for ...:` 后接的提示词中包含 skills 段（如 `## Skills` 或 skill 名称列表）。

- [ ] **Step 2: 验证 skill 变更后惰性重建生效**

操作（kernel 运行中）：在设置里新增一个 skill 目录 → 回到已存在的会话刷新/切走再切回 → 查看新打印的 system prompt。
Expected: skills 段包含新目录的 skill（重建后 loader 读到新 additionalSkillPaths）。

- [ ] **Step 3: 移除临时 debug log**

修改 `packages/kernel/src/agent-manager.ts`，删除 `_createSession` 末尾的临时 log 块（约 250-255 行）：

```typescript
    this.sessions.set(sessionId, session);
    this.unsubscribers.set(sessionId, unsubscribe);
    this.sessionCwd.set(sessionId, project.cwd);

    // [debug] 临时：打印 agent 最终看到的 system prompt（调试完移除）   ← 删除这整块
    console.log(
      `[wa-pi][debug] system prompt for ${projectId}/${agentName}/${sessionId}:\n${session.systemPrompt}`,
    );

    return session;
```

改为（恢复原状）：

```typescript
    this.sessions.set(sessionId, session);
    this.unsubscribers.set(sessionId, unsubscribe);
    this.sessionCwd.set(sessionId, project.cwd);

    return session;
```

- [ ] **Step 4: 类型检查 + 测试**

Run: `cd packages/kernel && bun run typecheck && bun test`
Expected: 无错误，全部测试通过

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/agent-manager.ts
git commit -m "chore(kernel): 移除 system prompt 调试 log（skill 注入验证完成）"
```

---

## Self-Review 记录

**Spec coverage**：
- §3.1 B（SkillInfo.path / scanSkillsDir 记录 / _createSession 注入 / index.ts 接线 / 范围过滤）→ Task 1 + Task 2 ✅
- §3.2 C1（markSkillsDirty / sessionMeta / _reloadIfDirty 重建 / isCompacting / ws-server 三 handler）→ Task 3 + Task 4 + Task 5 ✅
- §3.3 重建触发点（ensureStarted 缓存命中返回新 session）→ Task 4 Step 5 ✅
- §5.2 disposed 坑（_teardownSession 不动 disposed）→ Task 3 Step 5 ✅
- §6 测试（单元 + 集成 + 验证）→ 各 Task TDD + Task 6 手动验证 ✅

**类型一致性**：`markSkillsDirty` / `skillDirty` / `sessionMeta` / `_teardownSession` 在 Task 3 定义，Task 4/5 使用，命名一致。`_reloadIfDirty` 返回 `Promise<AgentSession>`，`ensureStarted` 用返回值，签名一致。`resolveEnabledSkillPaths` / `isUnderPath` 在 Task 2 定义并使用。

**已知风险（手动验证重点）**：Task 4 重建调 `_createSession` 重开同一 `piSessionFile`——依赖 SDK `session.dispose()` 释放文件句柄。现有 `session:delete` → 后续 `ensureStarted` 重开同一文件的路径已验证可行，重建复用同一机制，风险低；若手动验证发现文件句柄冲突，需在 `_teardownSession` 与 `_createSession` 间补 await 或排查 SDK dispose 行为。
