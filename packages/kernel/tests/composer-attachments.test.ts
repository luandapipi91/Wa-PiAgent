import { describe, it, expect, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { AgentManager } from "../src/agent-manager";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import type { WSClientEvent, WSServerEvent } from "@hiagent/shared";

function makeTempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface PromptCall {
  text: string;
  opts?: any;
}

async function waitFor(condition: () => boolean, timeout = 3000, interval = 50) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error("waitFor 超时");
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * 启动一个真实的 WSServer，但注入 mock 的 AgentSession。
 * 这样可以在不调用真实 LLM 的情况下，验证 WS 层到 AgentManager.prompt 的完整链路，
 * 包括附件文本的拼装。
 */
async function withComposerServer<T>(
  fn: (
    send: (e: WSClientEvent) => void,
    recv: () => Promise<WSServerEvent>,
    getPromptCalls: () => PromptCall[],
  ) => Promise<T>,
): Promise<T> {
  const baseDir = makeTempDir("hiagent-composer-");
  const configStore = new ConfigStore(join(baseDir, "agents"));
  const projectStore = new ProjectStore(join(baseDir, "projects.json"));
  const providerStore = new ProviderStore(join(baseDir, "providers.json"));
  const skillManager = new SkillManager(baseDir);
  const dataDir = join(baseDir, "data");

  const promptCalls: PromptCall[] = [];
  const fakeUnsubscribe = mock(() => {});
  const fakeSession = {
    prompt: mock(async (text: string, opts?: any) => {
      promptCalls.push({ text, opts });
    }),
    abort: mock(async () => {}),
    dispose: mock(() => {}),
    setSessionName: mock(() => {}),
    setModel: mock(async () => {}),
    setThinkingLevel: mock(() => {}),
    subscribe: mock(() => fakeUnsubscribe),
    messages: [],
    isStreaming: false,
    pendingMessageCount: 0,
    clearQueue: mock(() => ({ steering: [], followUp: [] })),
    followUp: mock(async () => {}),
    steer: mock(async () => {}),
    modelRegistry: {
      getAll: () => [{ id: "test-model", provider: "test-provider", name: "Test", api: {}, baseUrl: "" }],
      hasConfiguredAuth: () => true,
    },
  } as any;

  const createAgentSessionFn = mock(async () => ({ session: fakeSession }));

  const agentManager = new AgentManager({
    projectStore,
    configStore: null as any,
    onEvent: () => {},
    createAgentSessionFn: createAgentSessionFn as any,
  });

  const server = new WSServer({
    configStore,
    projectStore,
    providerStore,
    skillManager,
    dataDir,
    agentManager,
    port: 0,
  });

  await server.start();
  const port = server.actualPort;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = rej;
  });

  const queue: WSServerEvent[] = [];
  ws.onmessage = (ev) => queue.push(JSON.parse(String(ev.data)));
  const send = (e: WSClientEvent) => ws.send(JSON.stringify(e));
  const recv = async (): Promise<WSServerEvent> => {
    while (queue.length === 0) await new Promise((r) => setTimeout(r, 20));
    return queue.shift()!;
  };

  try {
    return await fn(send, recv, () => promptCalls);
  } finally {
    ws.close();
    await server.stop();
    rmSync(baseDir, { recursive: true, force: true });
  }
}

describe("composer attachments integration", () => {
  it("fs:readFile 返回真实文件的 base64 内容与 mimeType", async () => {
    const fileDir = makeTempDir("hiagent-read-");
    const filePath = join(fileDir, "hello.txt");
    writeFileSync(filePath, "hello world");

    try {
      await withComposerServer(async (send, recv) => {
        send({ type: "fs:readFile", path: filePath });
        const resp = (await recv()) as any;
        expect(resp.type).toBe("fs:readFile");
        expect(resp.path).toBe(filePath);
        expect(resp.mimeType).toBe("text/plain");
        expect(resp.content).toBe(Buffer.from("hello world").toString("base64"));
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("fs:upload 对同名文件自动追加序号", async () => {
    const fileDir = makeTempDir("hiagent-upload-dup-");
    const uploadDir = join(fileDir, ".hiagent", "uploads");
    mkdirSync(uploadDir, { recursive: true });
    writeFileSync(join(uploadDir, "notes.txt"), "existing", "utf8");

    try {
      await withComposerServer(async (send, recv) => {
        send({ type: "project:create", name: "P", cwd: fileDir });
        const created = (await recv()) as any;
        const projectId = created.project.id;

        const content = Buffer.from("new content").toString("base64");
        send({ type: "fs:upload", id: "u2", projectId, name: "notes.txt", content });

        const resp = (await recv()) as any;
        expect(resp.path).toBe(join(uploadDir, "notes (1).txt"));
        expect(readFileSync(resp.path, "utf8")).toBe("new content");
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("fs:upload 拒绝路径穿越文件名", async () => {
    const fileDir = makeTempDir("hiagent-upload-traversal-");

    try {
      await withComposerServer(async (send, recv) => {
        send({ type: "project:create", name: "P", cwd: fileDir });
        const created = (await recv()) as any;
        const projectId = created.project.id;

        const content = Buffer.from("x").toString("base64");
        send({ type: "fs:upload", id: "u3", projectId, name: "../escape.txt", content });

        const resp = (await recv()) as any;
        expect(resp.path).toBe(join(fileDir, ".hiagent", "uploads", "escape.txt"));
        expect(existsSync(resp.path)).toBe(true);
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("fs:upload 将 .. / . 文件名替换为安全名称", async () => {
    const fileDir = makeTempDir("hiagent-upload-dot-");

    try {
      await withComposerServer(async (send, recv) => {
        send({ type: "project:create", name: "P", cwd: fileDir });
        const created = (await recv()) as any;
        const projectId = created.project.id;

        const content = Buffer.from("x").toString("base64");
        send({ type: "fs:upload", id: "u4", projectId, name: "..", content });

        const resp = (await recv()) as any;
        expect(resp.path).toBe(join(fileDir, ".hiagent", "uploads", "upload"));
        expect(existsSync(resp.path)).toBe(true);
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("fs:upload 将文件写入项目目录 .hiagent/uploads 并返回绝对路径", async () => {
    const fileDir = makeTempDir("hiagent-upload-");

    try {
      await withComposerServer(async (send, recv) => {
        send({ type: "project:create", name: "P", cwd: fileDir });
        const created = (await recv()) as any;
        const projectId = created.project.id;

        const content = Buffer.from("uploaded content").toString("base64");
        send({ type: "fs:upload", id: "u1", projectId, name: "notes.txt", content });

        const resp = (await recv()) as any;
        expect(resp.type).toBe("fs:upload");
        expect(resp.id).toBe("u1");
        expect(resp.error).toBeUndefined();
        expect(resp.path).toBe(join(fileDir, ".hiagent", "uploads", "notes.txt"));
        expect(existsSync(resp.path)).toBe(true);
        expect(readFileSync(resp.path, "utf8")).toBe("uploaded content");
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("agent:prompt 携带 file 附件时，最终 prompt 文本包含 @路径引用块", async () => {
    const fileDir = makeTempDir("hiagent-attach-");
    const filePath = join(fileDir, "notes.txt");
    writeFileSync(filePath, "这是附件内容");

    try {
      await withComposerServer(async (send, recv, getPromptCalls) => {
        send({ type: "project:create", name: "P", cwd: fileDir });
        const created = (await recv()) as any;
        const projectId = created.project.id;

        send({
          type: "agent:prompt",
          projectId,
          sessionId: "s-file",
          agentName: "dev",
          text: "分析这个文件",
          model: "test-provider/test-model",
          attachments: [{ kind: "file", name: "notes.txt", path: filePath, size: 0 }],
        });

        const ev = (await recv()) as any;
        expect(ev.type).toBe("session:created");

        // 等待 AgentManager 异步完成 prompt 调用
        await waitFor(() => getPromptCalls().length > 0);

        const calls = getPromptCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0].text).toContain("分析这个文件");
        expect(calls[0].text).toContain("Attachments:");
        expect(calls[0].text).toContain("[@notes.txt]");
        expect(calls[0].text).not.toContain("这是附件内容");
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("agent:prompt 携带 image 附件时，最终 prompt 文本用 @路径引用而不是 base64", async () => {
    const fileDir = makeTempDir("hiagent-img-");
    const imgPath = join(fileDir, "shot.png");
    writeFileSync(imgPath, "\x89PNG\r\n\x1a\n");

    try {
      await withComposerServer(async (send, recv, getPromptCalls) => {
        send({ type: "project:create", name: "P", cwd: fileDir });
        const created = (await recv()) as any;
        const projectId = created.project.id;

        send({
          type: "agent:prompt",
          projectId,
          sessionId: "s-img",
          agentName: "dev",
          text: "看这张图",
          model: "test-provider/test-model",
          attachments: [{ kind: "image", name: "shot.png", path: imgPath, size: 0 }],
        });

        const ev = (await recv()) as any;
        expect(ev.type).toBe("session:created");

        await waitFor(() => getPromptCalls().length > 0);

        const calls = getPromptCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0].text).toContain("看这张图");
        expect(calls[0].text).toContain("Attachments:");
        expect(calls[0].text).toContain("[@shot.png]");
        expect(calls[0].opts).toBeUndefined();
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("agent:prompt 携带 snippet 附件时，最终 prompt 文本包含片段引用与片段内容", async () => {
    const fileDir = makeTempDir("hiagent-snippet-");

    try {
      await withComposerServer(async (send, recv, getPromptCalls) => {
        send({ type: "project:create", name: "P", cwd: fileDir });
        const created = (await recv()) as any;
        const projectId = created.project.id;

        send({
          type: "agent:prompt",
          projectId,
          sessionId: "s-snippet",
          agentName: "dev",
          text: "解释这段代码",
          model: "test-provider/test-model",
          attachments: [{ kind: "snippet", name: "utils.ts", content: "const x = 1;" }],
        });

        const ev = (await recv()) as any;
        expect(ev.type).toBe("session:created");

        await waitFor(() => getPromptCalls().length > 0);

        const calls = getPromptCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0].text).toContain("[片段: utils.ts]");
        expect(calls[0].text).toContain("const x = 1;");
        expect(calls[0].text).toContain("解释这段代码");
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });
});
