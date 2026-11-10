// 知识库 HTTP 路由测试（任务 10）
//
// 不启动完整 kernel（不调 startKernel，WA_PI_DIR 不受污染——与 memory-routes.test.ts 同款做法）：
// 真实 WSServer（进程内，port 0）：HTTP → callApi → handle 分发 → KnowledgeStore / indexer。
// 嵌入注入 gate embed（阻塞式 fake，768 维全 128）绕开真实模型——
// 控制者裁决：routes 测试只断言响应结构与 indexing_jobs 行创建，不等待真实索引耗时；
// 「最终 ready」语义由 knowledge-indexer.test.ts（任务 6）承载。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ConfigStore } from "../src/config-store";
import { ProjectStore } from "../src/project-store";
import { ProviderStore } from "../src/provider-store";
import { SkillManager } from "../src/skill-manager";
import { ExtensionManager } from "../src/extension-manager";
import { MemoryStore } from "../src/memory-store";
import { closeAllMemoryDbs } from "../src/memory/db";
import { WSServer, type WSServerOpts } from "../src/ws-server";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore } from "../src/knowledge/store";
import { closeAllKbDbs } from "../src/knowledge/kb-db";
import { kbDbPath } from "../src/knowledge/paths";
import type { EmbedFn } from "../src/knowledge/indexer";
import type { WatchKbOptions } from "../src/knowledge/watcher";
import { EMBED_DIM } from "../src/memory/schema";
import { loadSubagentOverrides, saveSubagentOverride } from "../src/subagent-store";
import { removeKbBinding } from "../src/agent-manager";

let tmpDir: string;
let waPiDir: string;
let srcDir: string;
let reg: Database;
let store: KnowledgeStore;
let overridesFile: string;
// 运行登记清理句柄：ready 收尾会自动挂 watcher（fs.watch 句柄挂着 Windows rmSync 会 EBUSY），
// afterEach 统一拆掉（含测试中途已 detach 的，幂等）
let activeServer: WSServer | null = null;

/** 阻塞式 fake embed：首次调用挂起，直到测试 resolveAll/rejectAll；放行后未来调用直接完成 */
function makeGateEmbed() {
  let pending: {
    n: number;
    resolve: (v: Uint8Array[]) => void;
    reject: (e: Error) => void;
  } | null = null;
  let closed = false;
  let resolveMode = false;
  let holdMode = false; // hold：后续 embed 调用重新挂起（ready 后再卡住 watcher 源索引用）
  const fakeVecs = (n: number) =>
    Array.from({ length: n }, () => new Uint8Array(EMBED_DIM).fill(128));
  return {
    embed: (texts: string[]): Promise<Uint8Array[]> => {
      if (!holdMode && closed && resolveMode) return Promise.resolve(fakeVecs(texts.length));
      return new Promise((resolve, reject) => {
        if (closed && !holdMode) {
          reject(new Error("测试收尾：gate 已关闭"));
          return;
        }
        pending = { n: texts.length, resolve, reject };
      });
    },
    /** 放行后重新挂起后续调用（watcher 触发的索引要卡在 embed 才能测 cancel） */
    hold: () => {
      holdMode = true;
    },
    /** 放行当前挂起批次与后续调用（fake 向量），索引正常完成收尾 */
    resolveAll: () => {
      closed = true;
      resolveMode = true;
      const p = pending;
      pending = null;
      p?.resolve(fakeVecs(p.n));
    },
    /** 以错误放行（模拟取消后的断出），让阻塞中的 runIndex 走收尾并释放 db 句柄 */
    rejectAll: () => {
      closed = true;
      resolveMode = false;
      const p = pending;
      pending = null;
      p?.reject(new Error("测试收尾：gate 已关闭"));
    },
  };
}
let gate = makeGateEmbed();

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "kb-routes-"));
  waPiDir = join(tmpDir, "wapidir");
  mkdirSync(waPiDir, { recursive: true });
  srcDir = mkdtempSync(join(tmpdir(), "kb-routes-src-"));
  writeFileSync(join(srcDir, "a.md"), "# 标题一\n\n内容甲。\n\n# 标题二\n\n内容乙。");
  reg = new Database(join(waPiDir, "knowledge.db"));
  reg.run(KB_SCHEMA_SQL);
  store = new KnowledgeStore(reg, waPiDir);
  overridesFile = join(tmpDir, "subagent-overrides.json");
  gate = makeGateEmbed();
});

afterEach(async () => {
  closeAllKbDbs(); // 每库连接归缓存所有，用例间必须归位
  // 先拆文件监听（fs.watch 句柄挂着 Windows 删不掉临时目录），再让阻塞中的 runIndex 退出
  // 收尾（释放每库 db 句柄），最后删临时目录
  activeServer?.kbWatchStopAll();
  activeServer = null;
  gate.rejectAll();
  await new Promise((r) => setTimeout(r, 200)); // 等 runIndex 取消/失败收尾链跑完（释放每库 db 句柄）
  reg.close();
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

/** 起最小 WSServer：知识库登记库与 gate embed 注入（生产路径缺省用 agentManager 共享实例） */
async function startTestServer(kbWatchOpts?: WatchKbOptions) {
  const projectFile = join(tmpDir, "projects.json");
  writeFileSync(
    projectFile,
    JSON.stringify({
      projects: [{ id: "p1", name: "test", cwd: "/repos/my-app", createdAt: Date.now() }],
      sessions: [],
    }),
    "utf8",
  );
  const dataDir = join(tmpDir, "data");
  mkdirSync(dataDir, { recursive: true });
  const opts: WSServerOpts = {
    configStore: new ConfigStore(join(tmpDir, "config")),
    projectStore: new ProjectStore(projectFile),
    providerStore: new ProviderStore(join(tmpDir, "providers.json")),
    skillManager: new SkillManager(join(tmpDir, "skills")),
    extensionManager: new ExtensionManager(dataDir),
    memoryStore: new MemoryStore({
      waPiDir: tmpDir,
      projectStore: new ProjectStore(projectFile),
    }),
    dataDir,
    knowledgeStore: store,
    kbEmbedFn: gate.embed,
    kbWatchOpts,
    agentManager: { disposeAll: async () => {}, markAllDirty: () => {} } as any,
    channelManager: null,
    port: 0,
  };
  const server = new WSServer(opts);
  await server.start();
  activeServer = server;
  return { server, port: server.actualPort };
}

/** 轮询等待条件成立（异步索引收尾用，cond 可为 async）；超时抛错 */
async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  stepMs = 10,
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function api(port: number, method: string, path: string, body?: unknown) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ===== 1. GET /api/knowledge 列出登记库（含每库 progress）=====

test("GET /api/knowledge 列出登记库", async () => {
  const kbA = store.createKb({ folderPath: srcDir, name: "库甲", description: "描述甲" });
  const kbB = store.createKb({ folderPath: srcDir, name: "库乙" });
  // 库甲造一个进行中 job：listKbs 读 indexing_jobs 投影出 progress
  store.startJob(kbA.id, "scanning");
  store.updateJobProgress(kbA.id, { filesTotal: 3, filesDone: 1 });

  const { port } = await startTestServer();
  const res = await api(port, "GET", "/api/knowledge");
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.type).toBe("knowledge:list");
  expect(body.kbs).toHaveLength(2);
  for (const kb of body.kbs as any[]) {
    expect(typeof kb.id).toBe("string");
    expect(typeof kb.name).toBe("string");
    expect(typeof kb.description).toBe("string");
    expect(typeof kb.folderPath).toBe("string");
    expect(["scanning", "indexing", "ready", "error"]).toContain(kb.status);
    expect(typeof kb.fileCount).toBe("number");
    expect(typeof kb.chunkCount).toBe("number");
    expect(typeof kb.failedCount).toBe("number");
    expect(typeof kb.autoWatch).toBe("boolean");
    expect(kb.lastIndexedAt === null || typeof kb.lastIndexedAt === "number").toBe(true);
  }
  const withJob = (body.kbs as any[]).find((k) => k.id === kbA.id);
  const withoutJob = (body.kbs as any[]).find((k) => k.id === kbB.id);
  // 有进行中 job 的库带实时 progress（读 indexing_jobs），无 job 的库 progress 缺省
  expect(withJob.progress).toEqual({
    phase: "scanning",
    filesTotal: 3,
    filesDone: 1,
    chunksDone: 0,
    chunksTotal: 0,
  });
  expect(withoutJob.progress).toBeUndefined();
});

// ===== 2. POST /api/knowledge/preview 返回扫描预览 =====

test("POST /api/knowledge/preview 返回扫描预览", async () => {
  writeFileSync(join(srcDir, "notes.txt"), "纯文本内容。");
  writeFileSync(join(srcDir, ".DS_Store"), "junk");
  const { port } = await startTestServer();
  const res = await api(port, "POST", "/api/knowledge/preview", {
    folderPath: srcDir,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.type).toBe("knowledge:preview");
  expect(body.preview.totalFiles).toBe(2); // 夹具 beforeEach 的 a.md + notes.txt
  expect(body.preview.totalBytes).toBeGreaterThan(0);
  const dsStore = body.preview.skippable.find((s: any) => s.path === ".DS_Store");
  expect(dsStore.reason).toBe("suggested_excluded");

  // 错误路径：缺 folderPath → 400
  const bad = await api(port, "POST", "/api/knowledge/preview", {});
  expect(bad.status).toBe(400);
});

// ===== 2b. 预览计划令牌：创建时报告预览后目录变化（任务 9，S13）=====

test("preview 回包带 planToken；预览后目录变动，create 回包 planChanged 列出新增/减少", async () => {
  const { port } = await startTestServer();
  const preview = (await (
    await api(port, "POST", "/api/knowledge/preview", { folderPath: srcDir })
  ).json()) as any;
  expect(typeof preview.planToken).toBe("string");
  // 预览之后目录变动：删一个、加一个
  rmSync(join(srcDir, "a.md"));
  writeFileSync(join(srcDir, "added.md"), "# 新增文件");

  const res = await api(port, "POST", "/api/knowledge", {
    folderPath: srcDir,
    name: "变化库",
    planToken: preview.planToken,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  // 不阻断创建：库照建，只在回包里补差异
  expect(body.type).toBe("knowledge:create");
  expect(body.kb.name).toBe("变化库");
  expect(body.planChanged).toEqual({ added: ["added.md"], removed: ["a.md"] });
});

test("preview → create 目录未变：回包不含 planChanged", async () => {
  const { port } = await startTestServer();
  const preview = (await (
    await api(port, "POST", "/api/knowledge/preview", { folderPath: srcDir })
  ).json()) as any;
  const res = await api(port, "POST", "/api/knowledge", {
    folderPath: srcDir,
    planToken: preview.planToken,
  });
  const body = (await res.json()) as any;
  expect(body.type).toBe("knowledge:create");
  expect(body.planChanged).toBeUndefined();
});

test("planToken 无效或缺失：不阻断创建，回包不含 planChanged", async () => {
  const { port } = await startTestServer();
  const bad = await api(port, "POST", "/api/knowledge", {
    folderPath: srcDir,
    planToken: "not-a-real-token",
  });
  expect(bad.status).toBe(200);
  const badBody = (await bad.json()) as any;
  expect(badBody.type).toBe("knowledge:create");
  expect(badBody.planChanged).toBeUndefined();

  const none = await api(port, "POST", "/api/knowledge", { folderPath: srcDir });
  const noneBody = (await none.json()) as any;
  expect(noneBody.type).toBe("knowledge:create");
  expect(noneBody.planChanged).toBeUndefined();
});

// ===== 3. POST /api/knowledge 创建并触发索引 =====

test("POST /api/knowledge 创建并触发索引", async () => {
  const { port } = await startTestServer();
  const res = await api(port, "POST", "/api/knowledge", {
    folderPath: srcDir,
    name: "测试库",
    description: "自定义描述",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.type).toBe("knowledge:create");
  const kb = body.kb;
  // KbInfo 结构（控制者裁决：只断言响应结构 + job 行创建，不等索引完成）
  expect(typeof kb.id).toBe("string");
  expect(kb.name).toBe("测试库");
  expect(kb.description).toBe("自定义描述");
  expect(kb.folderPath).toBe(srcDir);
  expect(kb.status).toBe("scanning");
  expect(kb.fileCount).toBe(0);
  expect(kb.chunkCount).toBe(0);
  expect(kb.failedCount).toBe(0);
  expect(kb.autoWatch).toBe(true);
  expect(kb.lastIndexedAt).toBeNull();
  // 索引已异步触发：indexing_jobs 行创建（runIndex 同步前缀 startJob 先于响应返回）
  expect(store.getJob(kb.id)).not.toBeNull();

  // 错误路径：目录不存在 → 400
  const bad = await api(port, "POST", "/api/knowledge", {
    folderPath: join(tmpDir, "no-such-dir"),
  });
  expect(bad.status).toBe(400);
});

// ===== 3b. folderPath 归一：相对路径转绝对，~ 不做展开 =====

test("POST /api/knowledge 相对路径归一为绝对路径入库", async () => {
  const { port } = await startTestServer();
  // 库根必须绝对：相对路径在索引期会随 cwd 漂移，且检索时的路径前缀校验需要绝对根
  const rel = relative(process.cwd(), srcDir);
  const res = await api(port, "POST", "/api/knowledge", { folderPath: `  ${rel}  ` });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.kb.folderPath).toBe(srcDir);
});

test("POST /api/knowledge 拒绝 ~ 开头的路径（不替 shell 做展开）", async () => {
  const { port } = await startTestServer();
  const res = await api(port, "POST", "/api/knowledge", { folderPath: "~/docs" });
  expect(res.status).toBe(400);
  const body = (await res.json()) as any;
  expect(String(body.error)).toContain("绝对路径");
  // 不入库：没有任何库根带 ~
  expect(store.listKbs().some((k) => k.folderPath.includes("~"))).toBe(false);
});

// ===== 4. POST /api/knowledge/:id/cancel 取消索引 =====

test("POST /api/knowledge/:id/cancel 取消索引", async () => {
  const { port } = await startTestServer();
  const created = (await (
    await api(port, "POST", "/api/knowledge", { folderPath: srcDir })
  ).json()) as any;
  const kbId = created.kb.id as string;
  expect(store.getJob(kbId)).not.toBeNull();

  const res = await api(port, "POST", `/api/knowledge/${kbId}/cancel`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.type).toBe("knowledge:cancel");
  // gate 以错误放行 → runIndex 走取消路径（signal.aborted）：job 删除、状态恢复 scanning
  gate.rejectAll();
  await waitFor(() => store.getJob(kbId) === null);
  expect(store.getKb(kbId)!.status).toBe("scanning");

  // 错误路径：无进行中任务时取消 → 400
  const bad = await api(port, "POST", `/api/knowledge/${kbId}/cancel`);
  expect(bad.status).toBe(400);
});

// ===== 5. DELETE /api/knowledge/:id 删除并清理文件 =====

test("DELETE /api/knowledge/:id 删除并清理文件", async () => {
  const { port } = await startTestServer();
  const created = (await (
    await api(port, "POST", "/api/knowledge", { folderPath: srcDir })
  ).json()) as any;
  const kbId = created.kb.id as string;
  // 先让索引完成（gate 放行）——删除需要每库 db 句柄已释放（Windows 文件占用）
  gate.resolveAll();
  await waitFor(() => store.getKb(kbId)!.status === "ready");
  expect(existsSync(kbDbPath(waPiDir, kbId))).toBe(true);

  const res = await api(port, "DELETE", `/api/knowledge/${kbId}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.type).toBe("knowledge:delete");
  expect(store.getKb(kbId)).toBeNull();
  expect(store.getJob(kbId)).toBeNull();
  // 级联清理：每库独立 db 文件已删
  expect(existsSync(kbDbPath(waPiDir, kbId))).toBe(false);

  // 错误路径：删除不存在的库 → 400
  const bad = await api(port, "DELETE", `/api/knowledge/${kbId}`);
  expect(bad.status).toBe(400);
});

// ===== 6. PUT /api/knowledge/:id 更新名称/描述/autoWatch =====

test("PUT /api/knowledge/:id 更新名称/描述/autoWatch", async () => {
  const kb = store.createKb({ folderPath: srcDir, name: "旧名", description: "旧描述" });
  const { port } = await startTestServer();
  const res = await api(port, "PUT", `/api/knowledge/${kb.id}`, {
    name: "新名",
    description: "新描述",
    autoWatch: false,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.type).toBe("knowledge:update");
  expect(body.kb.name).toBe("新名");
  expect(body.kb.description).toBe("新描述");
  expect(body.kb.autoWatch).toBe(false);
  // 落库可查（再次列表确认）
  const listed = (await (await api(port, "GET", "/api/knowledge")).json()) as any;
  const updated = listed.kbs.find((k: any) => k.id === kb.id);
  expect(updated.name).toBe("新名");
  expect(updated.autoWatch).toBe(false);

  // 错误路径：更新不存在的库 → 400
  const bad = await api(port, "PUT", "/api/knowledge/nope", { name: "x" });
  expect(bad.status).toBe(400);
});

// ===== 7. GET /api/knowledge/:id/failed 列出失败文件清单 =====

test("GET /api/knowledge/:id/failed 列出失败文件清单", async () => {
  // 伪装 docx（纯文本内容）：扫描可索引，抽取阶段失败 → extraction_failed
  writeFileSync(join(srcDir, "bad.docx"), "这不是一个合法的 docx（非 zip 结构）");
  const { port } = await startTestServer();
  const created = (await (
    await api(port, "POST", "/api/knowledge", { folderPath: srcDir })
  ).json()) as any;
  const kbId = created.kb.id as string;
  gate.resolveAll();
  await waitFor(() => store.getKb(kbId)!.status === "ready");

  const res = await api(port, "GET", `/api/knowledge/${kbId}/failed`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.type).toBe("knowledge:failed");
  expect(body.failures).toHaveLength(1);
  expect(body.failures[0].path).toBe("bad.docx");
  expect(typeof body.failures[0].reason).toBe("string");
  expect(body.failures[0].reason.length).toBeGreaterThan(0);
  // 成功文件不在失败清单；登记行 failed_count 与之一致
  expect((store.getKb(kbId)!).failedCount).toBe(1);
});

// ===== 9. 每库 db 打不开时索引失败不卡死：job 清理 + status error + 可重新 index =====

// 审查修复回归：openKbDb 原在 runIndex 主体 try 之外，损坏的每库 db 文件会让
// startJob 之后直接 throw——job 行残留、status 卡 indexing、cancel/delete/index
// 三条恢复路径全灭且重启不恢复。修复后必须走统一失败收尾。
test("每库 db 损坏时索引失败可恢复（job 清理、status error、重试成功）", async () => {
  const kb = store.createKb({ folderPath: srcDir, name: "坏库" });
  // 预写损坏的每库 db 文件：openKbDb 首句 PRAGMA journal_mode=WAL 对非 sqlite 文件必抛
  writeFileSync(kbDbPath(waPiDir, kb.id), "这不是一个 sqlite 数据库文件");
  const { port } = await startTestServer();
  const res = await api(port, "POST", `/api/knowledge/${kb.id}/index`);
  expect(res.status).toBe(200); // 异步触发，响应不等索引结果
  // 失败收尾：job 行清理、status 回退 error（首次建库计数归零可见失败）
  await waitFor(() => store.getJob(kb.id) === null);
  expect(store.getKb(kb.id)!.status).toBe("error");
  expect(store.getKb(kb.id)!.fileCount).toBe(0);

  // 恢复路径：排除坏文件后重新 index 可正常完成
  rmSync(kbDbPath(waPiDir, kb.id));
  const res2 = await api(port, "POST", `/api/knowledge/${kb.id}/index`);
  expect(res2.status).toBe(200);
  gate.resolveAll();
  await waitFor(() => store.getKb(kb.id)!.status === "ready");
  expect(store.getJob(kb.id)).toBeNull();
});

// ===== 8. 端到端：DELETE 后清理智能体绑定中的悬挂引用（任务 9 次要①补测）=====
// routes 复用 agent-manager 注册过 onKbDeleted 回调的同一 store 实例时，
// 删库回调触发 removeKbBinding：overrides 文件里该 kbId 被移除。

test("DELETE 后清理智能体绑定中的悬挂引用", async () => {
  const kb = store.createKb({ folderPath: srcDir, name: "绑定库" });
  // 与 agent-manager.ts getKnowledgeStore 相同的接线：注册 removeKbBinding 回调
  store.setOnKbDeleted((id) => {
    void removeKbBinding(id, { overridesFile });
  });
  await saveSubagentOverride(overridesFile, {
    type: "coder",
    knowledgeBaseIds: [kb.id],
  });
  const { port } = await startTestServer();
  const res = await api(port, "DELETE", `/api/knowledge/${kb.id}`);
  expect(res.status).toBe(200);
  // 回调是 void promise：轮询直到 overrides 文件里的悬挂引用被清
  await waitFor(async () => {
    const overrides = await loadSubagentOverrides(overridesFile);
    return !overrides.some((o) => o.knowledgeBaseIds?.includes(kb.id));
  });
  const overrides = await loadSubagentOverrides(overridesFile);
  // 悬挂引用已清：knowledgeBaseIds 不再含该 id（空数组记录保留——removeKbBinding 只重写含该 id 的记录）
  expect(overrides.every((o) => !o.knowledgeBaseIds?.includes(kb.id))).toBe(true);
});

// ===== 10. 运行登记接线（最终审查修复）：ready 收尾挂监听 / autoWatch 开关 / delete 拆监听 / cancel 覆盖 watcher 源 =====

/** 类型缩写：运行登记表条目（ws-server 私有字段，测试经 any 桥接观察） */
type KbRunEntry = { watch: { stopped: boolean; indexing: boolean } | null; abort: AbortController | null };

async function createAndWaitReady(port: number): Promise<string> {
  const created = (await (
    await api(port, "POST", "/api/knowledge", { folderPath: srcDir })
  ).json()) as any;
  gate.resolveAll();
  await waitFor(() => store.getKb(created.kb.id)!.status === "ready");
  return created.kb.id as string;
}

test("索引 ready 后 watcher 挂入运行登记；autoWatch 开关切换 attach/detach", async () => {
  const { server, port } = await startTestServer();
  const kbId = await createAndWaitReady(port);
  const runs = (server as any).kbRuns as Map<string, KbRunEntry>;
  // ready 收尾自动挂监听（修复前：运行期创建的库永不挂监听，自动更新主流程失效）
  await waitFor(() => runs.get(kbId)?.watch != null);
  const first = runs.get(kbId)!.watch!;
  expect(first.stopped).toBe(false);

  // autoWatch 关 → 同步拆监听清登记
  const off = await api(port, "PUT", `/api/knowledge/${kbId}`, { autoWatch: false });
  expect(off.status).toBe(200);
  expect(runs.get(kbId)).toBeUndefined();
  expect(first.stopped).toBe(true);

  // autoWatch 开 → 重新 attach（新 watcher，状态仍 ready）
  const on = await api(port, "PUT", `/api/knowledge/${kbId}`, { autoWatch: true });
  expect(on.status).toBe(200);
  expect(runs.get(kbId)?.watch != null).toBe(true);
  expect(runs.get(kbId)!.watch!.stopped).toBe(false);
});

test("delete 同步拆监听清登记（无孤儿 watcher 轮询到重启）", async () => {
  const { server, port } = await startTestServer();
  const kbId = await createAndWaitReady(port);
  const runs = (server as any).kbRuns as Map<string, KbRunEntry>;
  await waitFor(() => runs.get(kbId)?.watch != null);
  const watch = runs.get(kbId)!.watch!;

  const res = await api(port, "DELETE", `/api/knowledge/${kbId}`);
  expect(res.status).toBe(200);
  expect(store.getKb(kbId)).toBeNull();
  expect(runs.get(kbId)).toBeUndefined();
  // 监听+轮询已关：不再 60s 轮询+反复 warn
  expect(watch.stopped).toBe(true);
});

test("watcher 触发的自动索引可被 cancel 端点取消（watcher 存活）", async () => {
  // 注入加速轮询/防抖：60s/2s 默认值下测试等不起
  const { server, port } = await startTestServer({ pollIntervalMs: 50, debounceMs: 20 });
  const kbId = await createAndWaitReady(port);
  const runs = (server as any).kbRuns as Map<string, KbRunEntry>;
  await waitFor(() => runs.get(kbId)?.watch != null);
  const entry = runs.get(kbId)!;

  // 目录变更 → 轮询兑底（加速后 50ms）发现 → 防抖（20ms）→ watcher 触发 runIndex；
  // gate 先 hold 住让那轮索引稳定卡在 embed（否则 resolveMode 下毫秒级跑完捕捉不到 job 行）。
  // 先睡过一个轮询周期：等 attach 时异步拍的基线快照就绪，否则写文件会被吞进初始基线（无差异不触发）
  gate.hold();
  await new Promise((r) => setTimeout(r, 150));
  writeFileSync(join(srcDir, "late.md"), "# 迟到\n\n监听触发的新内容。");
  await waitFor(() => store.getJob(kbId) !== null, 5000);
  // watcher 源索引：abort 登记为空（不走 startKbIndex），修复前 cancel 端点查不到、无法取消
  expect(entry.abort).toBeNull();
  expect(entry.watch!.indexing).toBe(true);

  const res = await api(port, "POST", `/api/knowledge/${kbId}/cancel`);
  expect(res.status).toBe(200);
  gate.rejectAll(); // 放行阻塞中的 embed → runIndex 走取消收尾
  await waitFor(() => store.getJob(kbId) === null);
  expect(store.getKb(kbId)!.status).toBe("ready"); // 取消恢复原状态
  // 只中止当前轮：watcher 存活，后续变更照常触发
  await waitFor(() => entry.watch!.indexing === false);
  expect(entry.watch!.stopped).toBe(false);
});
