// 把构建期嵌入的资源（前端 dist / systray helper / 图标）解压到真实缓存目录。
// 嵌入资源在 compiled binary 里是虚拟路径，用 Bun.file() 读字节再写到真实 fs。
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Asset {
  src: string;
  dest: string;
}

export async function extractAssets(
  assets: Asset[],
  cacheDir: string,
): Promise<string> {
  await mkdir(cacheDir, { recursive: true });
  for (const a of assets) {
    const dest = join(cacheDir, a.dest);
    // 已存在则跳过（避免每次启动重写）
    const exists = await access(dest)
      .then(() => true)
      .catch(() => false);
    if (exists) continue;
    const data = await Bun.file(a.src).arrayBuffer();
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(data));
  }
  return cacheDir;
}
