// fs-client 单测辅助：把 REST 传输抽象成可注入的 fake，保留旧 WS 风格的
// { type, ... } 请求/响应语义，让现有测试改动最小。
import type { FsTransport } from "../src/fs-client";

export interface FsCall {
  method: "GET" | "POST" | "DELETE";
  path: string;
  type: string;
  body?: unknown;
}

function deriveType(method: string, path: string): string {
  if (method === "GET" && path === "/api/fs/home") return "fs:home";
  if (method === "GET" && path === "/api/fs/roots") return "fs:roots";
  if (method === "POST" && path === "/api/fs/list-dir") return "fs:listDir";
  if (method === "POST" && path === "/api/fs/read-file") return "fs:readFile";
  if (method === "POST" && path === "/api/fs/copy") return "fs:copy";
  if (method === "POST" && path === "/api/fs/search") return "fs:search";
  if (method === "POST" && path === "/api/fs/search/cancel") return "fs:search:cancel";
  if (method === "POST" && path === "/api/files/recording/append") return "fs:recording:append";
  if (method === "POST" && path === "/api/files/recording/finalize") return "fs:recording:finalize";
  if (method === "POST" && path === "/api/files/recording/discard") return "fs:recording:discard";
  return `fs:${method}:${path}`;
}

export interface FakeFsTransport {
  /** 注入 fs-client 的传输对象 */
  transport: FsTransport;
  /** 已发出的 REST 调用明细 */
  calls: FsCall[];
  /** 旧 WS 风格的发送记录（方便保持既有断言） */
  sent: any[];
  /** 注册在 transport 上的事件监听器 */
  handlers: Set<(e: any) => void>;
  /** 向所有监听器广播一条事件 */
  emit: (e: any) => void;
  /** 为某类请求预置立即返回的响应体 */
  setResponse: (type: string, payload: unknown) => void;
  /** 预置响应映射 */
  responses: Map<string, unknown>;
}

export type FsResponder = (
  e: any,
  emit: (e: any) => void,
  call: FsCall,
) => unknown | Promise<unknown> | void | Promise<void>;

export function makeFakeFsTransport(responder?: FsResponder): FakeFsTransport {
  const calls: FsCall[] = [];
  const sent: any[] = [];
  const handlers = new Set<(e: any) => void>();
  const responses = new Map<string, unknown>();
  const emit = (e: any) => handlers.forEach((h) => h(e));

  async function handle(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const type = deriveType(method, path);
    const call: FsCall = { method, path, type, body };
    calls.push(call);
    const evt = body !== undefined ? { type, ...(body as object) } : { type, path };
    sent.push(evt);

    const resp = await responder?.(evt, emit, call);
    if (resp !== undefined) return resp;
    if (responses.has(type)) return responses.get(type);
    return {};
  }

  const transport: FsTransport = {
    get: (path) => handle("GET", path),
    post: (path, body) => handle("POST", path, body),
    del: (path, body) => handle("DELETE", path, body),
  };

  return {
    transport,
    calls,
    sent,
    handlers,
    emit,
    responses,
    setResponse: (type, payload) => responses.set(type, payload),
  };
}
