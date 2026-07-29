import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WSServer } from "../src/ws-server";
import { AgentManager } from "../src/agent-manager";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { FakeSessionClient, fakeClientFactory } from "./fixtures/fake-session-client";
import { WA_PI_DIR } from "@wa-pi/shared";

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
 * SSE 帧读取器：从 EventSource 流中按帧消费
 */
class SseReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private dec = new TextDecoder();
  private buf = "";
  private events: any[] = [];

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  async next(): Promise<any> {
    while (this.events.length === 0) {
      const { done, value } = await this.reader.read();
      if (done) throw new Error("SSE 流意外结束");
      this.buf += this.dec.decode(value, { stream: true });
      for (;;) {
        const idx = this.buf.indexOf("\n\n");
        if (idx < 0) break;
        const frame = this.buf.slice(0, idx);
        this.buf = this.buf.slice(idx + 2);
        if (frame.startsWith(":")) continue;
        const data = JSON.parse(frame.match(/^data: (.*)$/m)?.[1] ?? "null");
        this.events.push(data);
      }
    }
    return this.events.shift();
  }

  cancel() { this.reader.cancel().catch(() => {}); }
}

/**
 * 启动 WSServer + FakeSessionClient + SSE 流，验证 REST 端点全链路。
 */
async function withComposerServer<T>(
  fn: (
    base: string,
    getPromptCalls: () => PromptCall[],
    sse: SseReader,
  ) => Promise<T>,
): Promise<T> {
  const baseDir = makeTempDir("wa-pi-composer-");
  const configStore = new ConfigStore(join(baseDir, "agents"));
  const projectStore = new ProjectStore(join(baseDir, "projects.json"));
  const providerStore = new ProviderStore(join(baseDir, "providers.json"));
  const skillManager = new SkillManager(baseDir);
  const dataDir = join(baseDir, "data");

  const fakes: FakeSessionClient[] = [];
  const agentManager = new AgentManager({
    projectStore,
    configStore: null,
    onEvent: () => {},
    createClientFn: fakeClientFactory(fakes),
  });

  const server = new WSServer({
    configStore,
    projectStore,
    providerStore,
    skillManager,
    extensionManager: new ExtensionManager(dataDir),
    memoryStore: null as any,
    mcpStore: null as any,
    dataDir,
    agentManager,
    port: 0,
  });

  await server.start();
  const base = `http://127.0.0.1:${server.actualPort}`;

  // 建立 SSE 连接
  const sseRes = await fetch(`${base}/api/events`);
  if (!sseRes.ok || !sseRes.body) throw new Error("SSE 连接失败");
  const sse = new SseReader(sseRes.body.getReader());

  try {
    return await fn(base, () => fakes.flatMap((f) => f.prompted.map((text) => ({ text }))), sse);
  } finally {
    sse.cancel();
    await server.stop();
    const sessionIds = [...(((agentManager as any).sessions?.keys?.() ?? []) as Iterable<string>)];
    await agentManager.disposeAll().catch(() => {});
    for (const id of sessionIds) {
      try { rmSync(join(WA_PI_DIR, "tmp", "sysprompts", `${id}.md`), { force: true }); } catch {}
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
}

/** 创建项目并返回 projectId（从 SSE 读取 project:created） */
async function createProject(base: string, sse: SseReader, cwd: string): Promise<string> {
  await fetch(`${base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "P", cwd }),
  });
  const ev = await sse.next();
  if (ev.type !== "project:created") throw new Error(`期望 project:created，收到 ${ev.type}`);
  return ev.project.id;
}

describe("composer attachments integration", () => {
  it("fs:readFile 返回真实文件的 base64 内容与 mimeType", async () => {
    const fileDir = makeTempDir("wa-pi-read-");
    const filePath = join(fileDir, "hello.txt");
    writeFileSync(filePath, "hello world");

    try {
      await withComposerServer(async (base, _getPromptCalls, _sse) => {
        const res = await fetch(`${base}/api/fs/read-file`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: filePath }),
        });
        const resp = await res.json();
        expect(resp.type).toBe("fs:readFile");
        expect(resp.path).toBe(filePath);
        expect(resp.mimeType).toBe("text/plain");
        expect(resp.content).toBe(Buffer.from("hello world").toString("base64"));
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("fs:readFile 正确展开 ~ 为 HOME 目录", async () => {
    // 在 HOME 下创建临时文件，然后用 ~ 路径读取
    const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
    const testFileName = `wa-pi-tilde-test-${Math.random().toString(36).slice(2)}.txt`;
    const filePath = join(homeDir, testFileName);
    const tildePath = `~/${testFileName}`;
    writeFileSync(filePath, "tilde expanded");

    try {
      await withComposerServer(async (base, _getPromptCalls, _sse) => {
        const res = await fetch(`${base}/api/fs/read-file`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: tildePath }),
        });
        const resp = await res.json();
        // ~ 展开后应正确读取文件
        expect(resp.type).toBe("fs:readFile");
        expect(resp.content).toBe(Buffer.from("tilde expanded").toString("base64"));
      });
    } finally {
      rmSync(filePath, { force: true });
    }
  });

  it("fs:upload 对同名文件自动追加序号", async () => {
    const fileDir = makeTempDir("wa-pi-upload-dup-");
    const uploadDir = join(fileDir, ".wa-pi", "uploads");
    mkdirSync(uploadDir, { recursive: true });
    writeFileSync(join(uploadDir, "notes.txt"), "existing", "utf8");

    try {
      await withComposerServer(async (base, _getPromptCalls, sse) => {
        const projectId = await createProject(base, sse, fileDir);

        const content = Buffer.from("new content");
        const form = new FormData();
        form.append("file", new Blob([content]), "notes.txt");
        const res = await fetch(`${base}/api/files/upload?projectId=${encodeURIComponent(projectId)}`, {
          method: "POST",
          body: form,
        });
        const resp = await res.json();
        expect(resp.path).toBe(join(uploadDir, "notes (1).txt"));
        expect(readFileSync(resp.path, "utf8")).toBe("new content");
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("fs:upload 拒绝路径穿越文件名", async () => {
    const fileDir = makeTempDir("wa-pi-upload-traversal-");

    try {
      await withComposerServer(async (base, _getPromptCalls, sse) => {
        const projectId = await createProject(base, sse, fileDir);

        const form = new FormData();
        form.append("file", new Blob([Buffer.from("x")]), "../escape.txt");
        const res = await fetch(`${base}/api/files/upload?projectId=${encodeURIComponent(projectId)}`, {
          method: "POST",
          body: form,
        });
        const resp = await res.json();
        expect(resp.path).toBe(join(fileDir, ".wa-pi", "uploads", "escape.txt"));
        expect(existsSync(resp.path)).toBe(true);
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("fs:upload 将 .. / . 文件名替换为安全名称", async () => {
    const fileDir = makeTempDir("wa-pi-upload-dot-");

    try {
      await withComposerServer(async (base, _getPromptCalls, sse) => {
        const projectId = await createProject(base, sse, fileDir);

        const form = new FormData();
        form.append("file", new Blob([Buffer.from("x")]), "..");
        const res = await fetch(`${base}/api/files/upload?projectId=${encodeURIComponent(projectId)}`, {
          method: "POST",
          body: form,
        });
        const resp = await res.json();
        expect(resp.path).toBe(join(fileDir, ".wa-pi", "uploads", "upload"));
        expect(existsSync(resp.path)).toBe(true);
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("fs:upload 将文件写入项目目录 .wa-pi/uploads 并返回绝对路径", async () => {
    const fileDir = makeTempDir("wa-pi-upload-");

    try {
      await withComposerServer(async (base, _getPromptCalls, sse) => {
        const projectId = await createProject(base, sse, fileDir);

        const content = Buffer.from("uploaded content");
        const form = new FormData();
        form.append("file", new Blob([content]), "notes.txt");
        const res = await fetch(`${base}/api/files/upload?projectId=${encodeURIComponent(projectId)}`, {
          method: "POST",
          body: form,
        });
        const resp = await res.json();
        expect(resp.type).toBe("fs:upload");
        expect(resp.error).toBeUndefined();
        expect(resp.path).toBe(join(fileDir, ".wa-pi", "uploads", "notes.txt"));
        expect(existsSync(resp.path)).toBe(true);
        expect(readFileSync(resp.path, "utf8")).toBe("uploaded content");
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("agent:prompt 携带 file 附件时，最终 prompt 文本包含 @路径引用块", async () => {
    const fileDir = makeTempDir("wa-pi-attach-");
    const filePath = join(fileDir, "notes.txt");
    writeFileSync(filePath, "这是附件内容");

    try {
      await withComposerServer(async (base, getPromptCalls, sse) => {
        const projectId = await createProject(base, sse, fileDir);

        const promptP = fetch(`${base}/api/agents/${encodeURIComponent(projectId)}/s-file/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentName: "dev",
            text: "分析这个文件",
            model: "test-provider/test-model",
            attachments: [{ kind: "file", name: "notes.txt", path: filePath, size: 0 }],
          }),
        });
        // session:created 走 SSE 广播，非 HTTP 响应体
        const sseEv = await sse.next();
        expect(sseEv.type).toBe("session:created");
        await promptP;

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
    const fileDir = makeTempDir("wa-pi-img-");
    const imgPath = join(fileDir, "shot.png");
    writeFileSync(imgPath, "\x89PNG\r\n\x1a\n");

    try {
      await withComposerServer(async (base, getPromptCalls, sse) => {
        const projectId = await createProject(base, sse, fileDir);

        const promptP = fetch(`${base}/api/agents/${encodeURIComponent(projectId)}/s-img/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentName: "dev",
            text: "看这张图",
            model: "test-provider/test-model",
            attachments: [{ kind: "image", name: "shot.png", path: imgPath, size: 0 }],
          }),
        });
        const sseEv = await sse.next();
        expect(sseEv.type).toBe("session:created");
        await promptP;

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

  it("fs:copy 对文件夹直接返回原始真实路径，不再创建软链接", async () => {
    const fileDir = makeTempDir("wa-pi-copy-folder-");
    const sourceDir = join(fileDir, "big-data");
    mkdirSync(sourceDir);
    writeFileSync(join(sourceDir, "data.txt"), "folder content");

    try {
      await withComposerServer(async (base, _getPromptCalls, sse) => {
        const projectId = await createProject(base, sse, fileDir);

        const res = await fetch(`${base}/api/fs/copy`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, source: sourceDir }),
        });
        const resp = await res.json();
        expect(resp.type).toBe("fs:copy");
        expect(resp.error).toBeUndefined();
        expect(resp.path).toBe(sourceDir);
        expect(existsSync(resp.path)).toBe(true);
        expect(readFileSync(join(resp.path, "data.txt"), "utf8")).toBe("folder content");
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("agent:prompt 携带 folder 附件时，最终 prompt 文本包含 @相对路径引用", async () => {
    const fileDir = makeTempDir("wa-pi-folder-attach-");
    const sourceDir = join(fileDir, "docs");
    mkdirSync(sourceDir);

    try {
      await withComposerServer(async (base, getPromptCalls, sse) => {
        const projectId = await createProject(base, sse, fileDir);

        const copyRes = await fetch(`${base}/api/fs/copy`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, source: sourceDir }),
        });
        const copied = await copyRes.json();
        const folderPath = copied.path as string;

        const promptP = fetch(`${base}/api/agents/${encodeURIComponent(projectId)}/s-folder/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agentName: "dev",
            text: "看这个项目文档",
            model: "test-provider/test-model",
            attachments: [{ kind: "folder", name: "docs", path: folderPath }],
          }),
        });
        const sseEv = await sse.next();
        expect(sseEv.type).toBe("session:created");
        await promptP;

        await waitFor(() => getPromptCalls().length > 0);

        const calls = getPromptCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0].text).toContain("看这个项目文档");
        expect(calls[0].text).toContain("Attachments:");
        expect(calls[0].text).toContain("[@docs]");
      });
    } finally {
      rmSync(fileDir, { recursive: true, force: true });
    }
  });
});
