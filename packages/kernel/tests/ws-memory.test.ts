import { test, expect } from "bun:test";
import { rmSync, mkdirSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { MemoryStore } from "../src/memory-store";
import { ProjectStore } from "../src/project-store";
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";

function tmp(p: string) { return join(import.meta.dir, p + Math.random().toString(36).slice(2)); }

function makeMockAgentManager() {
  const calls = { markAllDirty: 0 };
  return {
    ensureStarted: async () => ({ messages: [], prompt: async () => {}, abort: async () => {}, dispose: () => {} }),
    prompt: async () => {}, abort: async () => {},
    disposeSession: async () => {}, disposeAll: async () => {},
    markAllDirty: () => { calls.markAllDirty++; }, calls,
  } as any;
}

/**
 * 启动一个独立的 WSServer，跑 fn 后清理。
 * setup 在 server.start 前调用，用于在 dataDir 下播种记忆/指令文件。
 */
async function withMemoryServer<T>(
  setup: (dataDir: string) => Promise<void>,
  fn: (
    send: (e: WSClientEvent) => void,
    recv: () => Promise<WSServerEvent>,
    mockAM: { calls: { markAllDirty: number } },
    dataDir: string,
  ) => Promise<T>,
): Promise<T> {
  const dataDir = tmp("ws-mem");
  mkdirSync(dataDir, { recursive: true });
  await setup(dataDir);
  const mockAM = makeMockAgentManager();
  const projectStore = new ProjectStore(join(dataDir, "projects.json"));
  const memoryStore = new MemoryStore({ hiagentDir: dataDir, projectStore });
  const server = new WSServer({
    configStore: null as any,
    projectStore,
    providerStore: null as any,
    skillManager: null as any,
    extensionManager: null as any,
    memoryStore,
    dataDir,
    agentManager: mockAM,
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
  try { return await fn(send, recv, mockAM, dataDir); }
  finally { ws.close(); await server.stop(); rmSync(dataDir, { recursive: true, force: true }); }
}

// ===== memory:list =====

test("memory:list 返回解析后的记忆列表", async () => {
  await withMemoryServer(
    async (dataDir) => {
      await mkdir(join(dataDir, "memories", "global"), { recursive: true });
      await writeFile(join(dataDir, "memories", "global", "MEMORY.md"), "测试记忆", "utf8");
    },
    async (send, recv) => {
      send({ type: "memory:list", projectId: "any" });
      const resp = await recv() as any;
      expect(resp.type).toBe("memory:list");
      expect(resp.memories).toHaveLength(1);
      expect(resp.memories[0].text).toBe("测试记忆");
      expect(Array.isArray(resp.archived)).toBe(true);
    },
  );
});

test("memory:list 多条 § 分隔全部返回", async () => {
  await withMemoryServer(
    async (dataDir) => {
      await mkdir(join(dataDir, "memories", "global"), { recursive: true });
      await writeFile(join(dataDir, "memories", "global", "MEMORY.md"), "条目A\n§\n条目B", "utf8");
    },
    async (send, recv) => {
      send({ type: "memory:list", projectId: "any" });
      const resp = await recv() as any;
      expect(resp.memories).toHaveLength(2);
      expect(resp.memories[0].text).toBe("条目A");
      expect(resp.memories[1].text).toBe("条目B");
    },
  );
});

// ===== memory:update =====

test("memory:update 编辑后广播 memory:changed", async () => {
  await withMemoryServer(
    async (dataDir) => {
      await mkdir(join(dataDir, "memories", "global"), { recursive: true });
      await writeFile(join(dataDir, "memories", "global", "MEMORY.md"), "旧内容", "utf8");
    },
    async (send, recv) => {
      send({ type: "memory:list", projectId: "any" });
      const list = await recv() as any;
      const entryId = list.memories[0].id;

      send({ type: "memory:update", projectId: "any", entryId, text: "新内容" });
      const changed = await recv() as any;
      expect(changed.type).toBe("memory:changed");
      expect(changed.memories[0].text).toBe("新内容");
    },
  );
});

test("memory:update 不存在的 entryId 返回 error", async () => {
  await withMemoryServer(
    async () => {},
    async (send, recv) => {
      send({ type: "memory:update", projectId: "any", entryId: "memories/global/MEMORY.md:0", text: "新" });
      const resp = await recv() as any;
      expect(resp.type).toBe("error");
    },
  );
});

// ===== memory:archive =====

test("memory:archive 广播 memory:changed 且条目进入归档", async () => {
  await withMemoryServer(
    async (dataDir) => {
      await mkdir(join(dataDir, "memories", "global"), { recursive: true });
      await writeFile(join(dataDir, "memories", "global", "MEMORY.md"), "条目A\n§\n条目B", "utf8");
    },
    async (send, recv) => {
      send({ type: "memory:list", projectId: "any" });
      const list = await recv() as any;
      const targetId = list.memories[0].id;

      send({ type: "memory:archive", projectId: "any", entryId: targetId });
      const changed = await recv() as any;
      expect(changed.type).toBe("memory:changed");
      expect(changed.memories).toHaveLength(1);
      expect(changed.memories[0].text).toBe("条目B");
      expect(changed.archived).toHaveLength(1);
      expect(changed.archived[0].text).toBe("条目A");
    },
  );
});

// ===== memory:restore =====

test("memory:restore 把归档条目恢复回列表并广播", async () => {
  await withMemoryServer(
    async (dataDir) => {
      await mkdir(join(dataDir, "memories", "global"), { recursive: true });
      await writeFile(join(dataDir, "memories", "global", "MEMORY.md"), "条目A", "utf8");
    },
    async (send, recv) => {
      send({ type: "memory:list", projectId: "any" });
      const list = await recv() as any;
      const targetId = list.memories[0].id;

      // 先归档
      send({ type: "memory:archive", projectId: "any", entryId: targetId });
      await recv() as any;

      // 再恢复
      send({ type: "memory:restore", projectId: "any", entryId: targetId });
      const changed = await recv() as any;
      expect(changed.type).toBe("memory:changed");
      const texts = changed.memories.map((m: any) => m.text);
      expect(texts).toContain("条目A");
      expect(changed.archived).toHaveLength(0);
    },
  );
});

// ===== memory:purge =====

test("memory:purge 从归档彻底删除并广播", async () => {
  await withMemoryServer(
    async (dataDir) => {
      await mkdir(join(dataDir, "memories", "global"), { recursive: true });
      await writeFile(join(dataDir, "memories", "global", "MEMORY.md"), "条目A", "utf8");
    },
    async (send, recv) => {
      send({ type: "memory:list", projectId: "any" });
      const list = await recv() as any;
      const targetId = list.memories[0].id;

      send({ type: "memory:archive", projectId: "any", entryId: targetId });
      const afterArchive = await recv() as any;
      expect(afterArchive.archived).toHaveLength(1);

      send({ type: "memory:purge", projectId: "any", entryId: targetId });
      const changed = await recv() as any;
      expect(changed.type).toBe("memory:changed");
      expect(changed.archived).toHaveLength(0);
    },
  );
});

// ===== memory:add =====

test("memory:add 全局记忆后广播 memory:changed", async () => {
  await withMemoryServer(
    async () => {},
    async (send, recv) => {
      send({ type: "memory:add", scope: "global", text: "手动添加的全局记忆" });
      const resp = await recv() as any;
      expect(resp.type).toBe("memory:changed");
      const texts = resp.memories.map((m: any) => m.text);
      expect(texts).toContain("手动添加的全局记忆");
    },
  );
});

test("memory:add 项目记忆落到项目目录并广播", async () => {
  await withMemoryServer(
    async (dataDir) => {
      const projectCwd = join(dataDir, "fake-project");
      await mkdir(projectCwd, { recursive: true });
      const ps = new ProjectStore(join(dataDir, "projects.json"));
      await ps.createProject({ name: "fake-project", cwd: projectCwd });
    },
    async (send, recv, _mockAM, dataDir) => {
      const ps = new ProjectStore(join(dataDir, "projects.json"));
      const { projects } = await ps.load();
      const projectId = projects[0].id;

      send({ type: "memory:add", scope: "project", projectId, text: "手动添加的项目记忆" });
      const resp = await recv() as any;
      expect(resp.type).toBe("memory:changed");
      const found = resp.memories.find(
        (m: any) => m.text === "手动添加的项目记忆" && m.scope === "project",
      );
      expect(found).toBeTruthy();
    },
  );
});

test("memory:add 项目记忆缺少 projectId 返回 error", async () => {
  await withMemoryServer(
    async () => {},
    async (send, recv) => {
      send({ type: "memory:add", scope: "project", text: "无项目" });
      const resp = await recv() as any;
      expect(resp.type).toBe("error");
    },
  );
});

// ===== instruction:list =====

test("instruction:list 返回全局和项目级指令文件", async () => {
  await withMemoryServer(
    async (dataDir) => {
      await writeFile(join(dataDir, "AGENTS.md"), "全局指令", "utf8");
      const projectCwd = join(dataDir, "fake-project");
      await mkdir(projectCwd, { recursive: true });
      await writeFile(join(projectCwd, "AGENTS.md"), "项目指令", "utf8");
      // 注册项目到 ProjectStore
      const ps = new ProjectStore(join(dataDir, "projects.json"));
      await ps.createProject({ name: "fake-project", cwd: projectCwd });
    },
    async (send, recv, _mockAM, dataDir) => {
      const ps = new ProjectStore(join(dataDir, "projects.json"));
      const { projects } = await ps.load();
      const projectId = projects[0].id;

      send({ type: "instruction:list", projectId });
      const resp = await recv() as any;
      expect(resp.type).toBe("instruction:list");
      expect(resp.instructions.length).toBeGreaterThanOrEqual(1);
      const scopes = resp.instructions.map((i: any) => i.scope);
      expect(scopes).toContain("global");
      expect(scopes).toContain("project");
    },
  );
});

test("instruction:list 没有指令文件时返回空数组", async () => {
  await withMemoryServer(
    async () => {},
    async (send, recv) => {
      send({ type: "instruction:list", projectId: "nonexistent" });
      const resp = await recv() as any;
      expect(resp.type).toBe("instruction:list");
      expect(resp.instructions).toEqual([]);
    },
  );
});

// ===== memory:config:get =====

test("memory:config:get 返回默认配置", async () => {
  await withMemoryServer(
    async () => {},
    async (send, recv) => {
      send({ type: "memory:config:get" });
      const resp = await recv() as any;
      expect(resp.type).toBe("memory:config");
      expect(resp.config.reviewEnabled).toBe(true);
      expect(resp.config.memoryPolicyStyle).toBe("full");
    },
  );
});

// ===== memory:config:set =====

test("memory:config:set 调 markAllDirty 并广播 memory:config", async () => {
  await withMemoryServer(
    async () => {},
    async (send, recv, mockAM) => {
      send({ type: "memory:config:set", reviewEnabled: false, memoryPolicyStyle: "compact" });
      const resp = await recv() as any;
      expect(resp.type).toBe("memory:config");
      expect(resp.config.reviewEnabled).toBe(false);
      expect(resp.config.memoryPolicyStyle).toBe("compact");
      expect(mockAM.calls.markAllDirty).toBe(1);
    },
  );
});

test("memory:config:set 后 memory:config:get 读回新值", async () => {
  await withMemoryServer(
    async () => {},
    async (send, recv) => {
      send({ type: "memory:config:set", reviewEnabled: false });
      const setResp = await recv() as any;
      expect(setResp.config.reviewEnabled).toBe(false);

      send({ type: "memory:config:get" });
      const getResp = await recv() as any;
      expect(getResp.config.reviewEnabled).toBe(false);
    },
  );
});
