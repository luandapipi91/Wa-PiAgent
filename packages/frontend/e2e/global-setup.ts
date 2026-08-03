// E2E globalSetup：启动隔离 kernel（端口 9776），把进程 pid 存到全局供 teardown 清理
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR, E2E_WS_PORT } from "../playwright.config";

// 预置 agent.md 测试数据：E2E 用独立 WA_PI_DIR，里面默认无 agent 配置，
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
const SEED_PROJECT_CWD = join(E2E_WA_PI_DIR, "e2e-project");
const SEED_PROJECTS_JSON = JSON.stringify({
  projects: [{
    id: "e2e-proj-1", name: "E2E项目", cwd: SEED_PROJECT_CWD, createdAt: 0,
  }],
  sessions: [],
}, null, 2);

async function globalSetup() {
  // E2E_WA_PI_DIR 现为固定目录（见 playwright.config.ts 注释）：开头清空重建，
  // 清掉上一轮可能残留的 kernel 数据（崩溃时 teardown 未跑完），保证预置数据干净
  rmSync(E2E_WA_PI_DIR, { recursive: true, force: true });
  mkdirSync(E2E_WA_PI_DIR, { recursive: true });

  // 预置 agent 配置（在 kernel 启动前写入，确保 configStore 首次读取就有数据）
  mkdirSync(join(E2E_WA_PI_DIR, "agents"), { recursive: true });
  writeFileSync(join(E2E_WA_PI_DIR, "agents", "dev.md"), DEV_AGENT_MD, "utf8");

  // 预置记忆测试数据（memory.spec.ts 依赖）
  mkdirSync(join(E2E_WA_PI_DIR, "memories", "global"), { recursive: true });
  writeFileSync(join(E2E_WA_PI_DIR, "memories", "global", "MEMORY.md"), SEED_MEMORY_MD, "utf8");
  writeFileSync(join(E2E_WA_PI_DIR, "memories", "global", "USER.md"), SEED_USER_MD, "utf8");
  // 预置全局指令文件（指令文件 Tab 测试依赖）
  writeFileSync(join(E2E_WA_PI_DIR, "AGENTS.md"), "# 全局指令\n这是 E2E 测试的全局指令文件", "utf8");

  // 预置测试项目：projects.json + 项目 cwd 下的 AGENTS.md（项目级指令文件）
  // + 项目记忆文件（让记忆页「项目」作用域有数据可查）。
  // 项目记忆目录由 projectNameFromCwd(cwd) 决定（basename），即 projects-memory/<basename>/MEMORY.md
  mkdirSync(SEED_PROJECT_CWD, { recursive: true });
  writeFileSync(join(SEED_PROJECT_CWD, "AGENTS.md"), "# E2E 项目指令\n这是项目级指令文件", "utf8");
  // 预置 md 预览渲染测试文件（含标题/表格/代码块/mermaid）：explorer.spec.ts 双击断言 markdown 渲染
  writeFileSync(join(SEED_PROJECT_CWD, "PREVIEW.md"),
    ["# E2E 预览测试", "", "| 列A | 列B |", "|-----|-----|", "| 1   | 2   |", "", "```ts", "const y = 2;", "```", "", "```mermaid", "graph TD", "  A --> B", "```", ""].join("\n"),
    "utf8");
  writeFileSync(join(E2E_WA_PI_DIR, "projects.json"), SEED_PROJECTS_JSON, "utf8");
  // 预置一个不支持预览的文件（zip）：FileViewer unsupported 分支显示「在系统查看文件」按钮的 E2E 依赖
  writeFileSync(join(SEED_PROJECT_CWD, "sample.zip"), "PK\x03\x04 e2e-zip-placeholder", "utf8");
  mkdirSync(join(E2E_WA_PI_DIR, "projects-memory", "e2e-project"), { recursive: true });
  writeFileSync(join(E2E_WA_PI_DIR, "projects-memory", "e2e-project", "MEMORY.md"), "E2E 项目记忆条目", "utf8");

  // 启动 kernel，注入独立 WA_PI_DIR（覆盖 ~/.wa-pi）与 WS 端口（默认 9776，可偏移避开本机真实 kernel）
  // WA_PI_SKIP_AGENT_SEED=1：关闭内置角色 seed，保持隔离环境只有预置的 dev.md，
  // 否则 kernel 启动会补齐 11 个内置角色，打破 agents.spec.ts「初始仅 1 个智能体」的前提
  const child = spawn("bun", ["run", "--filter", "@wa-pi/kernel", "dev"], {
    env: { ...process.env, WA_PI_DIR: E2E_WA_PI_DIR, WA_PI_WS_PORT: String(E2E_WS_PORT), WA_PI_SKIP_AGENT_SEED: "1" },
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
      writeFileSync(join(E2E_WA_PI_DIR, ".kernel-pid"), String(child.pid));
      return;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  child.kill();
  throw new Error(`E2E kernel 启动超时（端口 ${E2E_WS_PORT} 未监听）`);
}

// kernel 已去 WS 化（SSE /api/events + REST /api/*），用 HTTP 探活代替 WebSocket
async function checkPort(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default globalSetup;
