# Skill 注入系统提示词 · 设计文档

> **日期**：2026-07-11
> **状态**：已确认，待实现
> **背景**：调试时打印 `session.systemPrompt` 发现 skills 段缺失。用户在「系统设置 → 技能」配置了 skill 目录，但 agent 看不到任何 skill。

## 1. 问题

wa-pi 的 skill 管理存在断点：**前端能看到技能，agent 看不到**。

- `skill-manager.ts` 扫描 `settings.json` 的 `userSkillDirs`（如 `C:\Users\<user>\.reasonix\skills`），仅供前端 UI 列表 / 开关使用。
- `agent-manager.ts` 创建 SDK `DefaultResourceLoader` 时未传入任何 skill 路径。
- SDK 的 `buildSystemPrompt`（customPrompt 分支）追加 skills 段的条件是 `skills.length > 0`，而 `loader.getSkills().skills` 为空 → skills 段被跳过。

## 2. 根因（已验证）

### 2.1 SDK 的 skill 来源

`buildSystemPrompt` 的 skills 段依赖 `loader.getSkills().skills`，该列表由 `DefaultResourceLoader.reload()` 经 `loadSkills()` 填充，来源有三：

1. `resolvedPaths.skills` —— SDK 原生 settings 解析（`packageManager.resolve()`）。
2. `cliExtensionPaths.skills` —— `additionalExtensionPaths` 中携带的 skill。
3. `additionalSkillPaths` —— loader 构造选项，**wa-pi 目前未传**。

SDK `includeDefaults` 还会自动扫描两个固定目录：`<agentDir>/skills`（= `~/.wa-pi/skills`，当前为空）和 `<cwd>/.wa-pi/skills`。

### 2.2 `settings.skills` 字段无效

SDK 的 `settings.skills`（`globalSettings.skills`）**不是扫描目录列表**，而是一组 include/exclude 模式（`+path` 强制包含 / `!pattern` 排除 / 普通模式包含），作用对象是**已被自动扫描到的 skill 路径**（`isEnabledByOverrides`）。它只做 enable/disable 过滤，不添加新扫描目录。

`userSkillDirs`（`C:\Users\<user>\.reasonix\skills`）不是 SDK 的固定扫描目录，写进 `settings.skills` 匹配不到任何已发现路径 → 无效。

### 2.3 `additionalSkillPaths` 是唯一通道，但构造时固定

喂任意用户 skill 目录给 SDK 的**唯一通道是 `additionalSkillPaths`**，而它是 loader 构造时赋值的字段（`this.additionalSkillPaths = options.additionalSkillPaths ?? []`），`session.reload()` → `loader.reload()` 重读时仍用该固定值，**不会重读 settings 的 `userSkillDirs`**。

结论：
- 新建会话 / 内核重启后的会话：`_createSession` 读最新 `userSkillDirs` → 注入即可。
- 已运行会话：skill 配置变更后，`session.reload()` 刷不进新 skill 路径 → **必须重建会话**才能让新 loader 读到新 `additionalSkillPaths`。

## 3. 方案：B（注入）+ C1（惰性重建）

### 3.1 B —— 创建时注入具体 skill 路径

**思路**：复用 `skill-manager` 已有的有界异步扫描，产出**启用** skill 的具体目录路径，作为 `additionalSkillPaths` 传入 loader。SDK 对每个路径命中 `loadSkillsFromDirInternal` 的 SKILL.md 分支直接返回，不递归 → 规避同步递归扫描（skill-manager.ts 当初故意不让 SDK 扫用户目录的顾虑）；天然只含启用 skill（scan 已按 `disabledSkills` 过滤）。

**改动**：

1. **`packages/shared/src/skills.ts`**：`SkillInfo` 加 `path: string` 字段（skill 目录绝对路径，即包含 `SKILL.md` 的目录）。
2. **`packages/kernel/src/skill-manager.ts`**：
   - `parseSkillFrontmatter(content, dir)` 接收目录参数，返回的 `SkillInfo` 填 `path = dir`。
   - `scanSkillsDir` 在 `readFile(join(fullPath, "SKILL.md"))` 成功后，把 `fullPath` 作为 `path` 传入 `parseSkillFrontmatter`。
3. **`packages/kernel/src/agent-manager.ts`**：
   - `AgentManagerOpts` 加 `skillManager: SkillManager`（可空，测试可 mock）。
   - `_createSession` 创建 loader 前，调 `this.opts.skillManager?.scan()` 取启用 skill 的 `path` 列表作为 `additionalSkillPaths`。
4. **`packages/kernel/src/index.ts`**：`new AgentManager({ ..., skillManager })` 注入。

**范围过滤**：`additionalSkillPaths` 只含来自 `userSkillDirs` 的 skill 路径，**不含 `builtinDir`（`~/.wa-pi/skills`）来源的**——builtin 由 SDK `includeDefaults` 自动扫描，重复传入会触发 name collision 诊断（虽被去重，但产生噪音）。

实现方式：按路径前缀过滤——`additionalSkillPaths = skills.filter(s => userDirs.some(d => isUnder(s.path, d))).map(s => s.path)`，其中 `userDirs` 来自 `scan()` 返回的 `dirs`（已去 builtin）。`scan()` 内部按 `[builtinDir, ...userDirs]` 顺序去重（builtin 优先），故与 builtin 同名的 user skill 会被 builtin 占位、其 path 不在结果中 → 自动排除，行为与 SDK 自动扫描一致。

### 3.2 C1 —— skill 配置变更的惰性重建

**思路**：复用现有惰性更新骨架（`markAllDirty` + `_reloadIfDirty` + idle 守卫），但 skill 变更走「重建」而非「reload」——因为 `additionalSkillPaths` 构造时固定，只有重建 loader 才能读新值。重建 = dispose 旧 session + `_createSession` 重开同一 `piSessionFile`（对话历史不丢）。

**改动**：

1. **`agent-manager.ts`**：
   - 新增 `private skillDirty = new Set<string>()` 与 `markSkillsDirty()`（标记所有活跃会话为待重建）。
   - 新增 `private sessionMeta = new Map<string, { projectId: string; agentName: AgentName }>()`，`_createSession` 末尾填、`disposeSession` 清——重建需要 projectId/agentName。
   - 扩展 `_reloadIfDirty(sessionId, session)`：
     - 若 `skillDirty.has(sessionId)` 且 idle → 重建：`disposeSession(sessionId)` 后调 `_createSession(projectId, agentName, sessionId)` 重建（复用 `sessionMeta`），结果回填 `sessions` Map。
     - 否则若 `dirty.has(sessionId)` 且 idle → 照旧 `session.reload()`（extension toggle 等走这条）。
     - idle 守卫扩展为 `isStreaming || pendingMessageCount > 0 || isCompacting`（新增 `isCompacting`，SDK 有该 getter，压缩中不能重建）。

   **`disposed` 集合坑**：`disposeSession` 会 `this.disposed.add(sessionId)`，而 `_createSession` 末尾有 `if (this.disposed.has(sessionId))` 检查——命中则把刚创建的 session 当「创建过程中被 dispose」丢弃并抛错。因此重建不能直接 `disposeSession` + `_createSession` 组合，需在两者之间 `this.disposed.delete(sessionId)` 清标记（复用 `ensureStarted` 里「之前被 dispose 过的 sessionId 允许重新创建」的同一思路），或抽出 `_teardownSession`（只做 unsubscribe + session.dispose + Map 清理，不动 `disposed`）供重建复用。
2. **`ws-server.ts`**：`skill:toggle`（:496）/ `skillDir:add`（:504）/ `skillDir:remove`（:515）三个 handler 的 `markAllDirty()` 改为 `markSkillsDirty()`。`extension:toggle`（:536）保持 `markAllDirty()`（reload 够用）。

### 3.3 重建触发点（已验证稳健）

惰性重建在 `ensureStarted` 命中缓存时触发。`ensureStarted` 的两个调用点覆盖所有「正在用」的会话：

- **查看 / 切换会话**：`SessionView` 挂载（[SessionView.tsx:23-36](packages/frontend/src/components/SessionView.tsx#L23-L36)）发 `session:messages` → ws-server `ensureStarted` → 重建。**页面刷新也走这条**（SessionView 重新挂载）。
- **发消息**：`agent:prompt` → ws-server `ensureStarted` → 重建（重建后才 prompt）。
- **进行中会话**：idle 守卫跳过，保留 `skillDirty`，等 idle 后下次 `ensureStarted` 重建——满足「完成后才生成」。
- **内核进程重启**：`skillDirty` 集合丢失，但 `sessions` Map 也清空 → 下次 `ensureStarted` 走全新 `_createSession` 读最新 settings → 最新 skills。不依赖 dirty，最干净。

**唯一 stale 窗口**：`skillDirty` 但既未被查看 / 发消息、内核也未重启的会话——它没在被用，stale 无害，下次打开即重建。没有任何「正在用的会话」会停在旧 skills 上。

## 4. 数据流

```
用户在设置里加 skill 目录
  → ws-server skillDir:add
  → skillManager.addDir(path)（写 settings.json userSkillDirs）
  → agentManager.markSkillsDirty()          ← 新增
  → 前端收到 skill:list 刷新（UI 立即看到）

用户下次查看/发消息到某会话
  → ensureStarted 命中缓存
  → _reloadIfDirty: skillDirty && idle
  → disposeSession + _createSession         ← 重建
    → skillManager.scan() 取启用 skill 的 path
    → new DefaultResourceLoader({ additionalSkillPaths: [...] })
    → SDK loadSkills 加载具体 skill 目录（不递归）
    → buildSystemPrompt 追加 skills 段
  → 新 session 接管，历史从 piSessionFile 恢复
```

## 5. 边界与不做

### 5.1 不做（YAGNI）

- **不用 `settings.skills`**：已验证无效（模式过滤器，非扫描目录列表）。
- **不用 C2（改 private 字段 + reload）**：`additionalSkillPaths` 是 SDK private 字段，`as any` 改它跨版本易碎，不值得为省重建开销冒升级风险。
- **不用 D（junction 进 `~/.wa-pi/skills`）**：`~/.wa-pi/skills` 是 skill-manager 的 `builtinDir`，junction 会被前端当 builtin 扫到，scope 标签错乱；且要管 junction 生命周期。
- **不做后台主动重建**：惰性 `ensureStarted` 已覆盖所有「正在用」的会话；未被用的会话 stale 无害。
- **不做 scan 结果缓存**：`scan()` 已有单目录 8s 超时保护，典型 skill 目录扫描很快，先不引入缓存复杂度。

### 5.2 已知行为

- skill-toggle（禁用某 skill）也走重建——因为 `additionalSkillPaths` 中的 skill 不受 SDK `disabledSkills` 过滤（绕过 enabled 机制），禁用只能靠重建时 skill-manager 重新过滤。**禁用 skill 后，当前会话要等 idle 重建才生效**，和 skill 目录增删一致。
- 重建会丢一些纯内存的瞬时状态（重试计数等），idle 时这些本就归零，安全。
- `scan()` 在 `_createSession` 中调用，给会话创建增加一次 skill 目录扫描（有超时保护）；与前端 `skill:list` 的扫描独立，互不影响。

## 6. 测试

遵循 AGENTS.md 四层测试原则：

1. **单元（bun:test）**
   - `scanSkillsDir` 返回的 `SkillInfo` 含正确 `path`（skill 目录绝对路径）。
   - `parseSkillFrontmatter` 在缺 SKILL.md / 缺 name 时返回 null 且不抛。
   - `AgentManager._createSession` 传入 loader 的 `additionalSkillPaths` = 启用 skill 路径列表（mock `createAgentSessionFn` 捕获 loader 选项）。
   - `additionalSkillPaths` 不含 builtinDir 来源的 skill（避免碰撞）。
   - `markSkillsDirty` 标记所有活跃会话；`disposeSession` 清 `sessionMeta` 与 `skillDirty`。
2. **集成**
   - mock `createAgentSessionFn`：skill 变更 → `markSkillsDirty` → idle 后 `ensureStarted` 触发重建（断言旧 session 被 dispose、新 session 创建、`additionalSkillPaths` 更新）。
   - 进行中会话（`isStreaming` true）不重建，保留 `skillDirty`。
3. **验证（手动）**
   - 复用已加的临时 `[wa-pi][debug] system prompt` log，确认打印的提示词含 skills 段。
   - 设置里增删 skill 目录后，刷新 / 切换会话，确认提示词 skills 段随之变化。
4. **回归**
   - extension toggle 仍走 `markAllDirty` + reload，不被重建逻辑影响。

## 7. 实现顺序建议

1. `SkillInfo` 加 `path` + `skill-manager` 扫描记录路径 + 单测。
2. `AgentManagerOpts` 加 `skillManager` + `_createSession` 注入 `additionalSkillPaths` + `index.ts` 接线 + 集成测。
3. `markSkillsDirty` / `sessionMeta` / `_reloadIfDirty` 重建分支 + `isCompacting` 守卫 + 单测。
4. `ws-server` 三个 skill handler 改 `markSkillsDirty`。
5. 手动验证（临时 log 确认 skills 段）+ 移除临时 log。
