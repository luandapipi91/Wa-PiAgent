import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface ShareRecord {
  id: string;
  url: string;
  projectName: string;
  channel: string;
  createdAt: number;
  expiresAt: number; // 部署时间 + 3h
  paths: string[];
}

async function readJson(file: string): Promise<{ shares?: ShareRecord[] }> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}
async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

export async function loadShares(file: string): Promise<ShareRecord[]> {
  return (await readJson(file)).shares ?? [];
}
export async function appendShare(
  file: string,
  rec: ShareRecord,
): Promise<void> {
  const shares = await loadShares(file);
  await writeJson(file, { shares: [...shares, rec] });
}
export async function removeShare(file: string, id: string): Promise<void> {
  const shares = (await loadShares(file)).filter((s) => s.id !== id);
  await writeJson(file, { shares });
}
