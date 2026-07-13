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
