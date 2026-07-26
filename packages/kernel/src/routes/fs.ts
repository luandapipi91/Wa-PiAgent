/**
 * 文件系统域路由（阶段二·去 WS 化）
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";
import { resolveCwdForFsRequest, uniquePath } from "../ws-server";
import { readdir, readFile, copyFile, stat, mkdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { DirEntry } from "@hiagent/shared";
import { getMimeType } from "../ws-server";

export const registerFsRoutes: RouteRegistrar = (r, callApi, ctx) => {
  r.add("GET", "/api/fs/home", async () => Response.json({ type: "fs:home", home: homedir() }));

  r.add("GET", "/api/fs/roots", async () => {
    if (process.platform === "win32") {
      const roots: string[] = [];
      for (let i = 67; i <= 90; i++) {
        const drive = String.fromCharCode(i) + ":\\";
        if (existsSync(drive)) roots.push(drive);
      }
      return Response.json({ type: "fs:roots", roots });
    }
    return Response.json({ type: "fs:roots", roots: ["/"] });
  });

  // 搜索：进度帧经 callApi 自动转 SSE 总线（带 requestId），最终结果为响应体
  r.add("POST", "/api/fs/search", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "fs:search", ...b });
  });

  r.add("POST", "/api/fs/search/cancel", async (req) => {
    const b = await readJsonBody(req);
    return callApi({ type: "fs:search:cancel", requestId: b.requestId });
  });

  // POST /api/fs/list-dir：列出目录
  r.add("POST", "/api/fs/list-dir", async (req) => {
    const b = await readJsonBody(req);
    const { path, showHidden } = b;
    if (typeof path !== "string") return Response.json({ error: "缺少 path" }, { status: 400 });
    try {
      const dirents = await readdir(path, { withFileTypes: true });
      const entries: DirEntry[] = (await Promise.all(
        dirents.map(async (d) => {
          let isDir = d.isDirectory();
          if (d.isSymbolicLink()) {
            try {
              const s = await stat(join(path, d.name));
              isDir = s.isDirectory();
            } catch {
              isDir = false;
            }
          }
          return { name: d.name, isDir };
        })
      )).filter((e) => showHidden || !e.name.startsWith("."));
      return Response.json({ type: "fs:listDir", path, entries });
    } catch (e) {
      return Response.json({ type: "fs:error", path, reason: String(e instanceof Error ? e.message : e) });
    }
  });

  // POST /api/fs/read-file：读取文件为 base64
  r.add("POST", "/api/fs/read-file", async (req) => {
    const b = await readJsonBody(req);
    const { path } = b;
    if (typeof path !== "string") return Response.json({ error: "缺少 path" }, { status: 400 });
    try {
      const buffer = await readFile(path);
      const content = buffer.toString("base64");
      const mimeType = getMimeType(path);
      return Response.json({ type: "fs:readFile", path, content, mimeType });
    } catch (e) {
      return Response.json({ type: "fs:error", path, reason: String(e instanceof Error ? e.message : e) });
    }
  });

  // POST /api/fs/copy：复制文件/文件夹到项目 uploads
  r.add("POST", "/api/fs/copy", async (req) => {
    const b = await readJsonBody(req);
    const { projectId, source, sessionId } = b;
    if (!projectId || typeof source !== "string") {
      return Response.json({ error: "缺少参数: projectId/source" }, { status: 400 });
    }
    try {
      const cwd = await resolveCwdForFsRequest(ctx.projectStore, projectId, sessionId);
      const sourceStat = await stat(source);
      const isDir = sourceStat.isDirectory();
      if (isDir) {
        return Response.json({ type: "fs:copy", path: source });
      }
      const uploadDir = join(cwd, ".hiagent", "uploads");
      await mkdir(uploadDir, { recursive: true });
      const name = basename(source);
      const destPath = await uniquePath(uploadDir, name);
      await copyFile(source, destPath);
      return Response.json({ type: "fs:copy", path: destPath });
    } catch (e) {
      return Response.json({ type: "fs:copy", path: "", error: String(e instanceof Error ? e.message : e) });
    }
  });
};
