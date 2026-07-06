### Task 5: ConfigStore（读写 agent.md）

**Files:**
- Create: `packages/kernel/src/config-store.ts`
- Test: `packages/kernel/tests/config-store.test.ts`

**Interfaces:**
- Consumes: `parseAgentMd`, `stringifyAgentMd`, `validateAgentConfig` from `./agent-md`；`PI_AGENTS_DIR` from `@hiagent/shared`
- Produces:
  - `class ConfigStore { constructor(agentsDir?: string); listAgents(): Promise<AgentConfig[]>; getAgent(name): Promise<AgentConfig | null>; saveAgent(config): Promise<string[]>; }`
  - `saveAgent` 返回校验错误数组（空=保存成功）

- [ ] **Step 1: 写失败测试（用临时目录，不碰真实 ~/.pi）**

`packages/kernel/tests/config-store.test.ts`:
```typescript
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../src/config-store";

function tempAgentsDir() {
  const dir = join(import.meta.dir, ".tmp-agents-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("listAgents 读全部 .md", async () => {
  const dir = tempAgentsDir();
  writeFileSync(join(dir, "dev.md"), `---\nname: dev\ndisplayName: 研发\navatar: "⚙️"\navatarColor: "x"\ndescription: d\nmodel: m\nthinking: high\nsystemPromptMode: replace\ninheritProjectContext: true\ninheritSkills: false\ntools: read\nskills: []\nmcpServers: []\npartners:\n  askTo: []\n  askFrom: []\n---\nbody`);
  const store = new ConfigStore(dir);
  const agents = await store.listAgents();
  expect(agents).toHaveLength(1);
  expect(agents[0].name).toBe("dev");
  rmSync(dir, { recursive: true, force: true });
});

test("getAgent 返回 null 当不存在", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  expect(await store.getAgent("dev")).toBeNull();
  rmSync(dir, { recursive: true, force: true });
});

test("saveAgent 持久化并可读回", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  const errs = await store.saveAgent({
    name: "dev", displayName: "研发", avatar: "⚙️", avatarColor: "a-b",
    description: "d", model: "m", thinking: "high", systemPromptMode: "replace",
    inheritProjectContext: true, inheritSkills: false, tools: ["read"],
    skills: [], mcpServers: [], partners: { askTo: [], askFrom: [] },
    systemPromptBody: "正文",
  });
  expect(errs).toEqual([]);
  const back = await store.getAgent("dev");
  expect(back?.displayName).toBe("研发");
  rmSync(dir, { recursive: true, force: true });
});

test("saveAgent 拒绝非法配置不写盘", async () => {
  const dir = tempAgentsDir();
  const store = new ConfigStore(dir);
  const errs = await store.saveAgent({
    ...(await store.getAgent("dev") || {} as never),
    name: "hacker", displayName: "", model: "", thinking: "high" as never,
    systemPromptMode: "replace", avatar: "", avatarColor: "", description: "",
    inheritProjectContext: true, inheritSkills: false, tools: [], skills: [],
    mcpServers: [], partners: { askTo: [], askFrom: [] },
  } as never);
  expect(errs.length).toBeGreaterThan(0);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 跑确认失败**

```bash
bun test packages/kernel/tests/config-store.test.ts
# 期望: FAIL
```

- [ ] **Step 3: 实现 config-store.ts**

`packages/kernel/src/config-store.ts`:
```typescript
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PI_AGENTS_DIR } from "@hiagent/shared";
import type { AgentConfig, AgentName } from "@hiagent/shared";
import { parseAgentMd, stringifyAgentMd, validateAgentConfig } from "./agent-md";

export class ConfigStore {
  constructor(private agentsDir: string = PI_AGENTS_DIR) {}

  async listAgents(): Promise<AgentConfig[]> {
    try {
      const files = await readdir(this.agentsDir);
      const mds = files.filter(f => f.endsWith(".md"));
      const configs: AgentConfig[] = [];
      for (const f of mds) {
        const content = await readFile(join(this.agentsDir, f), "utf8");
        try { configs.push(parseAgentMd(content)); } catch { /* 跳过损坏文件 */ }
      }
      return configs;
    } catch {
      return [];  // 目录不存在视为空
    }
  }

  async getAgent(name: AgentName): Promise<AgentConfig | null> {
    try {
      const content = await readFile(join(this.agentsDir, `${name}.md`), "utf8");
      return parseAgentMd(content);
    } catch {
      return null;
    }
  }

  async saveAgent(config: AgentConfig): Promise<string[]> {
    const errs = validateAgentConfig(config);
    if (errs.length > 0) return errs;
    await mkdir(this.agentsDir, { recursive: true });
    await writeFile(join(this.agentsDir, `${config.name}.md`), stringifyAgentMd(config), "utf8");
    return [];
  }
}
```

- [ ] **Step 4: 跑测试**

```bash
bun test packages/kernel/tests/config-store.test.ts
# 期望: 4 passed
```

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/config-store.ts packages/kernel/tests/config-store.test.ts
git commit -m "feat(kernel): ConfigStore 读写 agent.md（含校验）"
```

---

