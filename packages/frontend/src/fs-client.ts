// 把 fs 系列 WS 消息封装成 Promise，供 react-complex-tree DataProvider 异步调用。
import { send, onMessage } from "./ws-instance";
import type { DirEntry } from "@hiagent/shared";

export function getHome(): Promise<string> {
  return new Promise((resolve) => {
    const off = onMessage((e) => {
      if (e.type === "fs:home") { resolve(e.home); off(); }
    });
    send({ type: "fs:home" });
  });
}

export function getRoots(): Promise<string[]> {
  return new Promise((resolve) => {
    const off = onMessage((e) => {
      if (e.type === "fs:roots") { resolve(e.roots); off(); }
    });
    send({ type: "fs:roots" });
  });
}

export function listDir(path: string, showHidden?: boolean): Promise<DirEntry[]> {
  return new Promise((resolve) => {
    const off = onMessage((e) => {
      if (e.type === "fs:listDir" && e.path === path) { resolve(e.entries); off(); }
      else if (e.type === "fs:error" && e.path === path) { resolve([]); off(); }
    });
    send({ type: "fs:listDir", path, showHidden });
  });
}

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

export function copyToUploads(projectId: string, source: string, timeoutMs = 30000): Promise<{ path: string }> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const off = onMessage((e: any) => {
      if (e.type === "fs:copy" && e.id === id) {
        clearTimeout(timer);
        off();
        if (e.error) reject(new Error(e.error));
        else resolve({ path: e.path });
      }
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error("复制到上传目录超时"));
    }, timeoutMs);
    send({ type: "fs:copy", id, projectId, source });
  });
}

export function uploadFile(projectId: string, name: string, content: string, timeoutMs = 30000): Promise<{ path: string }> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const off = onMessage((e: any) => {
      if (e.type === "fs:upload" && e.id === id) {
        clearTimeout(timer);
        off();
        if (e.error) reject(new Error(e.error));
        else resolve({ path: e.path });
      }
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error("上传超时"));
    }, timeoutMs);
    send({ type: "fs:upload", id, projectId, name, content });
  });
}

export function searchFiles(
  query: string,
  opts: { root?: string; maxResults?: number; showHidden?: boolean; onlyDirs?: boolean; timeoutMs?: number } = {},
): Promise<{ query: string; matches: { name: string; isDir: boolean; path: string }[]; durationMs: number; truncated: boolean }> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const off = onMessage((e: any) => {
      if (e.type === "fs:search" && e.requestId === id) {
        clearTimeout(timer);
        off();
        resolve(e);
      }
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error("搜索超时"));
    }, opts.timeoutMs ?? 30000);
    send({ type: "fs:search", query, root: opts.root, maxResults: opts.maxResults, showHidden: opts.showHidden, onlyDirs: opts.onlyDirs, requestId: id });
  });
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

  const off = onMessage((e: any) => {
    if (cleaned) return;
    if (e.type === "fs:search:progress" && pending.has(e.requestId)) {
      handlers.onProgress(e.matches);
    } else if (e.type === "fs:search" && pending.has(e.requestId)) {
      handlers.onProgress(e.matches);
      pending.delete(e.requestId);
      totalDuration += e.durationMs;
      if (e.truncated) anyTruncated = true;
      if (pending.size === 0) {
        handlers.onDone({ durationMs: totalDuration, truncated: anyTruncated });
        off();
        cleaned = true;
      }
    }
  });

  for (const r of requests) {
    send({ type: "fs:search", query, root: r.root, maxResults: opts.maxResults, showHidden: opts.showHidden, onlyDirs: opts.onlyDirs, requestId: r.requestId });
  }

  return () => {
    if (!cleaned) {
      off();
      cleaned = true;
    }
    for (const r of requests) {
      send({ type: "fs:search:cancel", requestId: r.requestId });
    }
  };
}
