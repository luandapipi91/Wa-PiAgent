// 把旧 WS 风格的 { send, onMessage } fake transport 适配成新的 FsTransport { get, post, del }。
// 仅用于现有组件测试的低侵入迁移；新测试请直接用 makeFakeFsTransport。
import type { FsTransport } from "../src/fs-client";

export interface LegacyFsTransport {
  send: (e: any) => void;
  onMessage: (h: (e: any) => void) => () => void;
}

function waitForEvent<T = any>(
  onMessage: (h: (e: any) => void) => () => void,
  predicate: (e: any) => boolean,
  timeoutMs = 3000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const off = onMessage((e) => {
      if (predicate(e)) {
        off();
        clearTimeout(timer);
        resolve(e);
      }
    });
    const timer = setTimeout(() => {
      off();
      reject(new Error(`waitForEvent 超时`));
    }, timeoutMs);
  });
}

export function adaptLegacyTransport(legacy: LegacyFsTransport): FsTransport {
  return {
    get: async (path) => {
      if (path === "/api/fs/home") {
        const p = waitForEvent(legacy.onMessage, (e) => e.type === "fs:home" && e.home !== undefined);
        legacy.send({ type: "fs:home" });
        return p;
      }
      if (path === "/api/fs/roots") {
        const p = waitForEvent(legacy.onMessage, (e) => e.type === "fs:roots" && e.roots !== undefined);
        legacy.send({ type: "fs:roots" });
        return p;
      }
      return {};
    },

    post: async (path, body: any = {}) => {
      if (path === "/api/fs/list-dir") {
        const req = { type: "fs:listDir", path: body.path, showHidden: body.showHidden };
        const p = waitForEvent(legacy.onMessage, (e) => e.type === "fs:listDir" && e.path === body.path);
        legacy.send(req);
        const res = await p;
        return { entries: res.entries };
      }
      if (path === "/api/fs/read-file") {
        const req = { type: "fs:readFile", path: body.path };
        const p = waitForEvent(legacy.onMessage, (e) => e.type === "fs:readFile" && e.path === body.path);
        legacy.send(req);
        return p;
      }
      if (path === "/api/fs/copy") {
        const id = crypto.randomUUID();
        const req = { type: "fs:copy", id, projectId: body.projectId, source: body.source, sessionId: body.sessionId };
        const p = waitForEvent(legacy.onMessage, (e) => e.type === "fs:copy" && e.id === id);
        legacy.send(req);
        return p;
      }
      if (path === "/api/fs/search") {
        // searchFilesStream 自行监听 SSE 总线，传输层只需把请求发出去
        legacy.send({ type: "fs:search", ...body });
        return {};
      }
      if (path === "/api/files/recording/append") {
        const id = crypto.randomUUID();
        const req = { type: "fs:recording:append", id, projectId: body.projectId, recId: body.recId, chunk: body.chunk, sessionId: body.sessionId };
        const p = waitForEvent(legacy.onMessage, (e) => e.type === "fs:recording:append" && e.id === id);
        legacy.send(req);
        await p;
        return {};
      }
      if (path === "/api/files/recording/finalize") {
        const id = crypto.randomUUID();
        const req = { type: "fs:recording:finalize", id, projectId: body.projectId, recId: body.recId, finalName: body.finalName, sessionId: body.sessionId };
        const p = waitForEvent(legacy.onMessage, (e) => e.type === "fs:recording:finalize" && e.id === id);
        legacy.send(req);
        return p;
      }
      if (path === "/api/files/recording/discard") {
        const id = crypto.randomUUID();
        const req = { type: "fs:recording:discard", id, projectId: body.projectId, recId: body.recId, sessionId: body.sessionId };
        const p = waitForEvent(legacy.onMessage, (e) => e.type === "fs:recording:discard" && e.id === id);
        legacy.send(req);
        await p;
        return {};
      }
      return {};
    },

    del: async () => ({}),
  };
}
