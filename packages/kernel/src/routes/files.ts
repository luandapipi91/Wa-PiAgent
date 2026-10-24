/**
 * 文件 / 录音通道路由（阶段二·去 WS 化）
 *
 * multipart 上传 + 录音分片 HTTP 端点（替代 base64-over-WS）。
 * 大文件不再经 WS 帧内存缓冲，直接流式写盘。
 */
import type { RouteRegistrar } from "./types";
import { readJsonBody, paramErrorResponse } from "./types";
import { toKernelPayload } from "@wa-pi/shared";
import { resolveCwdForFsRequest, uniquePath, isPathInProjects } from "../ws-server";
import {
  appendChunk,
  finalizeRecording,
  discardRecording,
} from "../recording-store";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join, basename, dirname, extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB
/** 图片标注覆盖写回的体积上限：100MB */
export const MAX_OVERWRITE_BYTES = 100 * 1024 * 1024;
/** 允许覆盖写回的图片扩展名（标注工具只产出这几种） */
export const OVERWRITE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

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
async function readMultipartFile(
  req: Request,
): Promise<{ name: string; content: Uint8Array } | null> {
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
    const sessionId =
      new URL(req.url).searchParams.get("sessionId") ?? undefined;
    if (!projectId) return paramErrorResponse("缺少 projectId", "projectId");

    const file = await readMultipartFile(req);
    if (!file) return paramErrorResponse("缺少 file 字段", "file");
    if (file.content.byteLength > MAX_UPLOAD_BYTES) {
      // code 化错误：error 保留旧文案兜底，code/params 收进嵌套 failure 供新前端按字典渲染
      return Response.json(
        {
          error: `文件超过 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 上限`,
          failure: {
            code: "attachment.tooLarge",
            params: { maxMb: MAX_UPLOAD_BYTES / 1024 / 1024 },
          },
        },
        { status: 400 },
      );
    }

    try {
      const uploadDir = await resolveUploadDir(
        projectStore,
        projectId,
        sessionId,
      );
      const safeName = basename(file.name).replace(/[\\/]/g, "_") || "upload";
      const filePath = await uniquePath(uploadDir, safeName);
      await writeFile(filePath, file.content);
      return Response.json({ type: "fs:upload", path: filePath });
    } catch (e) {
      const payload = toKernelPayload(e);
      return Response.json(
        {
          error: e instanceof Error ? e.message : String(e),
          ...(payload ? { failure: payload } : {}),
        },
        { status: 500 },
      );
    }
  });

  // POST /api/files/overwrite：标注结果覆盖写回项目工作区内的既有图片
  // （先写同目录临时文件再 rename，避免半截内容；失败一律清掉临时文件）
  r.add("POST", "/api/files/overwrite", async (req) => {
    const ct = req.headers.get("content-type") ?? "";
    const form = ct.includes("multipart/form-data")
      ? await req.formData()
      : null;
    const file = form?.get("file");
    const targetPath = form?.get("path");
    if (
      !(file instanceof Blob) ||
      typeof targetPath !== "string" ||
      !targetPath
    ) {
      return paramErrorResponse("缺少 file/path 字段", "file/path");
    }

    // 路径授权：realpath 必须落在某个项目工作区内（isPathInProjects 口径，与 /file、
    // /preview 一致），且必须 exists——不存在的文件不能借这个接口新建。
    // 不限制具体子目录：项目内任意既有图片都可被标注覆盖（用户明确不要 uploads 白名单）。
    // 保留「必须在项目内」这条底线，否则就成了任意绝对路径写入接口。
    const { projects } = await projectStore.load();
    const hit = isPathInProjects(resolve(targetPath), projects);
    const real = hit.kind === "exists" ? hit.path : "";
    if (!real) {
      return Response.json(
        {
          error: "只能覆盖项目工作区内已存在的文件",
          failure: { code: "fs.forbidden" },
        },
        { status: 403 },
      );
    }

    // 扩展名以 realpath 为准：项目内的符号链接可能指向另一个扩展名的文件，
    // 只查请求路径会让 png 字节写进 gif 等非图片文件
    if (!OVERWRITE_EXTS.has(extname(real).toLowerCase())) {
      return Response.json(
        {
          error: "仅支持覆盖 png/jpg/jpeg/webp 图片",
          failure: { code: "imageAnn.unsupported" },
        },
        { status: 400 },
      );
    }
    if (file.size > MAX_OVERWRITE_BYTES) {
      return Response.json(
        {
          error: `文件超过 ${MAX_OVERWRITE_BYTES / 1024 / 1024}MB 上限`,
          failure: {
            code: "attachment.tooLarge",
            params: { maxMb: MAX_OVERWRITE_BYTES / 1024 / 1024 },
          },
        },
        { status: 400 },
      );
    }

    // 临时名带随机后缀：并发/重试的两次覆盖不会互相抹掉对方的临时文件
    const tmp = join(
      dirname(real),
      `.annotate-${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(tmp, new Uint8Array(await file.arrayBuffer()));
      await rename(tmp, real);
      return Response.json({ type: "fs:overwrite", path: real });
    } catch (e) {
      const payload = toKernelPayload(e);
      return Response.json(
        {
          error: e instanceof Error ? e.message : String(e),
          ...(payload ? { failure: payload } : {}),
        },
        { status: 500 },
      );
    } finally {
      await rm(tmp, { force: true });
    }
  });

  // POST /api/files/recording/append：录音分片逐段 POST（body 含 base64 chunk）
  r.add("POST", "/api/files/recording/append", async (req) => {
    const b = await readJsonBody(req);
    const { projectId, recId, chunk, sessionId } = b;
    if (!projectId || !recId || typeof chunk !== "string") {
      return paramErrorResponse(
        "缺少参数: projectId/recId/chunk",
        "projectId/recId/chunk",
      );
    }
    try {
      const uploadDir = await resolveUploadDir(
        projectStore,
        projectId,
        sessionId,
      );
      await appendChunk(uploadDir, recId, chunk);
      return Response.json({ ok: true });
    } catch (e) {
      const payload = toKernelPayload(e);
      return Response.json(
        {
          error: e instanceof Error ? e.message : String(e),
          ...(payload ? { failure: payload } : {}),
        },
        { status: 500 },
      );
    }
  });

  // POST /api/files/recording/finalize：录音结束，合并为最终文件
  r.add("POST", "/api/files/recording/finalize", async (req) => {
    const b = await readJsonBody(req);
    const { projectId, recId, finalName, sessionId } = b;
    if (!projectId || !recId || !finalName) {
      return paramErrorResponse(
        "缺少参数: projectId/recId/finalName",
        "projectId/recId/finalName",
      );
    }
    try {
      const uploadDir = await resolveUploadDir(
        projectStore,
        projectId,
        sessionId,
      );
      const path = await finalizeRecording(uploadDir, recId, finalName);
      return Response.json({ type: "fs:recording:finalize", path });
    } catch (e) {
      const payload = toKernelPayload(e);
      return Response.json(
        {
          error: e instanceof Error ? e.message : String(e),
          ...(payload ? { failure: payload } : {}),
        },
        { status: 500 },
      );
    }
  });

  // POST /api/files/recording/discard：放弃录音，删除临时分片
  r.add("POST", "/api/files/recording/discard", async (req) => {
    const b = await readJsonBody(req);
    const { projectId, recId, sessionId } = b;
    if (!projectId || !recId) {
      return paramErrorResponse("缺少参数: projectId/recId", "projectId/recId");
    }
    try {
      const uploadDir = await resolveUploadDir(
        projectStore,
        projectId,
        sessionId,
      );
      await discardRecording(uploadDir, recId);
      return Response.json({ ok: true });
    } catch (e) {
      const payload = toKernelPayload(e);
      return Response.json(
        {
          error: e instanceof Error ? e.message : String(e),
          ...(payload ? { failure: payload } : {}),
        },
        { status: 500 },
      );
    }
  });
};
