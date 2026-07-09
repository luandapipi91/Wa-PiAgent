# 技能管理设计

- **日期**: 2026-07-09
- **状态**: 设计已确认，待实现
- **范围**: 在系统设置页新增「技能」菜单；管理技能加载目录（增删）、查看已加载技能、单独启用/禁用技能
- **前置依赖**: 系统设置页（SettingsModal + 左侧导航）已实现（见 `2026-07-09-settings-provider-management-design.md`）

---

## 1. 目标与范围

### 目标
在系统设置页左侧导航新增「技能」菜单（与「模型管理」并列），提供：

1. **技能目录管理**：查看当前加载的技能目录，支持添加/删除外置技能目录。`~/.hiagent/skills/` 为内置目录，自动创建、不可删除
2. **技能列表查看**：展示从所有目录扫描出的技能（名称 + 描述）
3. **技能启用/禁用**：每个技能可单独禁用，禁用后即使加载了也不生效
4. **实时生效**：配置变更后自动 reload 所有活跃会话

### 技能的两层关系
- **全局技能**（本菜单管理）：从所有技能目录扫描出的全部技能，可全局启用/禁用
- **局部 Agent 技能**（AgentConfig.skills）：每个 agent 从全局已启用的技能池里挑自己能用的子集。全局是局部的超集

### 不做（YAGNI）
- 不做技能的创建/编辑（只管理目录和启用状态）
- 不做 AgentConfig.skills 的 UI（已有 skills 字段，AgentConfig.tsx 的 skills Tab 是占位，本次不动）
- 不做技能测试/预览
- 不做技能目录的递归嵌套展示

---

## 2. 整体布局

技能菜单位于设置页左侧导航，与「模型管理」并列。`activeSection` 联合类型从 `"models"` 扩展为 `"models" | "skills"`。

```
折叠状态（默认）：
┌─ 右侧内容区 ────────────────────────┐
│  技能目录：~/.hiagent/skills/  ▸      │  ← 上方，折叠态只显示内置目录
│                                       │
│  ┌─ 已加载技能 ──────────────────┐   │
│  │ ☑ brave-search    web 搜索     │   │  ← 下方
│  │ ☑ code-review     代码审查     │   │
│  │ ☐ pdf-tools       PDF 处理 [禁用]│   │
│  └────────────────────────────────┘   │
└───────────────────────────────────────┘

展开后：
┌─ 右侧内容区 ────────────────────────┐
│  技能目录：~/.hiagent/skills/  ▾      │
│    ┌──────────────────────────────┐   │
│    │ ~/.hiagent/skills/ [内置]      │   │  ← 内置：无删除按钮
│    │ ~/.claude/skills/        [删除] │   │  ← 用户目录：有删除按钮
│    │ /Users/xxx/my-skills    [删除]  │   │
│    │ [+ 添加技能目录]               │   │
│    └──────────────────────────────┘   │
│                                       │
│  ┌─ 已加载技能 ──────────────────┐   │
│  │ ☑ brave-search    web 搜索     │   │
│  │ ☑ code-review     代码审查     │   │
│  │ ☐ pdf-tools       PDF 处理 [禁用]│   │
│  └────────────────────────────────┘   │
└───────────────────────────────────────┘
```

### 交互细节
- **技能目录区块**：默认折叠，标题行只显示内置目录路径 + `▸`。点击展开后显示全部目录列表（含内置 + 用户添加的）+ 添加/删除按钮
- **内置目录行**：只显示路径 + `[内置]` 标签，**不渲染删除按钮**
- **已加载技能列表**：展示全部扫描到的技能（含被禁用的）。启用的正常显示 + 勾选，禁用的灰显 + 取消勾选 + `[禁用]` 标签。勾上则启用、取消则禁用
- **添加技能目录**：点击「+ 添加技能目录」弹出 DirTreePicker（复用现有组件），用户选目录后确认

---

## 3. 数据模型与 settings.json 结构

### settings.json 结构

在现有 `packages` 基础上新增两个字段：

```json
{
  "packages": [
    "/path/to/pi-intercom/",
    "/path/to/.generated/provider-extension.ts"
  ],
  "skills": [
    "~/.claude/skills",
    "/Users/xxx/my-skills"
  ],
  "disabledSkills": ["pdf-tools"]
}
```

- **`skills`**：Pi SDK 直接读取的字段——用户添加的技能目录路径数组。**内置目录 `~/.hiagent/skills/` 不写入此数组**（Pi 默认从 `agentDir/skills/` 即 `~/.hiagent/skills/` 自动扫描，HiAgent 的 `agentDir = HIAGENT_DIR` 已覆盖）
- **`disabledSkills`**：HiAgent 自定义字段——被禁用的技能名列表。Pi 不认此字段，由 kernel 扫描后过滤

### 内置目录

- 路径：`~/.hiagent/skills/`（即 `${HIAGENT_DIR}/skills/`）
- kernel 启动时 `mkdir -p` 确保存在
- 不写入 `skills` 数组（Pi 已自动扫描 `agentDir/skills/`）
- UI 层始终在目录列表第一行展示，标 `[内置]`，不渲染删除按钮

### 技能扫描与去重

kernel 使用 Pi SDK 导出的 `loadSkills()` 扫描技能。扫描顺序保证**内置目录第一个扫**：

```
扫描顺序：
1. ~/.hiagent/skills/        ← 内置，永远第一（Pi 默认扫描 agentDir/skills）
2. skills 数组[0]            ← 用户添加的，按数组顺序
3. skills 数组[1]
...
```

**去重规则**：同名技能只保留第一个扫到的（即内置目录优先）。后扫到的同名技能直接丢弃。

---

## 4. WS 协议

新增到 `packages/shared/src/types.ts`：

### 前端 → kernel

```ts
export interface SkillListEvent { type: "skill:list"; }
export interface SkillToggleEvent {
  type: "skill:toggle";
  skillName: string;
  disabled: boolean;          // true=禁用，false=启用
}
export interface SkillDirAddEvent {
  type: "skillDir:add";
  path: string;
}
export interface SkillDirRemoveEvent {
  type: "skillDir:remove";
  path: string;
}
```

### kernel → 前端

```ts
export interface SkillListResult {
  type: "skill:list";
  skills: SkillInfo[];        // 扫描出的技能（已过滤禁用项 + 已去重）
  allSkills: SkillInfo[];     // 全部扫描出的技能（含禁用的，用于 UI 灰显）
  dirs: string[];             // 技能目录列表（含内置）
  disabledSkills: string[];   // 被禁用的技能名
  builtinDir: string;         // 内置目录路径（告诉前端哪个不可删）
}

export interface SkillInfo {
  name: string;
  description: string;
}

// skill:changed 与 skill:list 结构相同，任何变更后全量推送
export type SkillChangedEvent = SkillListResult & { type: "skill:changed" };
```

### 事件流

- 前端进入技能菜单 → `skill:list` → kernel 扫描 + 回 `SkillListResult`
- 前端禁用/启用技能 → `skill:toggle` → kernel 改 `disabledSkills` → reload 所有会话 → 推 `skill:changed`
- 前端添加目录 → `skillDir:add` → kernel 校验路径存在 + 写 `skills` 数组 → reload → 推 `skill:changed`
- 前端删除目录 → `skillDir:remove` → kernel 拒绝内置目录 + 从 `skills` 数组移除 → reload → 推 `skill:changed`

---

## 5. kernel 处理逻辑

### 技能扫描

```ts
// 伪代码
async function scanSkills(): Promise<{ skills, allSkills }> {
  // 1. 读 settings.json 的 skills 数组（用户添加的目录）
  const skillPaths = settings.skills ?? [];
  // 2. 用 Pi SDK loadSkills 扫描
  //    - agentDir = HIAGENT_DIR → Pi 自动扫 ~/.hiagent/skills/（内置，第一个扫）
  //    - skillPaths = 用户目录数组 → 按数组顺序扫
  //    - includeDefaults = false → 不扫 Pi 默认的 ~/.pi/agent/skills/ 等（只用 HiAgent 自己的）
  const result = loadSkills({
    cwd: HIAGENT_DIR,
    agentDir: HIAGENT_DIR,
    skillPaths,
    includeDefaults: false,
  });
  // 3. 去重：同名保留先扫到的（内置优先，loadSkills 已保证扫描顺序）
  const allSkills = dedupByName(result.skills);
  // 4. 过滤禁用：disabledSkills 中的不进 skills，但保留在 allSkills
  const skills = allSkills.filter(s => !disabledSkills.includes(s.name));
  return { skills, allSkills };
}
```

### 目录管理

```ts
// skillDir:add
function addSkillDir(path: string): void {
  if (!existsSync(path)) throw new Error("目录不存在");
  const dirs = settings.skills ?? [];
  if (!dirs.includes(path)) {
    dirs.push(path);
    settings.skills = dirs;
    writeSettings(settings);
  }
}

// skillDir:remove
function removeSkillDir(path: string): void {
  if (path === BUILTIN_SKILLS_DIR) throw new Error("内置目录不可删除");
  const dirs = settings.skills ?? [];
  settings.skills = dirs.filter(d => d !== path);
  writeSettings(settings);
}
```

### 热重载

每次配置变更（toggle/dir add/dir remove）后：

```ts
// 遍历所有活跃会话调 reload
for (const session of agentManager.sessions.values()) {
  try { await session.reload(); } catch {}  // 单个失败不阻断
}
```

---

## 6. 前端组件与状态层

### 新增文件

```
packages/frontend/src/
├── components/settings/
│   └── SkillSection.tsx          ← 技能菜单右侧内容
└── store/
    └── skills.ts                 ← Zustand store
```

### 修改文件

| 文件 | 改动 |
|---|---|
| `store/settings.ts` | `activeSection` 联合类型加 `"skills"` + `setSection` 支持 |
| `components/SettingsModal.tsx` | 左侧导航加「技能」项；右侧 `activeSection === "skills"` 时渲染 `<SkillSection />` |
| `App.tsx` | onMessage 路由 `skill:list` / `skill:changed` 到 skills store |

### Zustand store（`store/skills.ts`）

```ts
interface SkillsStore {
  skills: SkillInfo[];           // 已启用的技能
  allSkills: SkillInfo[];        // 全部技能（含禁用）
  dirs: string[];                // 技能目录列表（含内置）
  disabledSkills: string[];      // 被禁用的技能名
  builtinDir: string;            // 内置目录路径
  loading: boolean;
  load: () => void;
  setAll: (data: SkillListResult) => void;
  toggleSkill: (skillName: string) => void;   // 发 skill:toggle
  addDir: (path: string) => void;             // 发 skillDir:add
  removeDir: (path: string) => void;          // 发 skillDir:remove
}
```

### SkillSection 组件

```tsx
// 结构伪代码
function SkillSection() {
  const [dirExpanded, setDirExpanded] = useState(false);  // 默认折叠
  const [showDirPicker, setShowDirPicker] = useState(false);
  const { allSkills, dirs, disabledSkills, builtinDir } = useSkillsStore();

  return (
    <div>
      {/* 技能目录（上方，默认折叠） */}
      <div onClick={() => setDirExpanded(!dirExpanded)}>
        技能目录：{builtinDir} {dirExpanded ? "▾" : "▸"}
      </div>
      {dirExpanded && (
        <div>
          {dirs.map(dir => (
            <div key={dir}>
              {dir}
              {dir === builtinDir
                ? <span>[内置]</span>           // 内置：无删除按钮
                : <button onClick={remove}>删除</button>
              }
            </div>
          ))}
          <button onClick={() => setShowDirPicker(true)}>+ 添加技能目录</button>
        </div>
      )}

      {/* 已加载技能（下方） */}
      <div>
        <h3>已加载技能</h3>
        {allSkills.map(skill => {
          const disabled = disabledSkills.includes(skill.name);
          return (
            <label key={skill.name} style={disabled ? { opacity: 0.5 } : {}}>
              <input
                type="checkbox"
                checked={!disabled}
                onChange={() => toggleSkill(skill.name)}
              />
              {skill.name} — {skill.description}
              {disabled && <span>[禁用]</span>}
            </label>
          );
        })}
      </div>

      {/* 添加目录选择器 */}
      {showDirPicker && <DirTreePicker onPick={addDir} onCancel={...} />}
    </div>
  );
}
```

---

## 7. 错误处理

- **添加目录路径不存在**：kernel 校验 `existsSync(path)`，不存在返回 `ErrorEvent`，前端提示「目录不存在」
- **删除内置目录**：kernel 校验拒绝（防御性），返回 `ErrorEvent`「内置目录不可删除」
- **扫描技能时某目录读取失败**（权限等）：跳过该目录，不影响其他目录扫描，不影响整体返回
- **reload 会话失败**：catch 错误，不阻断（单个会话 reload 失败不影响其他会话和配置写入）

---

## 8. 测试策略（四层）

遵循 AGENTS.md 第 6 节。

### 第一层：单元测试（bun:test）

- settings.json 读写：`skills` 数组增删去重、`disabledSkills` 增删
- 技能去重逻辑：同名保留内置优先（构造内置+用户目录各一个同名技能，断言只保留内置的）
- 内置目录拒绝删除
- `loadSkills` 集成（mock 或真实空目录扫描，返回空数组不崩）

### 第二层：组件测试（bun:test + @testing-library/react + happy-dom）

- `SkillSection`：默认折叠态只显示内置目录；点击展开显示全部目录；内置目录无删除按钮；用户目录有删除按钮；技能 checkbox toggle；禁用技能灰显 + [禁用] 标签
- 添加目录：点击「+ 添加」弹出 DirTreePicker；选目录后调 addDir action
- 删除目录：点删除调 removeDir action

### 第三层：API 接口测试（bun:test WS 集成）

- `skill:list` 返回 skills + dirs + disabledSkills + builtinDir
- `skillDir:add` 成功写入 settings.json + reload 被调用；路径不存在返回错误
- `skillDir:remove` 成功移除；内置目录被拒
- `skill:toggle` 禁用/启用 disabledSkills 正确更新 + reload 被调用
- `skill:changed` 变更后全量推送

### 第四层：E2E（Playwright）

完整流程：
1. 打开设置 → 切到技能菜单
2. 展开目录区 → 添加技能目录（通过 WS 预置目录数据或 UI 操作）
3. 断言技能列表刷新
4. 禁用某技能 → 断言灰显 + [禁用]
5. 启用该技能 → 断言恢复
6. 删除用户目录 → 断言目录列表更新
7. 验证内置目录始终存在且无删除按钮
8. finally 清理测试数据

**截图清理**：E2E 产生的截图在所有测试完成后全部删除。

---

## 9. 开放问题 / 后续

- **AgentConfig.skills 接线**：当前 agent-manager.ts 创建 SDK session 时未读 `config.skills` 字段。全局技能启用/禁用已生效，但 agent 级别的技能子集分配尚未接线——这是独立任务，不在本次范围
- **Pi `/reload` 已知 bug**：Issue #2753 报告 `/reload` 偶尔用 stale settings。若 reload 后技能未刷新，用户需重启 kernel。后续可监控此问题
- **技能目录数量角标**：折叠态标题行目前只显示内置目录路径。后续可在标题后加 `(共 N 个目录)` 角标
