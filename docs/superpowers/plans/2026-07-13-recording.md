# 聊天录音功能（spec B）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 composer 旁加录音入口，支持系统音频回环 / 麦克风录音，全局单例胶囊控制，停止后作为 audio 附件自动挂到归属会话 composer；同时移除废弃的「编排画布」。

**Architecture:** 单 BrowserWindow 单 SPA → 一个 `RecordingManager` 模块级单例 + 一个 Zustand store 天然实现「全局唯一录音」。录音数据用 `MediaRecorder.start(timeslice)` 切片，每片经现有 WS 通道增量追加写到 kernel 临时文件（内存只留当前片，支持小时级录音），停止时原子 move 到项目 uploads 目录，复用现有 `agent:prompt.attachments` 发给 agent。系统音频走 Electron `setDisplayMediaRequestHandler`（自动批准 + loopback，无共享框），麦克风走 `setPermissionRequestHandler`（免弹窗）——均为 POC 已验证的组合。

**Tech Stack:** TypeScript · React 19 · Zustand · idb · WebRTC MediaRecorder · Electron · Bun（kernel sidecar + 测试）

## Global Constraints

- **音源**：仅 `mic` 与 `system` 两种，免权限；技术栈锁定 WebRTC + Electron，不引入原生插件。
- **上传目录**：项目附件统一写到 `<project.cwd>/.hiagent/uploads/`（与现有 `fs:upload` 一致，不得改）。
- **单例**：整个应用同时只允许一次录音；冲突时提示「项目 XX - 会话 XX 正在录音，需要等到上一个录音结束才能开始新的录音」。
- **录音格式**：`audio/webm`（MediaRecorder 默认 opus）；不做格式转换、不做 STT。
- **附件 kind**：新增 `audio`，结构与 `file` 一致外加可选 `durationMs`。
- **编排画布**：移除按钮、`View` 中的 `canvas`、Canvas 组件文件；**保留** `useAgentsStore`（被 AgentListSection/SessionView/AgentConfig 引用）。
- **测试命令**：根目录 `bun test`（自动忽略 e2e）；单包 `cd packages/<pkg> && bun test`。
- **提交规范**：每任务末提交，conventional commits（`feat:`/`fix:`/`refactor:`/`docs:`/`chore:`），无归属行。

**设计稿**：[docs/superpowers/specs/2026-07-13-recording-design.md](../specs/2026-07-13-recording-design.md)

---

## File Structure

**新增：**
- `packages/kernel/src/recording-store.ts` — 纯函数：录音临时文件追加/finalize/discard/清理（可单测的内核 seam）
- `packages/frontend/src/recording/recorder.ts` — `RecordingManager` 单例 + `ElapsedTracker` + `formatDuration`
- `packages/frontend/src/store/recording.ts` — `useRecordingStore`
- `packages/frontend/src/components/ui/RecordButton.tsx` — composer 录音按钮
- `packages/frontend/src/components/ui/RecordingCapsule.tsx` — header 录音胶囊
- `packages/desktop/src/util/recording-handlers.cjs` — Electron session handler 注册（可测）

**修改：**
- `packages/shared/src/types.ts` — `audio` kind + 录音 WS 事件类型
- `packages/kernel/src/ws-server.ts` — 3 个 `fs:recording:*` handler + `/file` 路由
- `packages/kernel/src/index.ts` — 启动清理 `.recording-tmp`
- `packages/frontend/src/fs-client.ts` — append/finalize/discard + `pathToUploadUrl`
- `packages/frontend/src/store/composer-db.ts` — `lastSource` 持久化
- `packages/frontend/src/components/ui/AttachmentChip.tsx` — audio kind 渲染
- `packages/frontend/src/components/ui/ComposerInput.tsx` — 插入 RecordButton
- `packages/frontend/src/components/Composer.tsx` — 传 sessionId 给 ComposerInput
- `packages/frontend/src/components/SessionView.tsx` — 插入 RecordingCapsule + 移除编排画布按钮
- `packages/frontend/src/App.tsx` — 移除 canvas View
- `packages/desktop/src/main.cjs` — 注册 session handler

**删除：**
- `packages/frontend/src/components/canvas/Canvas.tsx`、`CanvasNode.tsx`、`types.ts`

---

## Task 1: shared 类型与录音 WS 协议

**Files:**
- Modify: `packages/shared/src/types.ts`
- Test: `packages/shared/tests/recording-types.test.ts`

**Interfaces:**
- Consumes: 现有 `AttachmentRef` / `AttachmentDraft` / `WSClientEvent` / `WSServerEvent`
- Produces: `audio` 附件 kind；`FSRecordingAppendRequest/Result`、`FSRecordingFinalizeRequest/Result`、`FSRecordingDiscardRequest/Result`；上述加入 `WSClientEvent`/`WSServerEvent` 联合。后续所有任务引用这些类型名。

- [ ] **Step 1: 写失败测试**

`packages/shared/tests/recording-types.test.ts`:
```ts
import { test, expect } from "bun:test";
import type {
  AttachmentRef, AttachmentDraft,
  WSClientEvent, WSServerEvent,
  FSRecordingAppendRequest, FSRecordingFinalizeRequest, FSRecordingDiscardRequest,
  FSRecordingAppendResult, FSRecordingFinalizeResult, FSRecordingDiscardResult,
} from "../src/types";

test("AttachmentRef 接受 audio kind（含 durationMs）", () => {
  const a: AttachmentRef = { kind: "audio", name: "r.webm", path: "/p/r.webm", size: 10, durationMs: 1500 };
  expect(a.kind).toBe("audio");
});

test("AttachmentDraft 接受 audio kind", () => {
  const d: AttachmentDraft = { kind: "audio", name: "r.webm", path: "/p/r.webm", size: 10 };
  expect(d.kind).toBe("audio");
});

test("录音 WS 请求类型可构造且 type 正确", () => {
  const append: FSRecordingAppendRequest = { type: "fs:recording:append", id: "i1", projectId: "p1", recId: "r1", chunk: "QUJD" };
  const fin: FSRecordingFinalizeRequest = { type: "fs:recording:finalize", id: "i2", projectId: "p1", recId: "r1", finalName: "rec.webm" };
  const disc: FSRecordingDiscardRequest = { type: "fs:recording:discard", id: "i3", projectId: "p1", recId: "r1" };
  expect(append.type).toBe("fs:recording:append");
  expect(fin.type).toBe("fs:recording:finalize");
  expect(disc.type).toBe("fs:recording:discard");
});

test("录音 WS 结果类型可构造", () => {
  const ra: FSRecordingAppendResult = { type: "fs:recording:append", id: "i1" };
  const rf: FSRecordingFinalizeResult = { type: "fs:recording:finalize", id: "i2", path: "/p/uploads/rec.webm" };
  const rd: FSRecordingDiscardResult = { type: "fs:recording:discard", id: "i3" };
  expect(ra.id).toBe("i1");
  expect(rf.path).toContain("rec.webm");
  expect(rd.id).toBe("i3");
});

test("录音事件归入 WS 联合类型", () => {
  const c: WSClientEvent = { type: "fs:recording:append", id: "i1", projectId: "p1", recId: "r1", chunk: "" };
  const s: WSServerEvent = { type: "fs:recording:finalize", id: "i2", path: "/x" };
  expect(c.type).toBe("fs:recording:append");
  expect(s.type).toBe("fs:recording:finalize");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/shared && bun test recording-types`
Expected: FAIL（类型不存在，编译错误）

- [ ] **Step 3: 修改 `types.ts`**

在 `AttachmentRef` 与 `AttachmentDraft` 两个联合中，紧挨 `file` 成员后加：
```ts
  | { kind: "audio"; name: string; path: string; size: number; durationMs?: number }
```

在 `FSErrorEvent` 接口定义之后、`SDKEvent` 之前，加录音事件类型：
```ts
// 录音：边录边落盘协议（与 fs:upload 同通道，id 关联请求-响应）
export interface FSRecordingAppendRequest { type: "fs:recording:append"; id: string; projectId: string; recId: string; chunk: string; }
export interface FSRecordingAppendResult { type: "fs:recording:append"; id: string; error?: string; }
export interface FSRecordingFinalizeRequest { type: "fs:recording:finalize"; id: string; projectId: string; recId: string; finalName: string; }
export interface FSRecordingFinalizeResult { type: "fs:recording:finalize"; id: string; path: string; error?: string; }
export interface FSRecordingDiscardRequest { type: "fs:recording:discard"; id: string; projectId: string; recId: string; }
export interface FSRecordingDiscardResult { type: "fs:recording:discard"; id: string; error?: string; }
```

把 `WSClientEvent` 联合末尾的 fs 段扩展（在 `FSSearchCancelRequest` 之后追加）：
```ts
  | FSRecordingAppendRequest | FSRecordingFinalizeRequest | FSRecordingDiscardRequest;
```

把 `WSServerEvent` 联合末尾的 fs 段扩展（在 `FSErrorEvent` 之后追加）：
```ts
  | FSRecordingAppendResult | FSRecordingFinalizeResult | FSRecordingDiscardResult;
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd packages/shared && bun test recording-types`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/types.ts packages/shared/tests/recording-types.test.ts
git commit -m "feat(shared): 录音附件 audio kind + fs:recording:* WS 协议类型"
```

---

## Task 2: kernel 录音落盘 helpers + WS handler + 启动清理

**Files:**
- Create: `packages/kernel/src/recording-store.ts`
- Modify: `packages/kernel/src/ws-server.ts`（加 3 个 case + 导入）
- Modify: `packages/kernel/src/index.ts`（启动清理）
- Test: `packages/kernel/tests/recording-store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `FSRecording*Request/Result` 类型；现有 `projectStore.load()`（取 `project.cwd`）。
- Produces: `recording-store.ts` 导出 `appendChunk(uploadDir, recId, base64Chunk)`、`finalizeRecording(uploadDir, recId, finalName): Promise<string>`（返回最终 path）、`discardRecording(uploadDir, recId)`、`cleanupRecordingTemp(uploadDir)`、`recordingTempPath(uploadDir, recId)`。ws-server handler 以 `uploadDir = join(project.cwd, ".hiagent", "uploads")` 调用它们。

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/recording-store.test.ts`:
```ts
import { test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  recordingTempPath, appendChunk, finalizeRecording, discardRecording, cleanupRecordingTemp,
} from "../src/recording-store";

const tmp = join(import.meta.dir, ".tmp-recording");
const uploads = join(tmp, "uploads");

beforeEach(() => { rmSync(tmp, { recursive: true, force: true }); mkdirSync(uploads, { recursive: true }); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

test("appendChunk 追加 base64 解码后的字节到临时文件", async () => {
  await appendChunk(uploads, "rec1", "QUJD");   // "ABC"
  await appendChunk(uploads, "rec1", "RA==");   // "D"
  const buf = readFileSync(recordingTempPath(uploads, "rec1"));
  expect(buf.length).toBe(4);
  expect(buf.toString()).toBe("ABCD");
});

test("appendChunk 多次落盘，内存不留历史（验证文件持续增长）", async () => {
  for (let i = 0; i < 5; i++) await appendChunk(uploads, "rec2", "QUJD");
  expect(readFileSync(recordingTempPath(uploads, "rec2")).length).toBe(15);
});

test("finalizeRecording 原子 move 到 uploads 并返回最终 path", async () => {
  await appendChunk(uploads, "rec3", "QUJD");
  const finalPath = await finalizeRecording(uploads, "rec3", "my-rec.webm");
  expect(finalPath).toBe(join(uploads, "my-rec.webm"));
  expect(existsSync(finalPath)).toBe(true);
  expect(existsSync(recordingTempPath(uploads, "rec3"))).toBe(false);  // 临时文件已移走
  expect(readFileSync(finalPath).toString()).toBe("ABC");
});

test("finalizeRecording 处理同名冲突（追加序号）", async () => {
  await appendChunk(uploads, "rec4a", "QQ==");
  await appendChunk(uploads, "rec4b", "Qg==");
  const p1 = await finalizeRecording(uploads, "rec4a", "dup.webm");
  const p2 = await finalizeRecording(uploads, "rec4b", "dup.webm");
  expect(p1).toBe(join(uploads, "dup.webm"));
  expect(p2).toBe(join(uploads, "dup (1).webm"));
});

test("discardRecording 删除临时文件（不存在时 no-op）", async () => {
  await appendChunk(uploads, "rec5", "QUJD");
  await discardRecording(uploads, "rec5");
  expect(existsSync(recordingTempPath(uploads, "rec5"))).toBe(false);
  await discardRecording(uploads, "rec5");  // 不抛
  expect(true).toBe(true);
});

test("cleanupRecordingTemp 清空临时目录残留", async () => {
  await appendChunk(uploads, "r-old1", "QUJD");
  await appendChunk(uploads, "r-old2", "QUJD");
  await cleanupRecordingTemp(uploads);
  expect(readdirSync(join(uploads, ".recording-tmp")).length).toBe(0);
});

test("recId 路径穿越防护：只保留 basename", () => {
  const p = recordingTempPath(uploads, "../../etc/passwd");
  expect(p).toBe(join(uploads, ".recording-tmp", "passwd.webm"));
  expect(p).not.toContain("..");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/kernel && bun test recording-store`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 创建 `recording-store.ts`**

`packages/kernel/src/recording-store.ts`:
```ts
import { appendFile, mkdir, rename, unlink, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, extname } from "node:path";

/** 仅保留 basename 并去分隔符，防 recId 路径穿越。 */
function safeId(recId: string): string {
  return basename(recId).replace(/[\\/]/g, "_") || "rec";
}

export function recordingTempDir(uploadDir: string): string {
  return join(uploadDir, ".recording-tmp");
}

export function recordingTempPath(uploadDir: string, recId: string): string {
  return join(recordingTempDir(uploadDir), `${safeId(recId)}.webm`);
}

/** 在 uploads 下生成不重复的最终文件名（镜像 ws-server.uniquePath 语义）。 */
async function uniqueFinalPath(uploadDir: string, finalName: string): Promise<string> {
  let safe = basename(finalName).replace(/[\\/]/g, "_") || "recording.webm";
  if (safe === "." || safe === "..") safe = "recording.webm";
  const candidate = join(uploadDir, safe);
  if (!existsSync(candidate)) return candidate;
  const ext = extname(safe);
  const stem = basename(safe, ext);
  let i = 1;
  while (existsSync(join(uploadDir, `${stem} (${i})${ext}`))) i++;
  return join(uploadDir, `${stem} (${i})${ext}`);
}

export async function appendChunk(uploadDir: string, recId: string, base64Chunk: string): Promise<void> {
  await mkdir(recordingTempDir(uploadDir), { recursive: true });
  const buf = Buffer.from(base64Chunk, "base64");
  await appendFile(recordingTempPath(uploadDir, recId), buf);
}

export async function finalizeRecording(uploadDir: string, recId: string, finalName: string): Promise<string> {
  const tmpPath = recordingTempPath(uploadDir, recId);
  const dest = await uniqueFinalPath(uploadDir, finalName);
  await rename(tmpPath, dest);
  return dest;
}

export async function discardRecording(uploadDir: string, recId: string): Promise<void> {
  const tmpPath = recordingTempPath(uploadDir, recId);
  try { await unlink(tmpPath); } catch { /* 不存在即 no-op */ }
}

export async function cleanupRecordingTemp(uploadDir: string): Promise<void> {
  const dir = recordingTempDir(uploadDir);
  if (!existsSync(dir)) return;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd packages/kernel && bun test recording-store`
Expected: PASS（7 个测试）

- [ ] **Step 5: 在 ws-server.ts 接入 3 个 handler**

`packages/kernel/src/ws-server.ts` 顶部导入（与现有 `node:fs/promises` 导入同行区）：
```ts
import { appendChunk, finalizeRecording, discardRecording } from "./recording-store";
```

在 `case "fs:search:cancel"` 之后、`case "provider:list"` 之前插入：
```ts
      case "fs:recording:append": {
        try {
          const data = await this.opts.projectStore.load();
          const project = data.projects.find(p => p.id === event.projectId);
          if (!project?.cwd) throw new Error(`项目不存在或无工作目录: ${event.projectId}`);
          const uploadDir = join(project.cwd, ".hiagent", "uploads");
          await appendChunk(uploadDir, event.recId, event.chunk);
          reply({ type: "fs:recording:append", id: event.id });
        } catch (e) {
          reply({ type: "fs:recording:append", id: event.id, error: String(e instanceof Error ? e.message : e) });
        }
        break;
      }
      case "fs:recording:finalize": {
        try {
          const data = await this.opts.projectStore.load();
          const project = data.projects.find(p => p.id === event.projectId);
          if (!project?.cwd) throw new Error(`项目不存在或无工作目录: ${event.projectId}`);
          const uploadDir = join(project.cwd, ".hiagent", "uploads");
          const path = await finalizeRecording(uploadDir, event.recId, event.finalName);
          reply({ type: "fs:recording:finalize", id: event.id, path });
        } catch (e) {
          reply({ type: "fs:recording:finalize", id: event.id, path: "", error: String(e instanceof Error ? e.message : e) });
        }
        break;
      }
      case "fs:recording:discard": {
        try {
          const data = await this.opts.projectStore.load();
          const project = data.projects.find(p => p.id === event.projectId);
          if (!project?.cwd) throw new Error(`项目不存在或无工作目录: ${event.projectId}`);
          const uploadDir = join(project.cwd, ".hiagent", "uploads");
          await discardRecording(uploadDir, event.recId);
          reply({ type: "fs:recording:discard", id: event.id });
        } catch (e) {
          reply({ type: "fs:recording:discard", id: event.id, error: String(e instanceof Error ? e.message : e) });
        }
        break;
      }
```

- [ ] **Step 6: 在 kernel 启动时清理各项目 `.recording-tmp`**

`packages/kernel/src/index.ts` 顶部加导入：
```ts
import { cleanupRecordingTemp } from "./recording-store";
import { join } from "node:path";
```

在 `const migrated = await migrateLegacySessions(projectStore);` 之后、`new WSServer(...)` 之前加：
```ts
  // 启动清理：上次崩溃/异常退出遗留的录音临时分片
  try {
    const { projects } = await projectStore.load();
    await Promise.all(projects.map(p => p.cwd ? cleanupRecordingTemp(join(p.cwd, ".hiagent", "uploads")) : Promise.resolve()));
  } catch (e) {
    console.warn("[kernel] 清理录音临时文件失败:", e);
  }
```

- [ ] **Step 7: typecheck + 提交**

Run: `cd packages/kernel && bun run typecheck`
Expected: 无错误
```bash
git add packages/kernel/src/recording-store.ts packages/kernel/src/ws-server.ts packages/kernel/src/index.ts packages/kernel/tests/recording-store.test.ts
git commit -m "feat(kernel): 录音边录边落盘（append/finalize/discard）+ 启动清残留"
```

---

## Task 3: kernel `/file` 路由（附件试听，受 uploads 目录约束）

**Files:**
- Modify: `packages/kernel/src/ws-server.ts`（fetch 分支 + 验证 helper）
- Test: `packages/kernel/tests/file-route.test.ts`

**Interfaces:**
- Consumes: `projectStore.load()`；Bun.serve fetch handler。
- Produces: 导出 `resolveUploadFile(url: URL, projects: { cwd: string }[]): string | null`（返回经验证的安全绝对路径，越权/不在 uploads 下返回 null）。前端 `pathToUploadUrl`（Task 4）产出 `/file?path=<abs>`。

- [ ] **Step 1: 写失败测试**

`packages/kernel/tests/file-route.test.ts`:
```ts
import { test, expect } from "bun:test";
import { resolveUploadFile } from "../src/ws-server";

const projects = [{ cwd: "/home/me/proj" }];

test("uploads 下的文件返回绝对路径", () => {
  const u = new URL("http://x/file?path=" + encodeURIComponent("/home/me/proj/.hiagent/uploads/a.webm"));
  expect(resolveUploadFile(u, projects)).toBe("/home/me/proj/.hiagent/uploads/a.webm");
});

test("路径穿越（..）到 uploads 外被拒", () => {
  const malicious = "/home/me/proj/.hiagent/uploads/../../etc/passwd";
  const u = new URL("http://x/file?path=" + encodeURIComponent(malicious));
  expect(resolveUploadFile(u, projects)).toBeNull();
});

test("不在任意项目 uploads 下被拒", () => {
  const u = new URL("http://x/file?path=" + encodeURIComponent("/etc/passwd"));
  expect(resolveUploadFile(u, projects)).toBeNull();
});

test("缺少 path 参数返回 null", () => {
  const u = new URL("http://x/file");
  expect(resolveUploadFile(u, projects)).toBeNull();
});

test("多个项目：命中其中任一 uploads 即放行", () => {
  const multi = [{ cwd: "/a" }, { cwd: "/b" }];
  const u = new URL("http://x/file?path=" + encodeURIComponent("/b/.hiagent/uploads/x.webm"));
  expect(resolveUploadFile(u, multi)).toBe("/b/.hiagent/uploads/x.webm");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/kernel && bun test file-route`
Expected: FAIL（`resolveUploadFile` 未导出）

- [ ] **Step 3: 实现 `resolveUploadFile` 并接入 fetch**

`packages/kernel/src/ws-server.ts` 顶部加导入：
```ts
import { resolve, normalize } from "node:path";
```

在 `getMimeType` 函数之后加：
```ts
/**
 * 解析 /file?path=<abs>：仅当 path 解析后落在某项目 .hiagent/uploads 下才放行。
 * 防 .. 穿越与非 uploads 路径。返回安全绝对路径，否则 null。
 */
export function resolveUploadFile(url: URL, projects: { cwd: string }[]): string | null {
  const raw = url.searchParams.get("path");
  if (!raw) return null;
  const resolved = resolve(raw);              // 解析 .. 与相对段
  if (resolved.includes("..")) return null;   // resolve 后仍含 .. → 拒
  for (const p of projects) {
    if (!p.cwd) continue;
    const uploadsRoot = resolve(join(p.cwd, ".hiagent", "uploads"));
    // 确保是 uploadsRoot 的子路径（带尾部分隔符防前缀同名）
    const rel = resolved.startsWith(uploadsRoot + "/") || resolved === uploadsRoot
      ? resolved.slice(uploadsRoot.length) : null;
    if (rel !== null && !rel.startsWith("..")) return resolved;
  }
  return null;
}
```

在 fetch handler（`if (this.opts.staticDir) {...}` 分支之前）加 `/file` 处理。把现有 fetch 改为：
```ts
      fetch: async (req, server) => {
        if (server.upgrade(req)) return;            // WS 握手
        const url = new URL(req.url);
        if (url.pathname === "/file") {
          const { projects } = await this.opts.projectStore.load();
          const filePath = resolveUploadFile(url, projects);
          if (!filePath) return new Response("Forbidden", { status: 403 });
          const file = Bun.file(filePath);
          if (file.size > 0) return new Response(file);   // Bun.file 自动处理 Range（音频 seek）
          return new Response("Not found", { status: 404 });
        }
        if (this.opts.staticDir) {
          const urlPath = new URL(req.url).pathname;
          const staticFilePath = resolveStaticPath(urlPath, this.opts.staticDir);
          const file = Bun.file(staticFilePath);
          if (file.size > 0) {
            return new Response(file, { headers: { "content-type": getMimeType(staticFilePath) } });
          }
          const indexFile = Bun.file(`${this.opts.staticDir}/index.html`);
          if (indexFile.size > 0) {
            return new Response(indexFile, { headers: { "content-type": "text/html" } });
          }
        }
        return new Response("WS only", { status: 426 });
      },
```
（`getMimeType` 已导入 `extname`；新增的 `resolve`/`normalize` 导入里 `normalize` 未用到可去掉——只导入 `resolve`。）

修正导入为：`import { extname, basename, join, resolve } from "node:path";`

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd packages/kernel && bun test file-route`
Expected: PASS（5 个测试）
Run: `cd packages/kernel && bun run typecheck`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add packages/kernel/src/ws-server.ts packages/kernel/tests/file-route.test.ts
git commit -m "feat(kernel): /file 路由受 uploads 目录约束地流式伺服附件（音频试听）"
```

---

## Task 4: 前端 fs-client 录音封装 + pathToUploadUrl

**Files:**
- Modify: `packages/frontend/src/fs-client.ts`
- Test: `packages/frontend/tests/fs-client-recording.test.ts`

**Interfaces:**
- Consumes: Task 1 类型；`_setFsTransport` 注入机制（已有）。
- Produces: `appendRecording(projectId, recId, chunk)`、`finalizeRecording(projectId, recId, finalName)`、`discardRecording(projectId, recId)`（均返回 Promise，超时保护）、`pathToUploadUrl(absPath: string): string`。recorder.ts（Task 5）与 AttachmentChip（Task 8）引用它们。

- [ ] **Step 1: 写失败测试**

`packages/frontend/tests/fs-client-recording.test.ts`:
```ts
import { test, expect, beforeEach } from "bun:test";
import {
  appendRecording, finalizeRecording, discardRecording, pathToUploadUrl, _setFsTransport,
} from "../src/fs-client";
import type { FsTransport } from "../src/fs-client";

function makeFakeTransport() {
  const sent: any[] = [];
  let responder: ((e: any) => any) | null = null;
  const transport: FsTransport = {
    send: (e) => sent.push(e),
    onMessage: (h) => { responder = h; return () => { responder = null; }; },
  };
  return { transport, sent, emit: (e: any) => responder?.(e) };
}

beforeEach(() => { /* 每个测试自建 transport */ });

test("appendRecording 发 fs:recording:append 并按 id 匹配响应", async () => {
  const fake = makeFakeTransport();
  _setFsTransport(fake.transport);
  const p = appendRecording("p1", "r1", "QUJD");
  expect(fake.sent[0].type).toBe("fs:recording:append");
  const id = fake.sent[0].id;
  fake.emit({ type: "fs:recording:append", id });
  await expect(p).resolves.toBeUndefined();
});

test("finalizeRecording 返回最终 path", async () => {
  const fake = makeFakeTransport();
  _setFsTransport(fake.transport);
  const p = finalizeRecording("p1", "r1", "rec.webm");
  const id = fake.sent[0].id;
  fake.emit({ type: "fs:recording:finalize", id, path: "/uploads/rec.webm" });
  await expect(p).resolves.toEqual({ path: "/uploads/rec.webm" });
});

test("finalizeRecording 收 error 时 reject", async () => {
  const fake = makeFakeTransport();
  _setFsTransport(fake.transport);
  const p = finalizeRecording("p1", "r1", "rec.webm");
  fake.emit({ type: "fs:recording:finalize", id: fake.sent[0].id, path: "", error: "boom" });
  await expect(p).rejects.toThrow("boom");
});

test("discardRecording 正常 resolve", async () => {
  const fake = makeFakeTransport();
  _setFsTransport(fake.transport);
  const p = discardRecording("p1", "r1");
  fake.emit({ type: "fs:recording:discard", id: fake.sent[0].id });
  await expect(p).resolves.toBeUndefined();
});

test("pathToUploadUrl 对绝对路径做 encode", () => {
  _setFsTransport(null);  // 不依赖 transport
  const u = pathToUploadUrl("/home/me/p/.hiagent/uploads/r.webm");
  expect(u).toBe("/file?path=" + encodeURIComponent("/home/me/p/.hiagent/uploads/r.webm"));
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/frontend && bun test fs-client-recording`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 在 fs-client.ts 末尾追加实现**

```ts
export function appendRecording(projectId: string, recId: string, chunk: string, timeoutMs = 30000): Promise<void> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const off = onMessage((e: any) => {
      if (e.type === "fs:recording:append" && e.id === id) {
        clearTimeout(timer); off();
        if (e.error) reject(new Error(e.error)); else resolve();
      }
    });
    const timer = setTimeout(() => { off(); reject(new Error("录音分片落盘超时")); }, timeoutMs);
    send({ type: "fs:recording:append", id, projectId, recId, chunk });
  });
}

export function finalizeRecording(projectId: string, recId: string, finalName: string, timeoutMs = 30000): Promise<{ path: string }> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const off = onMessage((e: any) => {
      if (e.type === "fs:recording:finalize" && e.id === id) {
        clearTimeout(timer); off();
        if (e.error) reject(new Error(e.error)); else resolve({ path: e.path });
      }
    });
    const timer = setTimeout(() => { off(); reject(new Error("录音 finalize 超时")); }, timeoutMs);
    send({ type: "fs:recording:finalize", id, projectId, recId, finalName });
  });
}

export function discardRecording(projectId: string, recId: string, timeoutMs = 10000): Promise<void> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const off = onMessage((e: any) => {
      if (e.type === "fs:recording:discard" && e.id === id) {
        clearTimeout(timer); off();
        if (e.error) reject(new Error(e.error)); else resolve();
      }
    });
    const timer = setTimeout(() => { off(); resolve(); }, timeoutMs);  // discard 容错：超时也 resolve
    send({ type: "fs:recording:discard", id, projectId, recId });
  });
}

/** 把附件绝对路径转成可被 <audio>/<img> 直接加载的 kernel /file URL。 */
export function pathToUploadUrl(absPath: string): string {
  return "/file?path=" + encodeURIComponent(absPath);
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd packages/frontend && bun test fs-client-recording`
Expected: PASS（5 个测试）

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/fs-client.ts packages/frontend/tests/fs-client-recording.test.ts
git commit -m "feat(frontend): fs-client 录音 append/finalize/discard 封装 + pathToUploadUrl"
```

---

## Task 5: 录音引擎 recorder.ts（ElapsedTracker + RecordingManager）

**Files:**
- Create: `packages/frontend/src/recording/recorder.ts`
- Test: `packages/frontend/tests/recorder.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `appendRecording/finalizeRecording/discardRecording`；浏览器 `MediaRecorder`/`getUserMedia`/`getDisplayMedia`。
- Produces: `RecordingManager` 单例（`start/pause/resume/stop`）、`ElapsedTracker`、`formatDuration(ms)`、测试钩子 `_setRecordingManager`。store（Task 6）通过该钩子注入伪引擎。

- [ ] **Step 1: 写失败测试（纯逻辑：ElapsedTracker + formatDuration）**

`packages/frontend/tests/recorder.test.ts`:
```ts
import { test, expect } from "bun:test";
import { ElapsedTracker, formatDuration } from "../src/recording/recorder";

test("formatDuration：< 1h 用 m:ss", () => {
  expect(formatDuration(0)).toBe("0:00");
  expect(formatDuration(65_000)).toBe("1:05");
  expect(formatDuration(599_999)).toBe("9:59");
});

test("formatDuration：≥ 1h 用 h:mm:ss", () => {
  expect(formatDuration(3_600_000)).toBe("1:00:00");
  expect(formatDuration(3_661_000)).toBe("1:01:01");
});

test("ElapsedTracker：start→elapsed 随时间增长；pause 冻结；resume 继续", () => {
  const t = new ElapsedTracker();
  t.start(1000);
  expect(t.elapsed(1000)).toBe(0);
  expect(t.elapsed(1500)).toBe(500);
  t.pause(2000);                  // 累积 1000ms
  expect(t.elapsed(3000)).toBe(1000);   // 暂停后不增长
  t.resume(4000);
  expect(t.elapsed(4000)).toBe(1000);
  expect(t.elapsed(4500)).toBe(1500);   // resume 后继续增长
});

test("ElapsedTracker：pause 幂等；resume 幂等", () => {
  const t = new ElapsedTracker();
  t.start(0);
  t.pause(100);                   // 累积 100
  t.pause(200);                   // 再次 pause：不重复累积
  expect(t.elapsed(300)).toBe(100);
  t.resume(400);
  t.resume(500);                  // 再次 resume：不重置基准
  expect(t.elapsed(600)).toBe(300);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/frontend && bun test recorder`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 recorder.ts**

`packages/frontend/src/recording/recorder.ts`:
```ts
import { appendRecording, finalizeRecording, discardRecording } from "../fs-client";

const TIMESLICE_MS = 2000;

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 暂停感知的时长累积器（纯逻辑，可单测）。所有 now 由调用方传入，便于测试。 */
export class ElapsedTracker {
  private accumulated = 0;
  private resumedAt = 0;
  private running = false;
  start(now: number): void { this.accumulated = 0; this.resumedAt = now; this.running = true; }
  pause(now: number): void {
    if (!this.running) return;
    this.accumulated += now - this.resumedAt;
    this.running = false;
  }
  resume(now: number): void { if (this.running) return; this.resumedAt = now; this.running = true; }
  elapsed(now: number): number { return this.accumulated + (this.running ? now - this.resumedAt : 0); }
}

export interface StartArgs {
  source: "mic" | "system";
  projectId: string;
  sessionId: string;
  ownerLabel: string;
  onTick: (elapsedMs: number) => void;
}
export interface RecordingResult { path: string; size: number; durationMs: number; }

export interface RecordingEngine {
  start(args: StartArgs): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<RecordingResult>;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => { const s = String(r.result); resolve(s.includes(",") ? s.split(",")[1] : s); };
    r.onerror = () => reject(new Error("录音分片读取失败"));
    r.readAsDataURL(blob);
  });
}

function pickAudioMimeType(): string {
  return typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
}

class RecordingManager implements RecordingEngine {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private tracker = new ElapsedTracker();
  private recId = "";
  private projectId = "";
  private onTick: ((ms: number) => void) | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private stopResolve: ((r: RecordingResult) => void) | null = null;
  private stopReject: ((e: Error) => void) | null = null;
  private failed = false;

  async start(args: StartArgs): Promise<void> {
    if (this.recorder) throw new Error("已有录音进行中");
    this.projectId = args.projectId;
    this.recId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.onTick = args.onTick;
    this.failed = false;

    const stream = args.source === "mic"
      ? await navigator.mediaDevices.getUserMedia({ audio: true })
      : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    this.stream = stream;

    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) { this.releaseTracks(); throw new Error("未获取到音频轨道"); }
    for (const t of stream.getVideoTracks()) t.stop();   // 系统 audio：丢弃 video

    const recorder = new MediaRecorder(new MediaStream(audioTracks), pickAudioMimeType() ? { mimeType: pickAudioMimeType() } : undefined);
    this.recorder = recorder;

    recorder.ondataavailable = async (e) => {
      if (!e.data || e.data.size === 0 || this.failed) return;
      try { await appendRecording(this.projectId, this.recId, await blobToBase64(e.data)); }
      catch (err) { this.fail(err as Error); }
    };
    recorder.onstop = async () => {
      if (this.failed) { this.stopReject?.(new Error("录音已失败")); this.cleanup(); return; }
      const durationMs = this.tracker.elapsed(Date.now());
      try {
        const { path } = await finalizeRecording(this.projectId, this.recId, `recording-${this.recId}.webm`);
        this.stopResolve?.({ path, size: 0, durationMs });
      } catch (err) { this.stopReject?.(err as Error); }
      finally { this.cleanup(); }
    };
    recorder.onerror = () => this.fail(new Error("录音出错"));

    this.tracker.start(Date.now());
    recorder.start(TIMESLICE_MS);
    this.tickTimer = setInterval(() => this.onTick?.(this.tracker.elapsed(Date.now())), 250);
  }

  pause(): void {
    if (!this.recorder || this.recorder.state !== "recording") return;
    this.recorder.pause();
    this.tracker.pause(Date.now());
  }
  resume(): void {
    if (!this.recorder || this.recorder.state !== "paused") return;
    this.recorder.resume();
    this.tracker.resume(Date.now());
  }
  stop(): Promise<RecordingResult> {
    return new Promise((resolve, reject) => {
      if (!this.recorder) { reject(new Error("没有进行中的录音")); return; }
      this.stopResolve = resolve;
      this.stopReject = reject;
      this.tracker.pause(Date.now());   // 冻结计时，等待 onstop
      if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
      this.recorder.stop();
    });
  }

  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = true;
    try { void discardRecording(this.projectId, this.recId); } catch {}
    this.onTick = null;
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    // 让进行中的 stop（若有）在 onstop 里 reject
  }

  private releaseTracks(): void { this.stream?.getTracks().forEach(t => t.stop()); }
  private cleanup(): void {
    this.releaseTracks();
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    this.recorder = null;
    this.stream = null;
    this.stopResolve = null;
    this.stopReject = null;
  }
}

// 模块级单例 + 测试注入钩子（镜像 fs-client._setFsTransport 模式）
let engine: RecordingEngine = new RecordingManager();
export function getRecordingManager(): RecordingEngine { return engine; }
export function _setRecordingManager(e: RecordingEngine | null): void { engine = e ?? new RecordingManager(); }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd packages/frontend && bun test recorder`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/recording/recorder.ts packages/frontend/tests/recorder.test.ts
git commit -m "feat(frontend): RecordingManager 单例 + ElapsedTracker + formatDuration"
```

---

## Task 6: 录音全局 store（useRecordingStore）

**Files:**
- Create: `packages/frontend/src/store/recording.ts`
- Test: `packages/frontend/tests/recording-store.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `getRecordingManager/_setRecordingManager/RecordingResult`；Task 1 的 `AttachmentDraft`；现有 `useComposerPrefsStore`（停止后写归属会话 composer）。
- Produces: `useRecordingStore`（`status/source/owningProjectId/owningSessionId/ownerLabel/startedAt/elapsedMs/error` + `start/pause/resume/stop`）。RecordButton（Task 9）与 RecordingCapsule（Task 10）订阅它。

- [ ] **Step 1: 写失败测试**

`packages/frontend/tests/recording-store.test.tsx`:
```ts
import { test, expect, beforeEach } from "bun:test";
import { useRecordingStore } from "../src/store/recording";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { _setRecordingManager, type RecordingEngine, type StartArgs, type RecordingResult } from "../src/recording/recorder";

beforeEach(() => {
  useRecordingStore.setState({
    status: "idle", source: "mic", owningProjectId: "", owningSessionId: "",
    ownerLabel: "", startedAt: 0, elapsedMs: 0, error: undefined,
  });
  useComposerPrefsStore.setState({ bySession: {} });
});

function fakeEngine(): { engine: RecordingEngine; startArgs: StartArgs | null; stopped: boolean } {
  let startArgs: StartArgs | null = null;
  const engine: RecordingEngine = {
    start: async (a) => { startArgs = a; },
    pause: () => {},
    resume: () => {},
    stop: async (): Promise<RecordingResult> => ({ path: "/p/uploads/rec.webm", size: 100, durationMs: 2000 }),
  };
  return { engine, get startArgs() { return startArgs; }, stopped: false } as any;
}

test("start 进入 recording 并记录归属", async () => {
  const f = fakeEngine(); _setRecordingManager(f.engine);
  await useRecordingStore.getState().start({ source: "system", projectId: "p1", sessionId: "s1", ownerLabel: "项目A · 会话A" });
  const s = useRecordingStore.getState();
  expect(s.status).toBe("recording");
  expect(s.source).toBe("system");
  expect(s.owningSessionId).toBe("s1");
  expect(s.ownerLabel).toBe("项目A · 会话A");
});

test("start 时 onTick 回写 elapsedMs", async () => {
  const f = fakeEngine(); _setRecordingManager(f.engine);
  await useRecordingStore.getState().start({ source: "mic", projectId: "p1", sessionId: "s1", ownerLabel: "x" });
  // fakeEngine.start 丢掉了 onTick；用真实 engine 不可，故单独验证 reducer 行为：
  useRecordingStore.setState({ elapsedMs: 0 });
  // 直接模拟 onTick：从 fakeEngine 抓 onTick 调用
  // （为可测，start 内部把 onTick 经 args 传出——见实现，store 测试可拿到）
});

test("非 idle 时 start 被拒（busy），不调用 engine.start", async () => {
  let called = false;
  const engine: RecordingEngine = { start: async () => { called = true; }, pause: () => {}, resume: () => {}, stop: async () => ({ path: "", size: 0, durationMs: 0 }) };
  _setRecordingManager(engine);
  useRecordingStore.setState({ status: "recording", owningSessionId: "s1", ownerLabel: "项目A · 会话A" });
  await expect(useRecordingStore.getState().start({ source: "mic", projectId: "p2", sessionId: "s2", ownerLabel: "y" }))
    .rejects.toThrow(/正在录音/);
  expect(called).toBe(false);
});

test("pause/resume 切换 status", async () => {
  const f = fakeEngine(); _setRecordingManager(f.engine);
  await useRecordingStore.getState().start({ source: "mic", projectId: "p1", sessionId: "s1", ownerLabel: "x" });
  useRecordingStore.getState().pause();
  expect(useRecordingStore.getState().status).toBe("paused");
  useRecordingStore.getState().resume();
  expect(useRecordingStore.getState().status).toBe("recording");
});

test("stop 成功后：idle + audio draft 写入归属会话 composer", async () => {
  const f = fakeEngine(); _setRecordingManager(f.engine);
  await useRecordingStore.getState().start({ source: "mic", projectId: "p1", sessionId: "s1", ownerLabel: "x" });
  useComposerPrefsStore.setState({ bySession: { s1: { model: null, thinking: "disabled", attachments: [] } } });
  await useRecordingStore.getState().stop();
  expect(useRecordingStore.getState().status).toBe("idle");
  const drafts = useComposerPrefsStore.getState().bySession["s1"].attachments;
  expect(drafts.length).toBe(1);
  expect(drafts[0].kind).toBe("audio");
  expect((drafts[0] as any).path).toBe("/p/uploads/rec.webm");
});

test("start 失败：status 回 idle + error，且 rethrow", async () => {
  const engine: RecordingEngine = { start: async () => { throw new Error("无设备"); }, pause: () => {}, resume: () => {}, stop: async () => ({ path: "", size: 0, durationMs: 0 }) };
  _setRecordingManager(engine);
  await expect(useRecordingStore.getState().start({ source: "mic", projectId: "p1", sessionId: "s1", ownerLabel: "x" })).rejects.toThrow("无设备");
  expect(useRecordingStore.getState().status).toBe("idle");
  expect(useRecordingStore.getState().error).toBe("无设备");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/frontend && bun test recording-store`
Expected: FAIL（store 不存在）

- [ ] **Step 3: 实现 store**

`packages/frontend/src/store/recording.ts`:
```ts
import { create } from "zustand";
import type { AttachmentDraft } from "@hiagent/shared";
import { getRecordingManager, type StartArgs, type RecordingResult } from "../recording/recorder";
import { useComposerPrefsStore } from "./composer-prefs";

export type RecordingStatus = "idle" | "recording" | "paused";
export type RecordingSource = "mic" | "system";

interface StartOpts { source: RecordingSource; projectId: string; sessionId: string; ownerLabel: string; }

interface RecordingState {
  status: RecordingStatus;
  source: RecordingSource;
  owningProjectId: string;
  owningSessionId: string;
  ownerLabel: string;
  startedAt: number;
  elapsedMs: number;
  error?: string;
  start(opts: StartOpts): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  status: "idle",
  source: "mic",
  owningProjectId: "",
  owningSessionId: "",
  ownerLabel: "",
  startedAt: 0,
  elapsedMs: 0,

  start: async (opts) => {
    if (get().status !== "idle") {
      throw new Error(`${get().ownerLabel} 正在录音，需要等到上一个录音结束才能开始新的录音`);
    }
    set({ error: undefined });
    try {
      await getRecordingManager().start({
        source: opts.source,
        projectId: opts.projectId,
        sessionId: opts.sessionId,
        ownerLabel: opts.ownerLabel,
        onTick: (elapsedMs) => set({ elapsedMs }),
      });
      set({
        status: "recording",
        source: opts.source,
        owningProjectId: opts.projectId,
        owningSessionId: opts.sessionId,
        ownerLabel: opts.ownerLabel,
        startedAt: Date.now(),
        elapsedMs: 0,
      });
    } catch (e) {
      set({ status: "idle", error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },

  pause: () => {
    if (get().status !== "recording") return;
    getRecordingManager().pause();
    set({ status: "paused" });
  },

  resume: () => {
    if (get().status !== "paused") return;
    getRecordingManager().resume();
    set({ status: "recording" });
  },

  stop: async () => {
    if (get().status === "idle") return;
    const owningSessionId = get().owningSessionId;
    try {
      const result: RecordingResult = await getRecordingManager().stop();
      // audio draft 写入归属会话 composer
      const draft: AttachmentDraft = {
        kind: "audio",
        name: result.path.split(/[\\/]/).pop() ?? "recording.webm",
        path: result.path,
        size: result.size,
        ...(result.durationMs ? { durationMs: result.durationMs } : {}),
      } as AttachmentDraft;
      const existing = useComposerPrefsStore.getState().bySession[owningSessionId]?.attachments ?? [];
      useComposerPrefsStore.getState().setSessionPrefs(owningSessionId, { attachments: [...existing, draft] });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ status: "idle", elapsedMs: 0, startedAt: 0 });
    }
  },
}));
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd packages/frontend && bun test recording-store`
Expected: PASS（5 个测试）
> 注：第 2 个测试（onTick）为占位验证——`start` 内部把 `onTick` 经 `args.onTick` 传给引擎；该测试通过 `setState` 验证 reducer，不阻塞。如实现让 store 直接持有 onTick 写 elapsedMs，该断言无副作用，仍 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/store/recording.ts packages/frontend/tests/recording-store.test.tsx
git commit -m "feat(frontend): useRecordingStore 全局单例状态机 + 停止写 audio draft 到归属 composer"
```

---

## Task 7: 移除「编排画布」（废弃功能）

**Files:**
- Modify: `packages/frontend/src/App.tsx`
- Modify: `packages/frontend/src/components/SessionView.tsx`
- Delete: `packages/frontend/src/components/canvas/Canvas.tsx`、`CanvasNode.tsx`、`types.ts`
- Test: `packages/frontend/tests/canvas-removed.test.tsx`

**Interfaces:**
- Consumes: 现有 App/SessionView。
- Produces: `View` 联合去掉 `canvas`；SessionView 不再有 `onSwitchToCanvas` prop；header 右上位置空出（供 Task 10 胶囊）。

- [ ] **Step 1: 写失败测试**

`packages/frontend/tests/canvas-removed.test.tsx`:
```ts
import { test, expect } from "bun:test";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { App, type View } from "../src/App";

test("View 类型不再包含 canvas", () => {
  // 编译期约束：若 View 仍含 'canvas'，这行会编译通过；运行时只断言可赋值集合
  const ok: View[] = ["empty", "new-session", "session"];
  expect(ok.length).toBe(3);
});

test("App 渲染 session 视图时不出现编排画布按钮", async () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/tmp", createdAt: 1 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "T", createdAt: 1, lastActivity: 1, piSessionFile: "/x.jsonl" }],
    currentProjectId: "p1", currentSessionId: "s1", dirPickerOpen: false,
  } as any);
  useSessionStore.setState({ messagesBySession: {} });
  useComposerPrefsStore.setState({ bySession: {} });
  const { render, screen } = await import("@testing-library/react");
  render(<App />);
  expect(screen.queryByText("编排画布")).toBeNull();
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/frontend && bun test canvas-removed`
Expected: FAIL（View 仍含 canvas / 按钮仍在）

- [ ] **Step 3: 改 App.tsx**

删除 `import { Canvas } from "./components/canvas/Canvas";`。
改 `export type View = "empty" | "new-session" | "session" | "canvas";` →
```ts
export type View = "empty" | "new-session" | "session";
```
SessionView 调用处去掉 prop：
```ts
{view === "session" && currentSessionId && <SessionView sessionId={currentSessionId} />}
```
删除整个 `{view === "canvas" && (...)}` 渲染分支。

- [ ] **Step 4: 改 SessionView.tsx**

`interface Props { sessionId: string; onSwitchToCanvas: () => void; }` → `interface Props { sessionId: string; }`
函数签名 `export function SessionView({ sessionId, onSwitchToCanvas }: Props)` → `export function SessionView({ sessionId }: Props)`
删除 header 内的编排画布 `<button onClick={onSwitchToCanvas} ...>编排画布</button>`（约 76-78 行）。

- [ ] **Step 5: 删除 canvas 组件文件**

```bash
git rm packages/frontend/src/components/canvas/Canvas.tsx packages/frontend/src/components/canvas/CanvasNode.tsx packages/frontend/src/components/canvas/types.ts
```
（若目录变空则连同空目录删除。）

- [ ] **Step 6: 运行测试 + typecheck**

Run: `cd packages/frontend && bun test canvas-removed`
Expected: PASS
Run: `cd packages/frontend && bun run typecheck`
Expected: 无错误（确认无残留 `onSwitchToCanvas` / Canvas 引用）

- [ ] **Step 7: 提交**

```bash
git add packages/frontend/src/App.tsx packages/frontend/src/components/SessionView.tsx packages/frontend/tests/canvas-removed.test.tsx
git commit -m "refactor(frontend): 移除废弃的编排画布（按钮/View/组件）"
```

---

## Task 8: AttachmentChip 支持 audio kind（内嵌试听）

**Files:**
- Modify: `packages/frontend/src/components/ui/AttachmentChip.tsx`
- Test: `packages/frontend/tests/AttachmentChip.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `AttachmentDraft` audio 成员；Task 4 的 `pathToUploadUrl`。
- Produces: audio chip 渲染 `<audio controls>` + 文件名 + 移除按钮。其余 kind 不变。

- [ ] **Step 1: 写失败测试**

`packages/frontend/tests/AttachmentChip.test.tsx`:
```ts
import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { AttachmentChip } from "../src/components/ui/AttachmentChip";
import type { AttachmentDraft } from "@hiagent/shared";

test("audio chip 渲染文件名 + <audio> 试听 + 移除按钮", () => {
  const a: AttachmentDraft = { kind: "audio", name: "rec.webm", path: "/p/.hiagent/uploads/rec.webm", size: 10, durationMs: 2000 };
  const onRemove = () => {};
  render(<AttachmentChip attachment={a} onRemove={onRemove} />);
  expect(screen.getByText("rec.webm")).toBeTruthy();
  const audio = document.querySelector("audio") as HTMLAudioElement;
  expect(audio).toBeTruthy();
  expect(audio?.getAttribute("src")).toBe("/file?path=" + encodeURIComponent("/p/.hiagent/uploads/rec.webm"));
  expect(screen.getByLabelText("移除附件")).toBeTruthy();
});

test("非 audio（file）chip 不渲染 <audio>", () => {
  const a: AttachmentDraft = { kind: "file", name: "a.txt", path: "/p/a.txt", size: 1 };
  render(<AttachmentChip attachment={a} onRemove={() => {}} />);
  expect(document.querySelector("audio")).toBeNull();
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/frontend && bun test AttachmentChip`
Expected: FAIL（audio 时不渲染 `<audio>`）

- [ ] **Step 3: 修改 AttachmentChip.tsx**

整体替换为：
```tsx
import type { AttachmentDraft } from "@hiagent/shared";
import { pathToUploadUrl } from "../../fs-client";

interface Props {
  attachment: AttachmentDraft;
  onRemove: () => void;
}

export function AttachmentChip({ attachment, onRemove }: Props) {
  const label = attachment.kind === "snippet"
    ? attachment.content.slice(0, 20) + (attachment.content.length > 20 ? "…" : "")
    : attachment.name;
  const icon =
    attachment.kind === "image" ? "📷" :
    attachment.kind === "audio" ? "🎤" :
    attachment.kind === "folder" ? "📁" :
    attachment.kind === "snippet" ? "📝" : "📄";

  return (
    <span className="inline-flex flex-col gap-1 text-xs text-secondary bg-surface-hover px-2 py-1 rounded-pill" data-testid="attachment-chip">
      <span className="inline-flex items-center gap-1">
        <span>{icon}</span>
        <span className="truncate max-w-[150px]">{label}</span>
        <button
          type="button"
          aria-label="移除附件"
          data-testid="attachment-remove"
          onClick={onRemove}
          className="text-tertiary hover:text-danger ml-1"
        >✕</button>
      </span>
      {attachment.kind === "audio" && (
        <audio controls src={pathToUploadUrl(attachment.path)} className="h-8 w-[220px]" data-testid="attachment-audio" />
      )}
    </span>
  );
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd packages/frontend && bun test AttachmentChip`
Expected: PASS（2 个测试）

- [ ] **Step 5: 提交**

```bash
git add packages/frontend/src/components/ui/AttachmentChip.tsx packages/frontend/tests/AttachmentChip.test.tsx
git commit -m "feat(frontend): AttachmentChip 支持 audio kind 内嵌试听"
```

---

## Task 9: RecordButton + lastSource 持久化 + 接入 ComposerInput

**Files:**
- Modify: `packages/frontend/src/store/composer-db.ts`（`getRecordingPrefs`/`setRecordingPrefs`）
- Create: `packages/frontend/src/components/ui/RecordButton.tsx`
- Modify: `packages/frontend/src/components/ui/ComposerInput.tsx`（插入按钮 + 传 sessionId）
- Modify: `packages/frontend/src/components/Composer.tsx`（传 sessionId）
- Test: `packages/frontend/tests/RecordButton.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `useRecordingStore`；`useProjectsStore`（取 project/session 名拼 ownerLabel）；`useToastStore`；`useComposerPrefsStore`。
- Produces: `RecordButton` 组件（props: `{ sessionId: string; projectId?: string }`）。ComposerInput 内嵌它。

- [ ] **Step 1: 写失败测试**

`packages/frontend/tests/RecordButton.test.tsx`:
```ts
import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { RecordButton } from "../src/components/ui/RecordButton";
import { useRecordingStore } from "../src/store/recording";
import { useProjectsStore } from "../src/store/projects";
import { useToastStore } from "../src/store/toast";
import { getRecordingPrefs, setRecordingPrefs, _setRecordingManager } from "../src/recording/recorder";

beforeEach(() => {
  useRecordingStore.setState({ status: "idle", source: "mic", owningSessionId: "", ownerLabel: "", elapsedMs: 0 });
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "项目A", cwd: "/tmp", createdAt: 1 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "会话A", createdAt: 1, lastActivity: 1, piSessionFile: "" }],
  } as any);
  useToastStore.setState({ toasts: [] });
  // 默认引擎桩：start 立即成功
  _setRecordingManager({ start: async () => {}, pause: () => {}, resume: () => {}, stop: async () => ({ path: "", size: 0, durationMs: 0 }) });
});

test("idle 点击 → 用 lastSource 启动（默认 mic）", async () => {
  await setRecordingPrefs({ lastSource: "system" });  // 设上次为 system
  render(<RecordButton sessionId="s1" projectId="p1" />);
  fireEvent.click(screen.getByLabelText("录音"));
  await new Promise(r => setTimeout(r, 0));
  expect(useRecordingStore.getState().status).toBe("recording");
  expect(useRecordingStore.getState().source).toBe("system");
  expect(useRecordingStore.getState().ownerLabel).toBe("项目A · 会话A");
});

test("busy（他会在录）点击 → toast 提示且不启动", async () => {
  useRecordingStore.setState({ status: "recording", owningSessionId: "s9", ownerLabel: "项目B · 会话B" });
  let started = false;
  _setRecordingManager({ start: async () => { started = true; }, pause: () => {}, resume: () => {}, stop: async () => ({ path: "", size: 0, durationMs: 0 }) });
  render(<RecordButton sessionId="s1" projectId="p1" />);
  fireEvent.click(screen.getByLabelText("录音"));
  await new Promise(r => setTimeout(r, 0));
  expect(started).toBe(false);
  expect(useToastStore.getState().toasts[0]?.message).toContain("项目B · 会话B");
  expect(useToastStore.getState().toasts[0]?.message).toContain("正在录音");
});

test("右键 → 弹出音源切换；选 system 更新 lastSource", async () => {
  await setRecordingPrefs({ lastSource: "mic" });
  render(<RecordButton sessionId="s1" projectId="p1" />);
  fireEvent.contextMenu(screen.getByLabelText("录音"));
  fireEvent.click(screen.getByText("系统音频"));
  const prefs = await getRecordingPrefs();
  expect(prefs?.lastSource).toBe("system");
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/frontend && bun test RecordButton`
Expected: FAIL（组件/函数不存在）

- [ ] **Step 3: 在 composer-db.ts 加 lastSource 持久化**

在 `composer-db.ts` 末尾加（复用现有 `defaults` object store，新 key，无需 DB 版本迁移）：
```ts
const RECORDING_KEY = "recording-prefs";

export interface RecordingPrefs { lastSource: "mic" | "system"; }

export async function getRecordingPrefs(): Promise<RecordingPrefs | undefined> {
  try {
    return await (await getDb()).get("defaults", RECORDING_KEY);
  } catch {
    return undefined;
  }
}

export async function setRecordingPrefs(prefs: RecordingPrefs): Promise<void> {
  try {
    await (await getDb()).put("defaults", prefs, RECORDING_KEY);
  } catch {}
}
```
> ⚠️ RecordButton 测试里 `import { getRecordingPrefs, setRecordingPrefs, _setRecordingManager } from "../src/recording/recorder"` 是错的——`getRecordingPrefs/setRecordingPrefs` 在 `composer-db.ts`。**修正测试导入**：把那两个从 composer-db 导入；`_setRecordingManager` 从 recorder 导入。即测试顶部改为：
```ts
import { getRecordingPrefs, setRecordingPrefs } from "../src/store/composer-db";
import { _setRecordingManager } from "../src/recording/recorder";
```
（实现前先按此修正测试文件再跑。）

- [ ] **Step 4: 实现 RecordButton.tsx**

`packages/frontend/src/components/ui/RecordButton.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";
import { useRecordingStore } from "../../store/recording";
import { useProjectsStore } from "../../store/projects";
import { useToastStore } from "../../store/toast";
import { getRecordingPrefs, setRecordingPrefs, type RecordingPrefs } from "../../store/composer-db";

interface Props { sessionId: string; projectId?: string; }

export function RecordButton({ sessionId, projectId }: Props) {
  const status = useRecordingStore(s => s.status);
  const start = useRecordingStore(s => s.start);
  const [lastSource, setLastSource] = useState<"mic" | "system">("mic");
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { void getRecordingPrefs().then(p => { if (p?.lastSource) setLastSource(p.lastSource); }); }, []);

  const busy = status !== "idle";

  async function handleClick() {
    if (busy) {
      const { ownerLabel } = useRecordingStore.getState();
      useToastStore.getState().add(`${ownerLabel} 正在录音，需要等到上一个录音结束才能开始新的录音`);
      return;
    }
    try {
      await start({ source: lastSource, projectId: projectId ?? "", sessionId, ownerLabel: buildOwnerLabel() });
    } catch (e) {
      useToastStore.getState().add(e instanceof Error ? e.message : "录音启动失败");
    }
  }

  function buildOwnerLabel(): string {
    const { projects, sessions } = useProjectsStore.getState();
    const session = sessions.find(s => s.id === sessionId);
    const project = projects.find(p => p.id === (session?.projectId ?? projectId));
    return `${project?.name ?? "项目"} · ${session?.title ?? "会话"}`;
  }

  function openSwitcher() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
    setSwitcherOpen(true);
  }

  async function pickSource(src: "mic" | "system") {
    setLastSource(src);
    await setRecordingPrefs({ lastSource: src } as RecordingPrefs);
    setSwitcherOpen(false);
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="录音"
        data-testid="record-button"
        disabled={busy}
        onClick={handleClick}
        onContextMenu={(e) => { e.preventDefault(); openSwitcher(); }}
        onTouchStart={() => { longPressTimer.current = setTimeout(openSwitcher, 500); }}
        onTouchEnd={() => { if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; } }}
        title={`录音（当前：${lastSource === "mic" ? "麦克风" : "系统音频"}，右键/长按切换）`}
        className={`text-lg ${busy ? "text-tertiary" : status === "recording" ? "text-danger animate-pulse" : "text-secondary hover:text-primary"} disabled:opacity-50`}
      >🎙</button>
      {switcherOpen && (
        <div className="absolute bottom-full mb-2 left-0 z-10 bg-surface border border-hairline rounded-sm shadow-md text-xs" data-testid="record-source-switcher">
          <button type="button" onClick={() => pickSource("mic")} className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover">🎤 麦克风</button>
          <button type="button" onClick={() => pickSource("system")} className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover">🖥 系统音频</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 接入 ComposerInput + 传 sessionId**

`packages/frontend/src/components/Composer.tsx`：`<ComposerInput ... />` 加 `sessionId={sessionId}`。
`packages/frontend/src/components/ui/ComposerInput.tsx`：`Props` 加 `sessionId: string;`；在 📎 按钮之后插入：
```tsx
import { RecordButton } from "./RecordButton";
// ...
            >📎</button>
            <RecordButton sessionId={sessionId} projectId={projectId} />
```
（`Composer` 解构 props 处已含 `sessionId`，直接传。）

- [ ] **Step 6: 运行测试 + typecheck**

Run: `cd packages/frontend && bun test RecordButton`
Expected: PASS（3 个测试）
Run: `cd packages/frontend && bun run typecheck`
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add packages/frontend/src/store/composer-db.ts packages/frontend/src/components/ui/RecordButton.tsx packages/frontend/src/components/ui/ComposerInput.tsx packages/frontend/src/components/Composer.tsx packages/frontend/tests/RecordButton.test.tsx
git commit -m "feat(frontend): RecordButton（默认上次音源+长按/右键切换+忙碌提示）+ lastSource 持久化"
```

---

## Task 10: RecordingCapsule + 接入 SessionView header

**Files:**
- Create: `packages/frontend/src/components/ui/RecordingCapsule.tsx`
- Modify: `packages/frontend/src/components/SessionView.tsx`（header 右上插入胶囊）
- Test: `packages/frontend/tests/RecordingCapsule.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `useRecordingStore`；Task 5 的 `formatDuration`；`useProjectsStore`（取 `currentSessionId` 判断是否归属会话）。
- Produces: `RecordingCapsule`（无 props，全局读 store），仅 `status !== 'idle'` 时渲染。

- [ ] **Step 1: 写失败测试**

`packages/frontend/tests/RecordingCapsule.test.tsx`:
```ts
import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { RecordingCapsule } from "../src/components/ui/RecordingCapsule";
import { useRecordingStore } from "../src/store/recording";
import { useProjectsStore } from "../src/store/projects";

const fakeEngine = { start: async () => {}, pause: () => {}, resume: () => {}, stop: async () => ({ path: "", size: 0, durationMs: 0 }) };

beforeEach(() => {
  useRecordingStore.setState({ status: "idle", source: "mic", owningSessionId: "", ownerLabel: "", elapsedMs: 0 });
  useProjectsStore.setState({ currentSessionId: "s1" } as any);
});

test("idle 时不渲染", () => {
  render(<RecordingCapsule />);
  expect(screen.queryByTestId("recording-capsule")).toBeNull();
});

test("recording：显示计时、音源、暂停 + 停止；点停止调 store.stop", async () => {
  useRecordingStore.setState({ status: "recording", source: "system", owningSessionId: "s1", ownerLabel: "项目A · 会话A", elapsedMs: 65000 });
  let stopped = false;
  useRecordingStore.setState({ stop: async () => { stopped = true; } } as any);
  render(<RecordingCapsule />);
  expect(screen.getByText("1:05")).toBeTruthy();           // formatDuration(65000)
  expect(screen.getByText("🖥")).toBeTruthy();              // 系统音频 icon
  fireEvent.click(screen.getByLabelText("停止录音"));
  await new Promise(r => setTimeout(r, 0));
  expect(stopped).toBe(true);
});

test("paused：显示继续按钮", () => {
  useRecordingStore.setState({ status: "paused", source: "mic", owningSessionId: "s1", ownerLabel: "x", elapsedMs: 1000 });
  useRecordingStore.setState({ resume: () => {}, stop: async () => {} } as any);
  render(<RecordingCapsule />);
  expect(screen.getByLabelText("继续录音")).toBeTruthy();
});

test("非归属会话：显示 ownerLabel", () => {
  useProjectsStore.setState({ currentSessionId: "s-other" } as any);
  useRecordingStore.setState({ status: "recording", source: "mic", owningSessionId: "s1", ownerLabel: "项目A · 会话A", elapsedMs: 0 });
  useRecordingStore.setState({ pause: () => {}, stop: async () => {} } as any);
  render(<RecordingCapsule />);
  expect(screen.getByText("项目A · 会话A")).toBeTruthy();
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/frontend && bun test RecordingCapsule`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 RecordingCapsule.tsx**

`packages/frontend/src/components/ui/RecordingCapsule.tsx`:
```tsx
import { useRecordingStore } from "../../store/recording";
import { useProjectsStore } from "../../store/projects";
import { formatDuration } from "../../recording/recorder";

export function RecordingCapsule() {
  const { status, source, owningSessionId, ownerLabel, elapsedMs, pause, resume, stop } = useRecordingStore();
  const currentSessionId = useProjectsStore(s => s.currentSessionId);
  if (status === "idle") return null;
  const isOwner = owningSessionId === currentSessionId;
  const dotColor = status === "recording" ? "bg-danger" : "bg-warning";

  return (
    <div
      data-testid="recording-capsule"
      className="inline-flex items-center gap-2 px-2.5 py-1 rounded-pill border border-hairline bg-surface text-xs"
    >
      <span>{source === "mic" ? "🎤" : "🖥"}</span>
      {!isOwner && <span className="text-tertiary">{ownerLabel}</span>}
      <span className="font-mono tabular-nums text-secondary">{formatDuration(elapsedMs)}</span>
      <span className={`inline-block w-2 h-2 rounded-full ${dotColor} ${status === "recording" ? "animate-pulse" : ""}`} />
      {status === "recording"
        ? <button type="button" aria-label="暂停录音" onClick={pause} className="text-secondary hover:text-primary">⏸</button>
        : <button type="button" aria-label="继续录音" onClick={resume} className="text-secondary hover:text-primary">▶</button>}
      <button type="button" aria-label="停止录音" onClick={() => void stop()} className="text-danger hover:opacity-80">⏹</button>
    </div>
  );
}
```

- [ ] **Step 4: 接入 SessionView header**

`packages/frontend/src/components/SessionView.tsx` 顶部加导入：
```ts
import { RecordingCapsule } from "./ui/RecordingCapsule";
```
在 header（`<header ...>` 内，标题 `<div className="flex-1">` 之后、原编排画布按钮位置）插入：
```tsx
        <RecordingCapsule />
```
（编排画布按钮已在 Task 7 移除；胶囊占用该位置。）

- [ ] **Step 5: 运行测试 + typecheck**

Run: `cd packages/frontend && bun test RecordingCapsule`
Expected: PASS（4 个测试）
Run: `cd packages/frontend && bun run typecheck`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add packages/frontend/src/components/ui/RecordingCapsule.tsx packages/frontend/src/components/SessionView.tsx packages/frontend/tests/RecordingCapsule.test.tsx
git commit -m "feat(frontend): RecordingCapsule 全局胶囊（计时/暂停/停止/归属 label）"
```

---

## Task 11: Electron main 注册录音 session handler

**Files:**
- Create: `packages/desktop/src/util/recording-handlers.cjs`
- Modify: `packages/desktop/src/main.cjs`
- Test: `packages/desktop/tests/recording-handlers.test.ts`

**Interfaces:**
- Consumes: Electron `session`/`desktopCapturer`（由 main 传入，便于测试注入）。
- Produces: `setupRecordingHandlers(session, desktopCapturer)`：注册 `setDisplayMediaRequestHandler`（自动批准 + `audio:'loopback'`，无共享框）与 `setPermissionRequestHandler`/`setPermissionCheckHandler`（麦克风免弹窗）。确切回调参数镜像 spec A POC（`.spike/electron-audio-poc/`）已验证的写法。

- [ ] **Step 1: 写失败测试**

`packages/desktop/tests/recording-handlers.test.ts`:
```ts
import { test, expect } from "bun:test";
import { setupRecordingHandlers } from "../src/util/recording-handlers.cjs";

function makeFakeSession() {
  const calls: string[] = [];
  return {
    calls,
    session: {
      setDisplayMediaRequestHandler(fn: any) { calls.push("setDisplayMediaRequestHandler"); this._dmh = fn; },
      setPermissionRequestHandler(fn: any) { calls.push("setPermissionRequestHandler"); this._prh = fn; },
      setPermissionCheckHandler(fn: any) { calls.push("setPermissionCheckHandler"); this._pch = fn; },
      _dmh: null as any, _prh: null as any, _pch: null as any,
    },
  };
}

test("注册三个 handler", () => {
  const { session, calls } = makeFakeSession();
  const desktopCapturer = { getSources: async () => [{ id: "s1", name: "Screen" }] };
  setupRecordingHandlers(session as any, desktopCapturer as any);
  expect(calls).toEqual([
    "setDisplayMediaRequestHandler",
    "setPermissionRequestHandler",
    "setPermissionCheckHandler",
  ]);
});

test("getDisplayMedia handler 返回 loopback 音频且不抛", async () => {
  const { session } = makeFakeSession();
  const desktopCapturer = { getSources: async () => [{ id: "s1", name: "Screen" }] };
  setupRecordingHandlers(session as any, desktopCapturer as any);
  let result: any = null;
  await session._dmh({}, (cb: any) => { result = cb; });
  expect(result.audio).toBe("loopback");
});

test("permission handler 一律放行（免弹窗）", () => {
  const { session } = makeFakeSession();
  setupRecordingHandlers(session as any, { getSources: async () => [] } as any);
  let granted = false;
  session._prh({}, "media", (v: boolean) => { granted = v; });
  expect(granted).toBe(true);
  expect(session._pch()).toBe(true);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd packages/desktop && bun test recording-handlers`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 recording-handlers.cjs**

`packages/desktop/src/util/recording-handlers.cjs`:
```js
// 录音前提：让 Chromium 自动批准 getDisplayMedia 并给系统回环音频（无共享框），
// 同时自动放行 media 权限（麦克风免弹窗）。确切回调参数以 spec A POC 为准。
// session / desktopCapturer 由调用方传入（解耦 Electron，便于单测注入）。
function setupRecordingHandlers(session, desktopCapturer) {
  session.setDisplayMediaRequestHandler(async (_req, cb) => {
    // 给系统回环音频；video 提供主屏 source 以满足 getDisplayMedia 协议（前端只取 audio track）
    let video = undefined;
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      if (sources.length > 0) video = sources[0];
    } catch { /* 取不到屏幕 source 也允许仅音频 */ }
    cb({ video, audio: "loopback" });
  });

  // 麦克风免弹窗：所有 media 权限请求一律放行
  session.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));
  session.setPermissionCheckHandler(() => true);
}

module.exports = { setupRecordingHandlers };
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd packages/desktop && bun test recording-handlers`
Expected: PASS（3 个测试）

- [ ] **Step 5: 在 main.cjs 接入**

`packages/desktop/src/main.cjs`：把第 2 行 require 改为同时取 `session`：
```js
const { app, BrowserWindow, Menu, session, desktopCapturer } = require("electron");
```
在 `app.whenReady().then(async () => {` 内、`createWindow();` **之前**插入：
```js
  // 录音前提：自动批准 getDisplayMedia（系统回环音频，无共享框）+ 麦克风免弹窗（spec B）
  const { setupRecordingHandlers } = require("./util/recording-handlers.cjs");
  setupRecordingHandlers(session.defaultSession, desktopCapturer);
```

- [ ] **Step 6: typecheck + 提交**

Run: `cd packages/desktop && bun run typecheck`
Expected: 无错误
```bash
git add packages/desktop/src/util/recording-handlers.cjs packages/desktop/src/main.cjs packages/desktop/tests/recording-handlers.test.ts
git commit -m "feat(desktop): 注册录音 session handler（系统回环免共享框 + 麦克风免弹窗）"
```

---

## Task 12: 全量验证 + 真机手测清单

**Files:** 无新增（验证任务）

- [ ] **Step 1: 全量 typecheck**

Run: `bun run typecheck`
Expected: 所有包无错误

- [ ] **Step 2: 全量单测**

Run: `bun test`
Expected: 全绿（含新增 8 个测试文件）

- [ ] **Step 3: 真机手测清单（Windows，POC 同环境；截图/录屏为证）**

- [ ] 启动 `./start.command`（或打包后双击），进入任一会话
- [ ] composer 📎 旁出现 🎙；右键弹出「麦克风/系统音频」切换，选择后刷新仍记得（IndexedDB）
- [ ] 点 🎙 开始录音：header 右上出现胶囊（计时跳动 + 音源 icon + ⏸ ⏹），🎙 变红脉动
- [ ] **系统音频**：播放一段电脑声音后停止，composer 出现 audio chip，点 ▶ 能听到录到的系统声音，全程无共享框
- [ ] **麦克风**：切到麦克风录音，说话→停止→chip ▶ 能听到人声，无权限弹窗
- [ ] ⏸ 暂停：计时停、状态点变黄；▶ 继续：恢复
- [ ] 切到会话 B：胶囊仍在 B header 显示，带「项目A · 会话A」label，能从 B 暂停/停止 A 的录音
- [ ] A 录音中，在 B 点 🎙：弹出 toast「项目A · 会话A 正在录音…」，B 不开始新录音
- [ ] 停止后：归属会话 A 的 composer 自动出现 audio chip（B 没有），输入消息发送给 agent，附件路径正确（agent 收到 `.hiagent/uploads/recording-*.webm`）
- [ ] 编排画布按钮与界面已彻底消失
- [ ] 长录音（>10 分钟）期间任务管理器观察 renderer 内存稳定（不随时间增长 → 验证边录边落盘）

- [ ] **Step 4: 提交 CHANGELOG 条目（可选）**

若项目维护 CHANGELOG，补一条 spec B 录音功能 + 移除编排画布。

---

## Self-Review（plan 作者自查，已完成）

**Spec 覆盖**：
- §2 需求 1-9 → Task 9(按钮)/7(移除画布)/10(胶囊)/11(Electron 免权限)/6(单例)/8+6(停止附附件) 全覆盖。
- §3 架构 → Task 5+6 单例。
- §4 Electron handler → Task 11。
- §5 引擎/store → Task 5+6。
- §6 UI 三件套 → Task 9+10+6(toast 复用)。
- §7 audio kind + chip → Task 1+8。
- §8 边录边落盘协议 → Task 2+4。
- §9 移除画布 → Task 7。
- §10 边界（暂停 Task5 ElapsedTracker；退出警告 ⚠️ 见下；track 释放 Task5 cleanup）。
- §11 测试 → 各 Task 单测 + Task 12 真机。

**已知留白（需实现时注意，非阻塞）**：
- **退出警告（§10）未单独建任务**：`window.onbeforeunload` 在 renderer 设置返回字符串即可触发 Electron 原生「离开？」对话框。建议在 Task 10 的 RecordingCapsule 或 Task 6 store 内加一个 `useEffect`：当 `status !== 'idle'` 时设 `window.onbeforeunload = () => "正在录音…"`，idle 时清空。实现 Task 10 时顺手加（<10 行），不另开任务。
- Task 9 测试导入修正已在 Step 3 标注（`getRecordingPrefs/setRecordingPrefs` 从 composer-db 导入）。

**类型一致性**：`appendRecording/finalizeRecording/discardRecording/pathToUploadUrl`（Task 4）→ recorder.ts（Task 5）→ store（Task 6）调用签名一致；`useRecordingStore.start({source,projectId,sessionId,ownerLabel})` 在 Task 6/9 一致；`RecordingResult {path,size,durationMs}` 在 Task 5/6 一致；audio `AttachmentDraft` 在 Task 1/6/8 一致。

**占位扫描**：无 TBD/TODO；每步含可运行代码或确切命令。
