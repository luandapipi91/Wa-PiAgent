/**
 * 文件 / 录音通道路由（阶段二·去 WS 化）
 *
 * multipart 上传 + 录音分片 HTTP 端点（替代 base64-over-WS）。
 * 大文件不再经 WS 帧内存缓冲，直接流式写盘。
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody } from "./types";
import { resolveCwdForFsRequest, uniquePath } from "../ws-server";
import { appendChunk, finalizeRecording, discardRecording } from "../recording-store";
import { mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB

async function resolveUploadDir(
  projectStore: any,
  projectId: string,
  sessionId?: string,
): Promise<string> {
  const cwd = await resolveCwdForFsRequest(projectStore, projectId, sessionId);
  const uploadDir = join(cwd, ".wa-pi", "uploads");
  await mkdir(uploadDir, { recursive: true });
  return uploadDir;
}

/** 从 multipart form-data 读取第一个 file 字段；无文件返回 null。 */
async function readMultipartFile(req: Request): Promise<{ name: string; content: Uint8Array } | null> {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("multipart/form-data")) return null;
  const form = await req.formData();
  const file = form.get("file");
  if (!file || !(file instanceof Blob)) return null;
  const content = new Uint8Array(await file.arrayBuffer());
  return { name: (file as File).name ?? "upload", content };
}

export const registerFileRoutes: RouteRegistrar = (r, _callApi, ctx) => {
  const projectStore = ctx.projectStore;

  // POST /api/files/upload：multipart 上传，替代 fs:upload base64 分片
  r.add("POST", "/api/files/upload", async (req) => {
    const projectId = new URL(req.url).searchParams.get("projectId") ?? "";
    const sessionId = new URL(req.url).searchParams.get("sessionId") ?? undefined;
    if (!projectId) return Response.json({ error: "缺少 projectId" }, { status: 400 });

    const file = await readMultipartFile(req);
    if (!file) return Response.json({ error: "缺少 file 字段" }, { status: 400 });
    if (file.content.byteLength > MAX_UPLOAD_BYTES) {
      return Response.json({ error: `文件超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限` }, { status: 400 });
    }

    try {
      const uploadDir = await resolveUploadDir(projectStore, projectId, sessionId);
      const safeName = basename(file.name).replace(/[\\/]/g, "_") || "upload";
      const filePath = await uniquePath(uploadDir, safeName);
      await writeFile(filePath, file.content);
      return Response.json({ type: "fs:upload", path: filePath });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  });

  // POST /api/files/recording/append：录音分片逐段 POST（body 含 base64 chunk）
  r.add("POST", "/api/files/recording/append", async (req) => {
    const b = await readJsonBody(req);
    const { projectId, recId, chunk, sessionId } = b;
    if (!projectId || !recId || typeof chunk !== "string") {
      return Response.json({ error: "缺少参数: projectId/recId/chunk" }, { status: 400 });
    }
    try {
      const uploadDir = await resolveUploadDir(projectStore, projectId, sessionId);
      await appendChunk(uploadDir, recId, chunk);
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  });

  // POST /api/files/recording/finalize：录音结束，合并为最终文件
  r.add("POST", "/api/files/recording/finalize", async (req) => {
    const b = await readJsonBody(req);
    const { projectId, recId, finalName, sessionId } = b;
    if (!projectId || !recId || !finalName) {
      return Response.json({ error: "缺少参数: projectId/recId/finalName" }, { status: 400 });
    }
    try {
      const uploadDir = await resolveUploadDir(projectStore, projectId, sessionId);
      const path = await finalizeRecording(uploadDir, recId, finalName);
      return Response.json({ type: "fs:recording:finalize", path });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  });

  // POST /api/files/recording/discard：放弃录音，删除临时分片
  r.add("POST", "/api/files/recording/discard", async (req) => {
    const b = await readJsonBody(req);
    const { projectId, recId, sessionId } = b;
    if (!projectId || !recId) {
      return Response.json({ error: "缺少参数: projectId/recId" }, { status: 400 });
    }
    try {
      const uploadDir = await resolveUploadDir(projectStore, projectId, sessionId);
      await discardRecording(uploadDir, recId);
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  });
};
