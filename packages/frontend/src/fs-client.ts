// 把 fs 系列 REST 调用封装成 Promise，供 react-complex-tree DataProvider 异步调用。
import { api } from "./api-client";
import type { DirEntry } from "@wa-pi/shared";

/**
 * 底层传输抽象。默认走真实 api-client；单测可通过 `_setFsTransport` 注入伪传输，
 * 避免 bun `mock.module` 跨文件缓存污染。
 */
export interface FsTransport {
  get: (path: string) => Promise<unknown>;
  post: (path: string, body?: unknown) => Promise<unknown>;
  del: (path: string, body?: unknown) => Promise<unknown>;
}

const defaultTransport: FsTransport = {
  get: (path) => api.get(path),
  post: (path, body) => api.post(path, body),
  del: (path, body) => api.del(path, body),
};
let transport: FsTransport = defaultTransport;

/** 测试注入传输层；传 null 恢复默认（真实 api-client）。 */
export function _setFsTransport(t: FsTransport | null): void {
  transport = t ?? defaultTransport;
}

export async function getHome(): Promise<string> {
  const res = (await transport.get("/api/fs/home")) as { home: string };
  return res.home;
}

export async function getRoots(): Promise<string[]> {
  const res = (await transport.get("/api/fs/roots")) as { roots: string[] };
  return res.roots;
}

export async function listDir(path: string, showHidden?: boolean): Promise<DirEntry[]> {
  const res = (await transport.post("/api/fs/list-dir", { path, showHidden })) as { entries?: DirEntry[] };
  return res.entries ?? [];
}

/** 轻量文件存在性探测（不读内容），供 FilePill 挂载校验 */
export async function statFile(path: string): Promise<boolean> {
  const res = (await transport.post("/api/fs/stat", { path })) as { exists?: boolean };
  return res.exists === true;
}

export async function readFile(path: string): Promise<{ content: string; mimeType?: string; resolvedPath?: string; unsupported?: string }> {
  const res = (await transport.post("/api/fs/read-file", { path })) as { content: string; mimeType?: string; resolvedPath?: string; reason?: string; type?: string };
  if (res.type === "fs:unsupported") return { content: "", unsupported: res.reason ?? "不支持预览该文件" };
  if (!res.content) throw new Error(res.reason ?? "读取失败");
  return { content: res.content, mimeType: res.mimeType, resolvedPath: res.resolvedPath };
}

/** 在系统文件管理器中打开文件所在目录 */
export async function revealFile(path: string): Promise<void> {
  await transport.post("/api/fs/reveal-file", { path });
}

export async function copyToUploads(
  projectId: string,
  source: string,
  sessionId?: string,
): Promise<{ path: string }> {
  const res = (await transport.post("/api/fs/copy", { projectId, source, sessionId })) as { path: string; error?: string };
  if (!res.path) throw new Error(res.error ?? "复制失败");
  return { path: res.path };
}

export async function uploadFile(
  projectId: string,
  name: string,
  file: Blob,
  sessionId?: string,
): Promise<{ path: string }> {
  const form = new FormData();
  form.append("file", new File([file], name));
  const url = sessionId
    ? `/api/files/upload?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`
    : `/api/files/upload?projectId=${encodeURIComponent(projectId)}`;
  const res = await fetch(url, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status}`);
  return { path: data.path };
}

export async function searchFiles(
  query: string,
  opts: { root?: string; maxResults?: number; showHidden?: boolean; onlyDirs?: boolean } = {},
): Promise<{ query: string; matches: { name: string; isDir: boolean; path: string }[]; durationMs: number; truncated: boolean }> {
  const res = (await transport.post("/api/fs/search", { query, ...opts })) as any;
  return res;
}

export interface SearchMatch { name: string; isDir: boolean; path: string; }

export interface SearchStreamHandlers {
  onProgress: (matches: SearchMatch[]) => void;
  onDone: (result: { durationMs: number; truncated: boolean }) => void;
}

export function searchFilesStream(
  query: string,
  opts: { roots: string[]; maxResults?: number; showHidden?: boolean; onlyDirs?: boolean },
  handlers: SearchStreamHandlers,
): () => void {
  const requests = opts.roots.length > 0
    ? opts.roots.map((root) => ({ root, requestId: crypto.randomUUID() }))
    : [{ root: undefined as string | undefined, requestId: crypto.randomUUID() }];
  const pending = new Set(requests.map((r) => r.requestId));
  let totalDuration = 0;
  let anyTruncated = false;
  let cleaned = false;

  // SSE 进度监听：通过 events.ts 的 onMessage 注入，但 fs-client 不直接依赖 events
  // 这里用动态 import 避免循环依赖，单测可 mock
  let off: (() => void) | null = null;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    off?.();
  };

  import("./events").then(({ onMessage }) => {
    if (cleaned) return;
    off = onMessage((e: any) => {
      if (cleaned) return;
      if (e.type === "fs:search:progress" && pending.has(e.requestId)) {
        handlers.onProgress(e.matches);
      } else if (e.type === "fs:search" && pending.has(e.requestId)) {
        if (e.matches?.length) handlers.onProgress(e.matches);
        pending.delete(e.requestId);
        totalDuration += e.durationMs;
        if (e.truncated) anyTruncated = true;
        if (pending.size === 0) {
          handlers.onDone({ durationMs: totalDuration, truncated: anyTruncated });
          cleanup();
        }
      }
    });
  });

  for (const r of requests) {
    void transport.post("/api/fs/search", { query, root: r.root, maxResults: opts.maxResults, showHidden: opts.showHidden, onlyDirs: opts.onlyDirs, requestId: r.requestId });
  }

  return () => {
    cleanup();
    for (const r of requests) {
      void transport.post("/api/fs/search/cancel", { requestId: r.requestId });
    }
  };
}

export async function appendRecording(
  projectId: string,
  recId: string,
  chunk: string,
  sessionId?: string,
): Promise<void> {
  const res = (await transport.post("/api/files/recording/append", { projectId, recId, chunk, sessionId })) as { error?: string };
  if (res.error) throw new Error(res.error);
}

export async function finalizeRecording(
  projectId: string,
  recId: string,
  finalName: string,
  sessionId?: string,
): Promise<{ path: string }> {
  const res = (await transport.post("/api/files/recording/finalize", { projectId, recId, finalName, sessionId })) as { path: string; error?: string };
  if (!res.path) throw new Error(res.error ?? "finalize 失败");
  return { path: res.path };
}

export async function discardRecording(
  projectId: string,
  recId: string,
  sessionId?: string,
): Promise<void> {
  await transport.post("/api/files/recording/discard", { projectId, recId, sessionId });
}

/** 把附件绝对路径转成可被 <audio>/<img> 直接加载的 kernel /file URL。 */
export function pathToUploadUrl(absPath: string): string {
  return "/file?path=" + encodeURIComponent(absPath);
}
