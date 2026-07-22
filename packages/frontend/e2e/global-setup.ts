// E2E globalSetup：启动隔离 kernel（端口 9776），把进程 pid 存到全局供 teardown 清理
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_HIAGENT_DIR, E2E_WS_PORT } from "../playwright.config";

// 预置 agent.md 测试数据：E2E 用独立 HIAGENT_DIR，里面默认无 agent 配置，
// 导致 agent:config:get 返回 null、AgentConfig modal 的 PartnersTab 不渲染。
// 这里写入 dev.md（含 partners 配置），让 configStore.getAgent("dev") 返回真实数据。
// 格式与 packages/kernel/tests/agent-md.test.ts 的 DEV_MD 一致（parseAgentMd 已验证）。
const DEV_AGENT_MD = `---
name: dev
displayName: 研发
avatar: "⚙️"
avatarColor: "#fab387-#f38ba8"
description: 后端研发
model: anthropic/claude-sonnet-4
thinking: high
systemPromptMode: replace
inheritSkills: false
tools: read, bash, edit
skills: architecture-review
mcpServers: []
partners:
  askTo: [product, test]
---
你是一名资深后端工程师。`;

// 预置记忆测试数据：memories/global/MEMORY.md（§ 分隔多条）+ USER.md（amaster memory 目录）。
// memory.spec.ts 通过文件系统断言列表/编辑/归档；必须在 kernel 启动前写入，
// 保证 MemoryStore.list() 首次读取就有数据。
const SEED_MEMORY_MD = "E2E 记忆条目一\n§\nE2E 记忆条目二";
const SEED_USER_MD = "E2E 用户偏好记忆";

// 预置一个测试项目（含项目级 AGENTS.md 指令文件 + 项目记忆），供记忆页作用域切换 E2E 使用。
// 必须在 kernel 启动前写入 projects.json，保证 projects:list 首次返回就有数据。
const SEED_PROJECT_CWD = join(E2E_HIAGENT_DIR, "e2e-project");
const SEED_PROJECTS_JSON = JSON.stringify({
  projects: [{
    id: "e2e-proj-1", name: "E2E项目", cwd: SEED_PROJECT_CWD, createdAt: 0,
  }],
  sessions: [],
}, null, 2);

async function globalSetup() {
  // 预置 agent 配置（在 kernel 启动前写入，确保 configStore 首次读取就有数据）
  mkdirSync(join(E2E_HIAGENT_DIR, "agents"), { recursive: true });
  writeFileSync(join(E2E_HIAGENT_DIR, "agents", "dev.md"), DEV_AGENT_MD, "utf8");

  // 预置记忆测试数据（memory.spec.ts 依赖）
  mkdirSync(join(E2E_HIAGENT_DIR, "memories", "global"), { recursive: true });
  writeFileSync(join(E2E_HIAGENT_DIR, "memories", "global", "MEMORY.md"), SEED_MEMORY_MD, "utf8");
  writeFileSync(join(E2E_HIAGENT_DIR, "memories", "global", "USER.md"), SEED_USER_MD, "utf8");
  // 预置全局指令文件（指令文件 Tab 测试依赖）
  writeFileSync(join(E2E_HIAGENT_DIR, "AGENTS.md"), "# 全局指令\n这是 E2E 测试的全局指令文件", "utf8");

  // 预置测试项目：projects.json + 项目 cwd 下的 AGENTS.md（项目级指令文件）
  // + 项目记忆文件（让记忆页「项目」作用域有数据可查）。
  // 项目记忆目录由 projectNameFromCwd(cwd) 决定（basename），即 projects-memory/<basename>/MEMORY.md
  mkdirSync(SEED_PROJECT_CWD, { recursive: true });
  writeFileSync(join(SEED_PROJECT_CWD, "AGENTS.md"), "# E2E 项目指令\n这是项目级指令文件", "utf8");
  writeFileSync(join(E2E_HIAGENT_DIR, "projects.json"), SEED_PROJECTS_JSON, "utf8");
  mkdirSync(join(E2E_HIAGENT_DIR, "projects-memory", "e2e-project"), { recursive: true });
  writeFileSync(join(E2E_HIAGENT_DIR, "projects-memory", "e2e-project", "MEMORY.md"), "E2E 项目记忆条目", "utf8");

  // 启动 kernel，注入独立 HIAGENT_DIR（覆盖 ~/.hiagent）与 WS 端口（默认 9776，可偏移避开本机真实 kernel）
  const child = spawn("bun", ["run", "--filter", "@hiagent/kernel", "dev"], {
    env: { ...process.env, HIAGENT_DIR: E2E_HIAGENT_DIR, HIAGENT_WS_PORT: String(E2E_WS_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true, // Windows 下 bun 是 npm 装的 .cmd shim，需要 shell 解析，否则 spawn ENOENT
  });
  child.stdout?.on("data", () => {});  // 防 stdout 缓冲写满阻塞
  child.stderr?.on("data", () => {});

  // 等 kernel 起来（轮询 WS 端口）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ok = await checkPort(E2E_WS_PORT);
    if (ok) {
      writeFileSync(join(E2E_HIAGENT_DIR, ".kernel-pid"), String(child.pid));
      return;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  child.kill();
  throw new Error(`E2E kernel 启动超时（端口 ${E2E_WS_PORT} 未监听）`);
}

function checkPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.onopen = () => { ws.close(); resolve(true); };
    ws.onerror = () => resolve(false);
    setTimeout(() => { ws.close(); resolve(false); }, 200);
  });
}

export default globalSetup;
