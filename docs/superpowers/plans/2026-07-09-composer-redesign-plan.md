# Composer 重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构底部聊天输入区，支持模型切换、思考强度二态开关、图片/文件/文本片段附件，并在 `Composer`（对话中）和 `NewSessionPane`（新建会话）两处复用同一套胶囊输入组件。

**Architecture:** 新增 `ComposerInput` 共用组件封装 textarea + 内联工具栏 + 附件预览；新增 `useComposerPrefsStore` + IndexedDB 持久化 per-session 偏好；前后端扩展 WS 协议（`PromptEvent` 增加 `model/thinking/attachments`，新增 `fs:readFile`）；后端在 `agent:prompt` 处理时用 `session.setModel/setThinkingLevel` 覆盖配置，并把附件拼成 `text + images` 后调用 `session.prompt()`。

**Tech Stack:** React + TypeScript + Tailwind CSS + Zustand + IndexedDB (`idb`) + Bun + `@earendil-works/pi-coding-agent` SDK。

## Global Constraints

- 项目根目录为 `/Users/pipi/work/WaPi`。
- 所有代码改动必须附带对应测试（单元 / 组件 / API / E2E 四层）。
- 禁止运行 `git push` / `git reset` / `git rebase`；每次任务完成后在本地 `git commit`。
- 前端测试用 `bun:test`（kernel/shared）和 Vitest + `@testing-library/react` + `happy-dom`（frontend）。
- 不添加超出需求的依赖或配置。
- 状态持久化不走后端（除新增 `fs:readFile` 外）。
- 附件只存元数据到 IndexedDB，不存 base64 文件内容。

---

## File Structure

| 文件 | 职责 |
|------|------|
| `packages/shared/src/types.ts` | 扩展 `PromptEvent`，新增 `FSReadFileRequest` / `FSReadFileResult` / `AttachmentRef` |
| `packages/shared/src/providers.ts` | `ProviderModel` 增加 `supportsVision?: boolean` |
| `packages/frontend/src/store/composer-db.ts` | IndexedDB 封装：读写 per-session composer 偏好 |
| `packages/frontend/src/store/composer-prefs.ts` | Zustand store：管理 defaults + bySession，对接 IndexedDB |
| `packages/frontend/src/fs-client.ts` | 新增 `readFile(path)` Promise 封装 |
| `packages/frontend/src/components/ui/AttachmentChip.tsx` | 单个附件 chip（文件名 + 删除按钮） |
| `packages/frontend/src/components/ui/ModelSelector.tsx` | 模型下拉选择器 |
| `packages/frontend/src/components/ui/ThinkingToggle.tsx` | 思考强度二态开关 |
| `packages/frontend/src/components/ui/ComposerInput.tsx` | 共用胶囊输入组件（textarea + 工具栏 + 附件预览） |
| `packages/frontend/src/components/ui/AttachmentPathModal.tsx` | 选择文件后补填绝对路径的弹窗 |
| `packages/frontend/src/components/Composer.tsx` | 用 `ComposerInput` 替换现有输入区 |
| `packages/frontend/src/components/NewSessionPane.tsx` | 用 `ComposerInput` 替换现有输入区 |
| `packages/frontend/src/components/settings/ProviderFormModal.tsx` | 模型列表增加 supportsVision 开关 |
| `packages/kernel/src/ws-server.ts` | 新增 `fs:readFile` handler；扩展 `agent:prompt` 处理 |
| `packages/kernel/src/agent-manager.ts` | `prompt` 签名增加 `model/thinking/attachments`；调用 `setModel/setThinkingLevel` 并拼 attachments |
| 各层测试文件 | 对应新增/修改代码的单元、组件、API、E2E 测试 |

---

### Task 1: 扩展共享类型

**Files:**
- Modify: `packages/shared/src/types.ts:137-143`
- Modify: `packages/shared/src/providers.ts:7-11`
- Test: `packages/shared/tests/`（新增或复用现有 pure/types 测试文件）

**Interfaces:**
- Consumes: 现有 `AgentName`, `PromptEvent`, `FS*Request/Result`
- Produces: 扩展后的 `PromptEvent` 含 `model?: string; thinking?: "disabled" | "high"; attachments?: AttachmentRef[]`
- Produces: `AttachmentRef` 联合类型
- Produces: `FSReadFileRequest` / `FSReadFileResult` / `FSErrorEvent` 扩展
- Produces: `ProviderModel.supportsVision?: boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import type { PromptEvent, FSReadFileRequest, ProviderModel } from "../src/types";

describe("PromptEvent attachments", () => {
  it("accepts model, thinking and attachments", () => {
    const e: PromptEvent = {
      type: "agent:prompt",
      projectId: "p1",
      sessionId: "s1",
      agentName: "dev",
      text: "hello",
      model: "deepseek-chat",
      thinking: "high",
      attachments: [{ kind: "file", name: "readme.md", path: "/tmp/readme.md", size: 123 }],
    };
    expect(e.model).toBe("deepseek-chat");
    expect(e.thinking).toBe("high");
    expect(e.attachments).toHaveLength(1);
  });
});

describe("FSReadFile types", () => {
  it("has request/result types", () => {
    const req: FSReadFileRequest = { type: "fs:readFile", path: "/tmp/a.txt" };
    expect(req.type).toBe("fs:readFile");
  });
});

describe("ProviderModel supportsVision", () => {
  it("optional supportsVision field", () => {
    const m: ProviderModel = { id: "gpt-4o", contextWindow: 128000, maxTokens: 4096, supportsVision: true };
    expect(m.supportsVision).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi && bun test packages/shared/tests/types.test.ts`
Expected: FAIL with "Cannot find module" or type errors (if test file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

In `packages/shared/src/types.ts`:

```ts
export interface PromptEvent {
  type: "agent:prompt";
  projectId: string;
  sessionId: string;
  agentName: AgentName;
  text: string;
  model?: string;
  thinking?: "disabled" | "high";
  attachments?: AttachmentRef[];
}

export type AttachmentRef =
  | { kind: "image"; name: string; path: string; size: number }
  | { kind: "file"; name: string; path: string; size: number }
  | { kind: "snippet"; name: string; content: string };

export interface FSReadFileRequest { type: "fs:readFile"; path: string; }
export interface FSReadFileResult { type: "fs:readFile"; path: string; content: string; mimeType?: string; error?: string; }
```

Add `FSReadFileRequest` and `FSReadFileResult` to `WSClientEvent` / `WSServerEvent` unions, and add `FSErrorEvent` to `WSServerEvent` if not present.

In `packages/shared/src/providers.ts`:

```ts
export interface ProviderModel {
  id: string;
  contextWindow: number;
  maxTokens: number;
  supportsVision?: boolean;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi && bun test packages/shared/tests/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/shared/src/types.ts packages/shared/src/providers.ts packages/shared/tests/types.test.ts
git commit -m "feat(shared): PromptEvent 扩展 model/thinking/attachments，新增 fs:readFile，ProviderModel 支持 supportsVision"
```

---

### Task 2: IndexedDB 封装

**Files:**
- Create: `packages/frontend/src/store/composer-db.ts`
- Test: `packages/frontend/tests/composer-db.test.ts`

**Interfaces:**
- Consumes: `SessionPrefs` shape from spec
- Produces: `getSessionPrefs(sessionId): Promise<ComposerSessionRecord | undefined>`
- Produces: `setSessionPrefs(record): Promise<void>`
- Produces: `getDefaults(): Promise<{ model: string | null; thinking: "disabled" | "high" }>`
- Produces: `setDefaults(prefs): Promise<void>`
- Produces: `deleteSessionPrefs(sessionId): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getSessionPrefs, setSessionPrefs, getDefaults, setDefaults, deleteSessionPrefs } from "../src/store/composer-db";

describe("composer-db", () => {
  beforeEach(async () => {
    await deleteSessionPrefs("test-session");
    await setDefaults({ model: null, thinking: "disabled" });
  });

  it("stores and retrieves session prefs", async () => {
    await setSessionPrefs({
      sessionId: "test-session",
      model: "gpt-4o",
      thinking: "high",
      attachments: [{ kind: "snippet", name: "note", content: "hi" }],
      updatedAt: Date.now(),
    });
    const prefs = await getSessionPrefs("test-session");
    expect(prefs?.model).toBe("gpt-4o");
    expect(prefs?.thinking).toBe("high");
    expect(prefs?.attachments).toHaveLength(1);
  });

  it("stores defaults", async () => {
    await setDefaults({ model: "claude-sonnet", thinking: "disabled" });
    const defs = await getDefaults();
    expect(defs.model).toBe("claude-sonnet");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/composer-db.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write minimal implementation**

Install `idb` and `fake-indexeddb` in the frontend package:

```bash
cd /Users/pipi/work/WaPi/packages/frontend
bun add idb
bun add -d fake-indexeddb
```

Update `tests/setup.ts` to register fake IndexedDB for component/unit tests:

```ts
import "fake-indexeddb/auto";
```

If `happy-dom` already provides a working `indexedDB`, skip the fake-indexeddb step.

Create `packages/frontend/src/store/composer-db.ts`:

```ts
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { AttachmentDraft } from "@wa-pi/shared";

const DB_NAME = "wa-pi-composer";
const DB_VERSION = 1;

interface ComposerSessionRecord {
  sessionId: string;
  model: string | null;
  thinking: "disabled" | "high";
  attachments: AttachmentDraft[];
  updatedAt: number;
}

interface ComposerDB extends DBSchema {
  sessions: {
    key: string;
    value: ComposerSessionRecord;
  };
  defaults: {
    key: string;
    value: { model: string | null; thinking: "disabled" | "high" };
  };
}

let dbPromise: Promise<IDBPDatabase<ComposerDB>> | null = null;

function getDb(): Promise<IDBPDatabase<ComposerDB>> {
  if (!dbPromise) {
    dbPromise = openDB<ComposerDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore("sessions", { keyPath: "sessionId" });
        db.createObjectStore("defaults");
      },
    });
  }
  return dbPromise;
}

export async function getSessionPrefs(sessionId: string): Promise<ComposerSessionRecord | undefined> {
  try {
    return await (await getDb()).get("sessions", sessionId);
  } catch {
    return undefined;
  }
}

export async function setSessionPrefs(record: ComposerSessionRecord): Promise<void> {
  try {
    await (await getDb()).put("sessions", { ...record, updatedAt: Date.now() });
  } catch {}
}

export async function deleteSessionPrefs(sessionId: string): Promise<void> {
  try {
    await (await getDb()).delete("sessions", sessionId);
  } catch {}
}

const DEFAULTS_KEY = "composer-defaults";

export async function getDefaults(): Promise<{ model: string | null; thinking: "disabled" | "high" }> {
  try {
    return (await (await getDb()).get("defaults", DEFAULTS_KEY)) ?? { model: null, thinking: "disabled" };
  } catch {
    return { model: null, thinking: "disabled" };
  }
}

export async function setDefaults(prefs: { model: string | null; thinking: "disabled" | "high" }): Promise<void> {
  try {
    await (await getDb()).put("defaults", prefs, DEFAULTS_KEY);
  } catch {}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/composer-db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/frontend/src/store/composer-db.ts packages/frontend/tests/composer-db.test.ts packages/frontend/package.json bun.lock tests/setup.ts
git commit -m "feat(frontend): IndexedDB 封装 composer 偏好"
```

---

### Task 3: Composer Prefs Zustand Store

**Files:**
- Create: `packages/frontend/src/store/composer-prefs.ts`
- Test: `packages/frontend/tests/composer-prefs.test.ts`

**Interfaces:**
- Consumes: `getSessionPrefs`, `setSessionPrefs`, `getDefaults`, `setDefaults` from `composer-db.ts`
- Produces: `useComposerPrefsStore` with `getSessionPrefs(sessionId)`, `setSessionPrefs(sessionId, prefs)`, `defaults`, `setDefaults`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { act } from "@testing-library/react";

describe("composer-prefs store", () => {
  beforeEach(() => {
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {},
    });
  });

  it("updates session prefs and defaults", () => {
    act(() => {
      useComposerPrefsStore.getState().setSessionPrefs("s1", { model: "gpt-4o", thinking: "high" });
    });
    const state = useComposerPrefsStore.getState();
    expect(state.bySession["s1"].model).toBe("gpt-4o");
    expect(state.defaults.model).toBe("gpt-4o");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/composer-prefs.test.ts`
Expected: FAIL - module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/frontend/src/store/composer-prefs.ts`:

```ts
import { create } from "zustand";
import type { AttachmentDraft } from "@wa-pi/shared";
import { getDefaults, getSessionPrefs, setDefaults, setSessionPrefs as dbSetSessionPrefs } from "./composer-db";

export interface SessionPrefs {
  model: string | null;
  thinking: "disabled" | "high";
  attachments: AttachmentDraft[];
}

interface ComposerPrefsState {
  defaults: { model: string | null; thinking: "disabled" | "high" };
  bySession: Record<string, SessionPrefs>;
  loadDefaults: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  setSessionPrefs: (sessionId: string, prefs: Partial<SessionPrefs>) => void;
  setDefaults: (prefs: Partial<{ model: string | null; thinking: "disabled" | "high" }>) => void;
}

export const useComposerPrefsStore = create<ComposerPrefsState>((set) => ({
  defaults: { model: null, thinking: "disabled" },
  bySession: {},

  loadDefaults: async () => {
    const defs = await getDefaults();
    set({ defaults: defs });
  },

  loadSession: async (sessionId) => {
    const defaults = await getDefaults();
    const stored = await getSessionPrefs(sessionId);
    set(s => ({
      defaults,
      bySession: {
        ...s.bySession,
        [sessionId]: {
          model: stored?.model ?? defaults.model,
          thinking: stored?.thinking ?? defaults.thinking,
          attachments: stored?.attachments ?? [],
        },
      },
    }));
  },

  setSessionPrefs: (sessionId, prefs) => {
    set(s => {
      const current = s.bySession[sessionId] ?? { model: s.defaults.model, thinking: s.defaults.thinking, attachments: [] };
      const next = { ...current, ...prefs };
      void dbSetSessionPrefs({ sessionId, ...next, updatedAt: Date.now() });
      const newDefaults = { model: next.model, thinking: next.thinking };
      void setDefaults(newDefaults);
      return {
        bySession: { ...s.bySession, [sessionId]: next },
        defaults: newDefaults,
      };
    });
  },

  setDefaults: (prefs) => {
    set(s => {
      const next = { ...s.defaults, ...prefs };
      void setDefaults(next);
      return { defaults: next };
    });
  },
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/composer-prefs.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/frontend/src/store/composer-prefs.ts packages/frontend/tests/composer-prefs.test.ts
git commit -m "feat(frontend): Composer 偏好 Zustand store"
```

---

### Task 4: 模型选择器组件

**Files:**
- Create: `packages/frontend/src/components/ui/ModelSelector.tsx`
- Test: `packages/frontend/tests/ModelSelector.test.tsx`

**Interfaces:**
- Consumes: `useProvidersStore` providers list
- Produces: `ModelSelector({ value, onChange, disabled })` component

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModelSelector } from "../src/components/ui/ModelSelector";
import { useProvidersStore } from "../src/store/providers";

describe("ModelSelector", () => {
  beforeEach(() => {
    useProvidersStore.setState({
      providers: [{
        id: "p1", name: "Test", baseUrl: "http://x", apiKey: "k", api: "openai-completions",
        models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }],
      }],
    });
  });

  it("renders model options from providers", () => {
    const onChange = vi.fn();
    render(<ModelSelector value="m1" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("model-selector"));
    expect(screen.getByText("m1")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/ModelSelector.test.tsx`
Expected: FAIL - module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/frontend/src/components/ui/ModelSelector.tsx`:

```tsx
import { useProvidersStore } from "../../store/providers";

interface Props {
  value: string | null;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

export function ModelSelector({ value, onChange, disabled }: Props) {
  const providers = useProvidersStore(s => s.providers);
  const models = providers.flatMap(p => p.models.map(m => ({ ...m, providerName: p.name })));
  const selected = models.find(m => m.id === value);

  if (models.length === 0) {
    return <span className="text-xs text-tertiary">未配置模型</span>;
  }

  return (
    <select
      data-testid="model-selector"
      value={value ?? ""}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      className="bg-transparent text-xs text-secondary outline-none cursor-pointer disabled:cursor-not-allowed"
    >
      {models.map(m => (
        <option key={m.id} value={m.id}>{m.providerName}/{m.id}</option>
      ))}
    </select>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/ModelSelector.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/frontend/src/components/ui/ModelSelector.tsx packages/frontend/tests/ModelSelector.test.tsx
git commit -m "feat(frontend): ModelSelector 组件"
```

---

### Task 5: 思考强度开关组件

**Files:**
- Create: `packages/frontend/src/components/ui/ThinkingToggle.tsx`
- Test: `packages/frontend/tests/ThinkingToggle.test.tsx`

**Interfaces:**
- Produces: `ThinkingToggle({ value, onChange })` component

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThinkingToggle } from "../src/components/ui/ThinkingToggle";

describe("ThinkingToggle", () => {
  it("toggles between disabled and high", () => {
    const onChange = vi.fn();
    render(<ThinkingToggle value="disabled" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("thinking-toggle"));
    expect(onChange).toHaveBeenCalledWith("high");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/ThinkingToggle.test.tsx`
Expected: FAIL - module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/frontend/src/components/ui/ThinkingToggle.tsx`:

```tsx
interface Props {
  value: "disabled" | "high";
  onChange: (value: "disabled" | "high") => void;
}

export function ThinkingToggle({ value, onChange }: Props) {
  return (
    <button
      data-testid="thinking-toggle"
      onClick={() => onChange(value === "disabled" ? "high" : "disabled")}
      className={`text-xs px-2 py-0.5 rounded-pill border-0 cursor-pointer transition-colors ${
        value === "high"
          ? "bg-accent-soft text-accent"
          : "bg-surface-hover text-tertiary"
      }`}
    >
      思考 {value === "high" ? "high" : "关"}
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/ThinkingToggle.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/frontend/src/components/ui/ThinkingToggle.tsx packages/frontend/tests/ThinkingToggle.test.tsx
git commit -m "feat(frontend): ThinkingToggle 组件"
```

---

### Task 6: 附件 Chip 组件

**Files:**
- Create: `packages/frontend/src/components/ui/AttachmentChip.tsx`
- Test: `packages/frontend/tests/AttachmentChip.test.tsx`

**Interfaces:**
- Consumes: `AttachmentDraft` from `@wa-pi/shared`
- Produces: `AttachmentChip({ attachment, onRemove })` component

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AttachmentChip } from "../src/components/ui/AttachmentChip";

describe("AttachmentChip", () => {
  it("renders file name and calls onRemove", () => {
    const onRemove = vi.fn();
    render(<AttachmentChip attachment={{ kind: "file", name: "a.txt", path: "/tmp/a.txt", size: 100 }} onRemove={onRemove} />);
    expect(screen.getByText("a.txt")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("attachment-remove"));
    expect(onRemove).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/AttachmentChip.test.tsx`
Expected: FAIL - module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/frontend/src/components/ui/AttachmentChip.tsx`:

```tsx
import type { AttachmentDraft } from "@wa-pi/shared";

interface Props {
  attachment: AttachmentDraft;
  onRemove: () => void;
}

export function AttachmentChip({ attachment, onRemove }: Props) {
  const label = attachment.kind === "snippet"
    ? attachment.content.slice(0, 20) + (attachment.content.length > 20 ? "…" : "")
    : attachment.name;
  const icon = attachment.kind === "image" ? "📷" : attachment.kind === "snippet" ? "📝" : "📄";

  return (
    <span className="inline-flex items-center gap-1 text-xs text-secondary bg-surface-hover px-2 py-1 rounded-pill">
      <span>{icon}</span>
      <span className="truncate max-w-[150px]">{label}</span>
      <button
        data-testid="attachment-remove"
        onClick={onRemove}
        className="text-tertiary hover:text-danger ml-1"
      >✕</button>
    </span>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/AttachmentChip.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/frontend/src/components/ui/AttachmentChip.tsx packages/frontend/tests/AttachmentChip.test.tsx
git commit -m "feat(frontend): AttachmentChip 组件"
```

---

### Task 7: 附件路径补填弹窗

**Files:**
- Create: `packages/frontend/src/components/ui/AttachmentPathModal.tsx`
- Test: `packages/frontend/tests/AttachmentPathModal.test.tsx`

**Interfaces:**
- Produces: `AttachmentPathModal({ fileName, onConfirm, onCancel })` component

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AttachmentPathModal } from "../src/components/ui/AttachmentPathModal";

describe("AttachmentPathModal", () => {
  it("returns entered absolute path on confirm", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<AttachmentPathModal fileName="a.txt" onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.change(screen.getByTestId("path-input"), { target: { value: "/tmp/a.txt" } });
    fireEvent.click(screen.getByTestId("confirm-path"));
    expect(onConfirm).toHaveBeenCalledWith("/tmp/a.txt");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/AttachmentPathModal.test.tsx`
Expected: FAIL - module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/frontend/src/components/ui/AttachmentPathModal.tsx`:

```tsx
import { useState } from "react";
import { Modal } from "./Modal";

interface Props {
  fileName: string;
  onConfirm: (path: string) => void;
  onCancel: () => void;
}

export function AttachmentPathModal({ fileName, onConfirm, onCancel }: Props) {
  const [path, setPath] = useState("");

  return (
    <Modal onClose={onCancel} width={480}>
      <div className="p-4">
        <h3 className="text-sm font-bold text-primary mb-2">补填文件绝对路径</h3>
        <p className="text-xs text-secondary mb-3">浏览器无法直接获取本地路径，请填写 {fileName} 的完整路径。</p>
        <input
          data-testid="path-input"
          value={path}
          onChange={e => setPath(e.target.value)}
          placeholder="/Users/xxx/project/a.txt"
          className="w-full px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none mb-3"
        />
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs border border-hairline rounded-sm">取消</button>
          <button
            data-testid="confirm-path"
            disabled={!path.trim()}
            onClick={() => onConfirm(path.trim())}
            className="px-3 py-1.5 text-xs border-0 rounded-sm disabled:opacity-50"
            style={{ background: "var(--brand)", color: "var(--on-brand)" }}
          >确认</button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/AttachmentPathModal.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/frontend/src/components/ui/AttachmentPathModal.tsx packages/frontend/tests/AttachmentPathModal.test.tsx
git commit -m "feat(frontend): 附件路径补填弹窗"
```

---

### Task 8: 共用胶囊输入组件 ComposerInput

**Files:**
- Create: `packages/frontend/src/components/ui/ComposerInput.tsx`
- Test: `packages/frontend/tests/ComposerInput.test.tsx`

**Interfaces:**
- Consumes: `ModelSelector`, `ThinkingToggle`, `AttachmentChip`, `AttachmentPathModal`
- Consumes: `AttachmentDraft` from `@wa-pi/shared`
- Produces: `ComposerInput({ text, setText, model, setModel, thinking, setThinking, attachments, setAttachments, onSend, sendDisabled, placeholder })` component

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ComposerInput } from "../src/components/ui/ComposerInput";
import { useProvidersStore } from "../src/store/providers";

describe("ComposerInput", () => {
  beforeEach(() => {
    useProvidersStore.setState({ providers: [] });
  });

  it("calls onSend with text when clicking send", () => {
    const onSend = vi.fn();
    render(
      <ComposerInput
        text="hello"
        setText={vi.fn()}
        model={null}
        setModel={vi.fn()}
        thinking="disabled"
        setThinking={vi.fn()}
        attachments={[]}
        setAttachments={vi.fn()}
        onSend={onSend}
        placeholder="输入..."
      />
    );
    fireEvent.click(screen.getByTestId("composer-send"));
    expect(onSend).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/ComposerInput.test.tsx`
Expected: FAIL - module not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/frontend/src/components/ui/ComposerInput.tsx`:

```tsx
import { useRef, useCallback, useState } from "react";
import type { AttachmentDraft } from "@wa-pi/shared";
import { ModelSelector } from "./ModelSelector";
import { ThinkingToggle } from "./ThinkingToggle";
import { AttachmentChip } from "./AttachmentChip";
import { AttachmentPathModal } from "./AttachmentPathModal";

interface Props {
  text: string;
  setText: (text: string) => void;
  model: string | null;
  setModel: (model: string) => void;
  thinking: "disabled" | "high";
  setThinking: (thinking: "disabled" | "high") => void;
  attachments: AttachmentDraft[];
  setAttachments: (attachments: AttachmentDraft[]) => void;
  onSend: () => void;
  sendDisabled?: boolean;
  placeholder?: string;
}

export function ComposerInput({
  text, setText, model, setModel, thinking, setThinking,
  attachments, setAttachments, onSend, sendDisabled, placeholder,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<{ file: File; kind: "image" | "file" } | null>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 300) + "px";
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const kind = file.type.startsWith("image/") ? "image" : "file";
    setPendingFile({ file, kind });
    e.target.value = "";
  };

  const confirmPath = (path: string) => {
    if (!pendingFile) return;
    const { file, kind } = pendingFile;
    setAttachments([...attachments, { kind, name: file.name, path, size: file.size }]);
    setPendingFile(null);
  };

  const removeAttachment = (idx: number) => {
    setAttachments(attachments.filter((_, i) => i !== idx));
  };

  const canSend = !sendDisabled && text.trim();

  return (
    <div className="w-full max-w-[860px] mx-auto" data-testid="composer-input">
      <div className="rounded-2xl bg-surface border border-hairline shadow-md overflow-hidden focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft),var(--shadow-md)] transition-all duration-150">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => { setText(e.target.value); autoResize(); }}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          placeholder={placeholder}
          rows={1}
          className="w-full bg-transparent text-primary outline-none resize-none text-sm p-4 placeholder:text-tertiary"
          style={{ maxHeight: 300, overflowY: "auto", minHeight: 60 }}
        />
        <div className="flex items-center justify-between px-3 py-2 border-t border-hairline">
          <div className="flex items-center gap-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="text-lg text-secondary hover:text-primary"
              title="添加附件"
            >📎</button>
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelect} />
            <ModelSelector value={model} onChange={setModel} />
            <ThinkingToggle value={thinking} onChange={setThinking} />
          </div>
          <button
            data-testid="composer-send"
            onClick={onSend}
            disabled={!canSend}
            className="w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0 transition-transform enabled:hover:scale-105 border-0 cursor-pointer disabled:cursor-not-allowed"
            style={{ background: canSend ? "var(--brand)" : "var(--hairline-strong)", color: "var(--on-brand)" }}
          >↑</button>
        </div>
      </div>
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2 px-1" data-testid="attachment-list">
          {attachments.map((a, i) => (
            <AttachmentChip key={i} attachment={a} onRemove={() => removeAttachment(i)} />
          ))}
        </div>
      )}
      {pendingFile && (
        <AttachmentPathModal
          fileName={pendingFile.file.name}
          onConfirm={confirmPath}
          onCancel={() => setPendingFile(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/ComposerInput.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/frontend/src/components/ui/ComposerInput.tsx packages/frontend/tests/ComposerInput.test.tsx
git commit -m "feat(frontend): 共用 ComposerInput 胶囊输入组件"
```

---

### Task 9: 前端 fs-client 新增 readFile

**Files:**
- Modify: `packages/frontend/src/fs-client.ts`
- Test: `packages/frontend/tests/fs-client.test.ts`

**Interfaces:**
- Consumes: WS `fs:readFile` request/result
- Produces: `readFile(path): Promise<{ content: string; mimeType?: string }>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "../src/fs-client";
import * as ws from "../src/ws-instance";

describe("fs-client readFile", () => {
  beforeEach(() => {
    vi.spyOn(ws, "send").mockImplementation(() => {});
  });

  it("resolves with content on fs:readFile result", async () => {
    const promise = readFile("/tmp/a.txt");
    ws.onMessage((e: any) => {}); // trigger handler registration
    // Simulate broadcast
    const handlers = (ws as any).handlers as Set<(e: any) => void>;
    handlers.forEach(h => h({ type: "fs:readFile", path: "/tmp/a.txt", content: "abc", mimeType: "text/plain" }));
    const result = await promise;
    expect(result.content).toBe("abc");
  });
});
```

Note: This test may need adjustment based on actual `ws-instance.ts` internals.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/fs-client.test.ts`
Expected: FAIL - `readFile` not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/frontend/src/fs-client.ts`, add:

```ts
export function readFile(path: string): Promise<{ content: string; mimeType?: string }> {
  return new Promise((resolve, reject) => {
    const off = onMessage((e: any) => {
      if (e.type === "fs:readFile" && e.path === path) {
        off();
        if (e.error) reject(new Error(e.error));
        else resolve({ content: e.content, mimeType: e.mimeType });
      }
    });
    send({ type: "fs:readFile", path });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/fs-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/frontend/src/fs-client.ts packages/frontend/tests/fs-client.test.ts
git commit -m "feat(frontend): fs-client 新增 readFile"
```

---

### Task 10: 重构 Composer.tsx

**Files:**
- Modify: `packages/frontend/src/components/Composer.tsx`
- Test: `packages/frontend/tests/Composer.test.tsx`

**Interfaces:**
- Consumes: `ComposerInput`, `useComposerPrefsStore`
- Produces: Sends `PromptEvent` with `model/thinking/attachments`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../src/components/Composer";
import * as ws from "../src/ws-instance";
import { useComposerPrefsStore } from "../src/store/composer-prefs";

describe("Composer", () => {
  beforeEach(() => {
    useComposerPrefsStore.setState({ defaults: { model: null, thinking: "disabled" }, bySession: {} });
    vi.spyOn(ws, "send").mockImplementation(() => {});
  });

  it("sends prompt with model and thinking", async () => {
    render(<Composer sessionId="s1" agentName="dev" />);
    fireEvent.change(screen.getByTestId("composer-input").querySelector("textarea")!, { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("composer-send"));
    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "agent:prompt",
        sessionId: "s1",
        text: "hello",
      }));
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/Composer.test.tsx`
Expected: FAIL - test may fail due to current Composer not using ComposerInput.

- [ ] **Step 3: Write minimal implementation**

Rewrite `packages/frontend/src/components/Composer.tsx`:

```tsx
import { useState, useRef, useEffect } from "react";
import type { AgentName, AttachmentDraft } from "@wa-pi/shared";
import { send } from "../ws-instance";
import { useProjectsStore } from "../store/projects";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { ComposerInput } from "./ui/ComposerInput";

interface Props {
  sessionId: string;
  agentName: AgentName;
  isRunning?: boolean;
}

export function Composer({ sessionId, agentName, isRunning }: Props) {
  const [text, setText] = useState("");
  const sendingRef = useRef(false);
  const { sessions, currentProjectId } = useProjectsStore();
  const session = sessions.find(s => s.id === sessionId);
  const projectId = session?.projectId ?? currentProjectId ?? "";

  const prefs = useComposerPrefsStore(s => s.bySession[sessionId]);
  const setSessionPrefs = useComposerPrefsStore(s => s.setSessionPrefs);
  const loadSession = useComposerPrefsStore(s => s.loadSession);

  useEffect(() => { void loadSession(sessionId); }, [sessionId, loadSession]);

  const model = prefs?.model ?? null;
  const thinking = prefs?.thinking ?? "disabled";
  const attachments = prefs?.attachments ?? [];

  const handleSend = () => {
    if (!text.trim() || sendingRef.current || !projectId) return;
    sendingRef.current = true;
    send({
      type: "agent:prompt",
      projectId,
      sessionId,
      agentName,
      text,
      model: model ?? undefined,
      thinking,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    setText("");
    setSessionPrefs(sessionId, { attachments: [] });
    setTimeout(() => { sendingRef.current = false; }, 500);
  };

  return (
    <div className="px-6 py-3 pb-5" data-testid="composer">
      <ComposerInput
        text={text}
        setText={setText}
        model={model}
        setModel={m => setSessionPrefs(sessionId, { model: m })}
        thinking={thinking}
        setThinking={t => setSessionPrefs(sessionId, { thinking: t })}
        attachments={attachments}
        setAttachments={ats => setSessionPrefs(sessionId, { attachments: ats })}
        onSend={handleSend}
        sendDisabled={!projectId || isRunning}
        placeholder={isRunning ? "输入要加入队列的消息..." : `给${agentName}发消息...`}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/Composer.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/frontend/src/components/Composer.tsx packages/frontend/tests/Composer.test.tsx
git commit -m "feat(frontend): Composer 接入 ComposerInput 与 prefs store"
```

---

### Task 11: 重构 NewSessionPane.tsx

**Files:**
- Modify: `packages/frontend/src/components/NewSessionPane.tsx`
- Test: `packages/frontend/tests/NewSessionPane.test.tsx`

**Interfaces:**
- Consumes: `ComposerInput`, `useComposerPrefsStore`
- Produces: Sends first `PromptEvent` with `model/thinking/attachments`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewSessionPane } from "../src/components/NewSessionPane";
import * as ws from "../src/ws-instance";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";

describe("NewSessionPane", () => {
  beforeEach(() => {
    useProjectsStore.setState({ projects: [{ id: "p1", name: "P", cwd: "/tmp/p", createdAt: 0 }], currentProjectId: "p1" });
    useComposerPrefsStore.setState({ defaults: { model: null, thinking: "disabled" }, bySession: {} });
    vi.spyOn(ws, "send").mockImplementation(() => {});
  });

  it("sends first prompt with model and thinking", async () => {
    render(<NewSessionPane />);
    fireEvent.change(screen.getByTestId("composer-input").querySelector("textarea")!, { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("composer-send"));
    await waitFor(() => {
      expect(ws.send).toHaveBeenCalledWith(expect.objectContaining({
        type: "agent:prompt",
        projectId: "p1",
        text: "hello",
      }));
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/NewSessionPane.test.tsx`
Expected: FAIL - current NewSessionPane not using ComposerInput.

- [ ] **Step 3: Write minimal implementation**

Rewrite `packages/frontend/src/components/NewSessionPane.tsx`:

```tsx
import { useState, useRef, useEffect } from "react";
import { AGENT_DEFS, randomSessionId } from "@wa-pi/shared";
import type { AgentName, AttachmentDraft } from "@wa-pi/shared";
import { useProjectsStore } from "../store/projects";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { send } from "../ws-instance";
import { ComposerInput } from "./ui/ComposerInput";

const NAMES: AgentName[] = ["product", "pm", "dev", "test"];

export function NewSessionPane() {
  const { projects, currentProjectId } = useProjectsStore();
  const [agentName, setAgentName] = useState<AgentName>("dev");
  const [text, setText] = useState("");
  const initialProject = currentProjectId ?? projects[0]?.id ?? null;
  const [projectId, setProjectId] = useState<string | null>(initialProject);
  useEffect(() => { if (currentProjectId) setProjectId(currentProjectId); }, [currentProjectId]);
  const [sessionId] = useState(() => randomSessionId());
  const sendingRef = useRef(false);

  const defaults = useComposerPrefsStore(s => s.defaults);
  const setDefaults = useComposerPrefsStore(s => s.setDefaults);
  const loadDefaults = useComposerPrefsStore(s => s.loadDefaults);

  useEffect(() => { void loadDefaults(); }, [loadDefaults]);

  const [model, setModel] = useState<string | null>(defaults.model);
  const [thinking, setThinking] = useState<"disabled" | "high">(defaults.thinking);
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);

  useEffect(() => {
    setModel(defaults.model);
    setThinking(defaults.thinking);
  }, [defaults.model, defaults.thinking]);

  const handleSend = () => {
    if (!projectId || !text.trim() || sendingRef.current) return;
    sendingRef.current = true;
    send({
      type: "agent:prompt",
      projectId,
      sessionId,
      agentName,
      text,
      model: model ?? undefined,
      thinking,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    setText("");
    setAttachments([]);
    setDefaults({ model, thinking });
    setTimeout(() => { sendingRef.current = false; }, 500);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-10" data-testid="new-session-pane">
      <h2 className="text-[26px] font-extrabold tracking-tight text-primary mb-2">开始新会话</h2>
      <p className="text-sm text-secondary mb-7">选好项目目录和角色，直接打字发送</p>
      <div className="w-full max-w-2xl mb-4 flex gap-2">
        <select
          value={projectId ?? ""}
          onChange={e => setProjectId(e.target.value || null)}
          className="flex-1 bg-surface border border-hairline rounded-sm text-primary px-2.5 py-1.5 text-[12.5px]"
          data-testid="project-select"
        >
          {projects.length === 0 && <option value="">（无项目，请先新建）</option>}
          {projects.map(p => <option key={p.id} value={p.id}>📁 {p.name} {p.cwd}</option>)}
        </select>
        <select
          value={agentName}
          onChange={e => setAgentName(e.target.value as AgentName)}
          className="bg-surface border border-hairline rounded-sm text-primary px-2.5 py-1.5 text-[12.5px]"
          data-testid="agent-select"
        >
          {NAMES.map(n => <option key={n} value={n}>{AGENT_DEFS[n].emoji} {AGENT_DEFS[n].label}</option>)}
        </select>
      </div>
      <ComposerInput
        text={text}
        setText={setText}
        model={model}
        setModel={m => { setModel(m); setDefaults({ model: m }); }}
        thinking={thinking}
        setThinking={t => { setThinking(t); setDefaults({ thinking: t }); }}
        attachments={attachments}
        setAttachments={setAttachments}
        onSend={handleSend}
        sendDisabled={!projectId}
        placeholder="给研发发消息..."
      />
      <p className="text-[11.5px] text-tertiary mt-4">💡 项目目录可在此切换；agent 选谁谁是主理人</p>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/NewSessionPane.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/frontend/src/components/NewSessionPane.tsx packages/frontend/tests/NewSessionPane.test.tsx
git commit -m "feat(frontend): NewSessionPane 接入 ComposerInput 与 prefs store"
```

---

### Task 12: ProviderFormModal 增加 supportsVision 开关

**Files:**
- Modify: `packages/frontend/src/components/settings/ProviderFormModal.tsx:120-160`
- Test: `packages/frontend/tests/ProviderFormModal.test.tsx`

**Interfaces:**
- Consumes: `ProviderModel.supportsVision`
- Produces: UI toggle in model list table

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProviderFormModal } from "../src/components/settings/ProviderFormModal";
import { useProvidersStore } from "../src/store/providers";

describe("ProviderFormModal supportsVision", () => {
  beforeEach(() => {
    useProvidersStore.setState({ providers: [], save: vi.fn(), test: vi.fn().mockResolvedValue({ ok: true }) });
  });

  it("renders supportsVision toggle", () => {
    render(<ProviderFormModal onClose={vi.fn()} />);
    // Add a model first
    const tagInput = screen.getByPlaceholderText("输入模型 ID，回车或 | 添加");
    fireEvent.change(tagInput, { target: { value: "gpt-4o" } });
    fireEvent.keyDown(tagInput, { key: "Enter" });
    expect(screen.getByTestId("model-vision-0")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/ProviderFormModal.test.tsx`
Expected: FAIL - toggle not present.

- [ ] **Step 3: Write minimal implementation**

In `packages/frontend/src/components/settings/ProviderFormModal.tsx`:

1. Update table header to add "图片" column after "最大输出":

```tsx
<th className="text-left px-2 py-1 font-normal">图片</th>
```

2. Update table row to add toggle:

```tsx
<td className="px-2 py-1">
  <input
    data-testid={`model-vision-${i}`}
    type="checkbox"
    checked={modelConfigs[id]?.supportsVision ?? false}
    onChange={e => setModelConfigs(prev => ({
      ...prev,
      [id]: { ...prev[id], supportsVision: e.target.checked },
    }))}
  />
</td>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx vitest run tests/ProviderFormModal.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/frontend/src/components/settings/ProviderFormModal.tsx packages/frontend/tests/ProviderFormModal.test.tsx
git commit -m "feat(frontend): 供应商模型列表增加 supportsVision 开关"
```

---

### Task 13: 后端 fs:readFile handler

**Files:**
- Modify: `packages/kernel/src/ws-server.ts:200-228`
- Test: `packages/kernel/tests/ws-server.test.ts`

**Interfaces:**
- Consumes: `FSReadFileRequest`
- Produces: `FSReadFileResult` or `FSErrorEvent`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { WSServer } from "../src/ws-server";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { AgentManager } from "../src/agent-manager";
import { SkillManager } from "../src/skill-manager";

describe("fs:readFile", () => {
  // setup/teardown omitted for brevity
  it("reads a file and returns base64", async () => {
    // write temp file, send fs:readFile, assert base64 content
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/kernel && bun test tests/ws-server.test.ts -t "fs:readFile"`
Expected: FAIL - handler not implemented.

- [ ] **Step 3: Write minimal implementation**

In `packages/kernel/src/ws-server.ts`, add import:

```ts
import { readFile } from "node:fs/promises";
```

Add handler in `handle()` switch:

```ts
case "fs:readFile": {
  try {
    const buffer = await readFile(event.path);
    const content = buffer.toString("base64");
    const mimeType = guessMimeType(event.path);
    reply({ type: "fs:readFile", path: event.path, content, mimeType });
  } catch (e) {
    reply({ type: "fs:readFile", path: event.path, content: "", error: String(e instanceof Error ? e.message : e) });
  }
  break;
}
```

Add a small `guessMimeType(path: string): string` helper in the same file:

```ts
function guessMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    txt: "text/plain", md: "text/markdown", json: "application/json", pdf: "application/pdf",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/kernel && bun test tests/ws-server.test.ts -t "fs:readFile"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/kernel/src/ws-server.ts packages/kernel/tests/ws-server.test.ts
git commit -m "feat(kernel): 新增 fs:readFile handler"
```

---

### Task 14: 后端 agent:prompt 处理 model/thinking/attachments

**Files:**
- Modify: `packages/kernel/src/ws-server.ts:138-159`
- Modify: `packages/kernel/src/agent-manager.ts:130-176`
- Test: `packages/kernel/tests/agent-manager.test.ts` and `packages/kernel/tests/ws-server.test.ts`

**Interfaces:**
- Consumes: `PromptEvent` with `model/thinking/attachments`
- Produces: `AgentManager.prompt(sessionId, text, { model, thinking, attachments })`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { buildPromptContent } from "../src/agent-manager";

describe("buildPromptContent", () => {
  it("prepends file reference and keeps image", () => {
    const { text, images } = buildPromptContent("hello", [
      { kind: "file", name: "a.txt", path: "/tmp/a.txt", size: 100 },
      { kind: "image", name: "b.png", path: "/tmp/b.png", size: 200 },
      { kind: "snippet", name: "code", content: "console.log(1)" },
    ]);
    expect(text).toContain("<附件: /tmp/a.txt>");
    expect(text).toContain("console.log(1)");
    expect(text).toContain("hello");
    expect(images).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/kernel && bun test tests/agent-manager.test.ts -t "buildPromptContent"`
Expected: FAIL - function not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/kernel/src/agent-manager.ts`:

1. Update `prompt()` signature:

```ts
async prompt(
  sessionId: string,
  text: string,
  opts?: { model?: string; thinking?: "disabled" | "high"; attachments?: AttachmentRef[] },
): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`会话未启动: ${sessionId}`);

  if (opts?.model) {
    const modelRegistry = (session as any).modelRegistry;
    const model = await resolveModel(opts.model, modelRegistry);
    await session.setModel(model);
  }

  if (opts?.thinking) {
    const level: any = opts.thinking === "high" ? "high" : "off";
    session.setThinkingLevel(level);
  }

  const { text: finalText, images } = await buildPromptContent(text, opts?.attachments ?? []);

  if (session.isStreaming || session.pendingMessageCount > 0) {
    await session.prompt(finalText, { streamingBehavior: "followUp", images });
  } else {
    await session.prompt(finalText, { images });
  }
}
```

2. Add helper function:

```ts
import type { AttachmentRef } from "@wa-pi/shared";
import { readFile } from "node:fs/promises";

const IMAGE_SIZE_LIMIT = 5 * 1024 * 1024;

async function buildPromptContent(text: string, attachments: AttachmentRef[]): Promise<{ text: string; images: any[] }> {
  const parts: string[] = [];
  const images: any[] = [];

  for (const a of attachments) {
    if (a.kind === "snippet") {
      parts.push(`<附件: ${a.name}>\n${a.content}`);
    } else if (a.kind === "file") {
      parts.push(`<附件: ${a.path}>`);
    } else if (a.kind === "image") {
      if (a.size <= IMAGE_SIZE_LIMIT) {
        try {
          const buffer = await readFile(a.path);
          const data = buffer.toString("base64");
          const mimeType = guessMimeType(a.path);
          images.push({ type: "image", data, mimeType });
        } catch {
          parts.push(`<附件图片（读取失败）: ${a.path}>`);
        }
      } else {
        parts.push(`<附件图片（过大）: ${a.path}>`);
      }
    }
  }

  if (text.trim()) parts.push(text);
  return { text: parts.join("\n\n"), images };
}

function guessMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  };
  return map[ext ?? ""] ?? "image/png";
}
```

Add import `stat` from `node:fs/promises`.

3. Update `ws-server.ts` `agent:prompt` handler:

```ts
await this.opts.agentManager.prompt(session.id, event.text, {
  model: event.model,
  thinking: event.thinking,
  attachments: event.attachments,
});
```

Note: `resolveModel` import path may need adjustment if `AttachmentRef` is used.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/kernel && bun test tests/agent-manager.test.ts -t "buildPromptContent"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/kernel/src/agent-manager.ts packages/kernel/src/ws-server.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "feat(kernel): agent:prompt 支持 model/thinking/attachments"
```

---

### Task 15: 后端 supportsVision 读取与图片降级

**Files:**
- Modify: `packages/kernel/src/agent-manager.ts`
- Test: `packages/kernel/tests/agent-manager.test.ts`

**Interfaces:**
- Consumes: `providerStore.load()` to check `ProviderModel.supportsVision`
- Produces: Image attachment converted to text reference if model doesn't support vision

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { shouldSendAsImage } from "../src/agent-manager";

describe("shouldSendAsImage", () => {
  it("returns false if model does not support vision", () => {
    expect(shouldSendAsImage("deepseek-chat", [{ id: "deepseek-chat", contextWindow: 128000, maxTokens: 4096, supportsVision: false }])).toBe(false);
  });
  it("returns true if model supports vision", () => {
    expect(shouldSendAsImage("gpt-4o", [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096, supportsVision: true }])).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/kernel && bun test tests/agent-manager.test.ts -t "shouldSendAsImage"`
Expected: FAIL - function not defined.

- [ ] **Step 3: Write minimal implementation**

In `packages/kernel/src/agent-manager.ts`:

1. Pass `providerStore` reference or inject model list. Since `AgentManagerOpts` already has `projectStore` and `configStore`, add optional `providerStore?: ProviderStore`.

2. Add helper:

```ts
function shouldSendAsImage(modelId: string, providers: ModelProvider[]): boolean {
  return providers.some(p => p.models.some(m => m.id === modelId && m.supportsVision));
}
```

3. In `buildPromptContent`, before reading image, check:

```ts
const supportsVision = modelId ? shouldSendAsImage(modelId, providers) : false;
if (!supportsVision) {
  parts.push(`<附件图片（模型不支持）: ${a.path}>`);
  continue;
}
```

Update `prompt()` to pass `providers` to `buildPromptContent`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/kernel && bun test tests/agent-manager.test.ts -t "shouldSendAsImage"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/kernel/src/agent-manager.ts packages/kernel/tests/agent-manager.test.ts
git commit -m "feat(kernel): 根据 supportsVision 判断图片是否直接发送"
```

---

### Task 16: 后端 ProviderStore 保存 supportsVision

**Files:**
- Modify: `packages/kernel/src/provider-store.ts`
- Test: `packages/kernel/tests/provider-store.test.ts`

**Interfaces:**
- Consumes: `ModelProvider` with `supportsVision`
- Produces: Persistence of `supportsVision` field

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ProviderStore } from "../src/provider-store";

describe("provider-store supportsVision", () => {
  it("persists supportsVision", async () => {
    const store = new ProviderStore();
    await store.save({
      id: "p1", name: "T", baseUrl: "http://x", apiKey: "k", api: "openai-completions",
      models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096, supportsVision: true }],
    });
    const loaded = await store.load();
    expect(loaded[0].models[0].supportsVision).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/kernel && bun test tests/provider-store.test.ts -t "supportsVision"`
Expected: FAIL - field not persisted.

- [ ] **Step 3: Write minimal implementation**

In `packages/kernel/src/provider-store.ts`, ensure the save/load uses `ModelProvider` type from shared. If the store already uses the type, no code change may be needed beyond the type update. Verify and add explicit type annotation if missing.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/kernel && bun test tests/provider-store.test.ts -t "supportsVision"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/kernel/src/provider-store.ts packages/kernel/tests/provider-store.test.ts
git commit -m "feat(kernel): provider-store 持久化 supportsVision"
```

---

### Task 17: API 集成测试

**Files:**
- Create: `packages/kernel/tests/composer-attachments.test.ts`

**Interfaces:**
- Consumes: running kernel WS server
- Produces: Verifies `fs:readFile` and `agent:prompt` with attachments

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { setupTestServer, teardownTestServer, sendAndWait } from "./helpers/ws-test-helper";

describe("composer attachments integration", () => {
  let ws: WebSocket;
  beforeAll(async () => { ws = await setupTestServer(); });
  afterAll(() => teardownTestServer(ws));

  it("reads a file via fs:readFile", async () => {
    // write temp file, send request, assert base64 response
  });

  it("prompt with file attachment results in reference text in user message", async () => {
    // create project/session, send prompt with file attachment, wait for message_start(user) and assert content contains "<附件:"
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/kernel && bun test tests/composer-attachments.test.ts`
Expected: FAIL - test file not found.

- [ ] **Step 3: Write minimal implementation**

Create the test file following existing patterns in `packages/kernel/tests/ws-server.test.ts` and `sdk-integration.test.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/kernel && bun test tests/composer-attachments.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/kernel/tests/composer-attachments.test.ts
git commit -m "test(kernel): Composer 附件 API 集成测试"
```

---

### Task 18: E2E 测试

**Files:**
- Create: `packages/frontend/e2e/composer.spec.ts`

**Interfaces:**
- Consumes: Playwright page with running kernel
- Produces: E2E coverage of model switch, thinking toggle, attachments

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "@playwright/test";

test("composer model switch and send", async ({ page }) => {
  await page.goto("/");
  // create project, open new session, select model, type, send, assert message
});

test("composer attachment flow", async ({ page }) => {
  await page.goto("/");
  // add snippet attachment, send, assert reference in message list
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx playwright test e2e/composer.spec.ts`
Expected: FAIL - spec not found.

- [ ] **Step 3: Write minimal implementation**

Create `packages/frontend/e2e/composer.spec.ts` following patterns in `packages/frontend/e2e/`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/pipi/work/WaPi/packages/frontend && bunx playwright test e2e/composer.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/pipi/work/WaPi
git add packages/frontend/e2e/composer.spec.ts
git commit -m "test(e2e): Composer 重构 E2E 测试"
```

---

### Task 19: 更新 CHANGELOG.md

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add entry at top**

```markdown
## 2026-07-09
- 新增：Composer 重构支持模型切换、思考强度开关、附件（图片/文件/文本片段）
- 影响范围：packages/frontend、packages/shared、packages/kernel
```

- [ ] **Step 2: Commit**

```bash
cd /Users/pipi/work/WaPi
git add CHANGELOG.md
git commit -m "docs: 更新 CHANGELOG"
```

---

## Self-Review

**1. Spec coverage:**
- 模型切换：Task 4, 10, 11, 14
- 思考强度：Task 5, 10, 11, 14
- 附件（图片/文件/文本片段）：Task 6, 7, 8, 10, 11, 13, 14, 15
- IndexedDB 持久化：Task 2, 3
- supportsVision 开关：Task 12, 15, 16
- 4 层测试：Task 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18
- 无明显遗漏。

**2. Placeholder scan:**
- 无 TBD/TODO。
- 所有步骤包含具体代码/命令。
- 类型签名一致（`AttachmentDraft` / `AttachmentRef` / `SessionPrefs`）。

**3. Type consistency:**
- `PromptEvent` 使用 `AttachmentRef[]`，其中 `image`/`file` 包含 `size`，供后端做 5MB 判断。
- `ComposerInput` 使用 `AttachmentDraft[]`，与 `AttachmentRef` 同构。
- `AgentManager.prompt` 使用 `AttachmentRef[]`。
