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

export function listDir(path: string): Promise<DirEntry[]> {
  return new Promise((resolve) => {
    const off = onMessage((e) => {
      if (e.type === "fs:listDir" && e.path === path) { resolve(e.entries); off(); }
      else if (e.type === "fs:error" && e.path === path) { resolve([]); off(); }
    });
    send({ type: "fs:listDir", path });
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
