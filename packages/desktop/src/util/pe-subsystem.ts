// 把 Windows PE 的 Subsystem 字段从 3(CONSOLE) 改成 2(WINDOWS_GUI)，去掉双击时的黑窗。
// Bun 的 --windows-hide-console 在 1.3.14 不生效（oven-sh/bun#24164），故字节 patch。
import { open } from "node:fs/promises";

export async function readSubsystem(exePath: string): Promise<number> {
  const f = await open(exePath, "r");
  try {
    const buf = Buffer.alloc(4);
    await f.read(buf, 0, 4, 0x3c);
    const eLfanew = buf.readUInt32LE(0);
    const opt = eLfanew + 24; // optional header 起点
    const sub = Buffer.alloc(2);
    await f.read(sub, 0, 2, opt + 68); // PE32+ Subsystem 偏移 68
    return sub.readUInt16LE(0);
  } finally {
    await f.close();
  }
}

export async function patchPeSubsystemToGui(
  exePath: string,
): Promise<{ before: number; after: number }> {
  const before = await readSubsystem(exePath);
  if (before === 2) return { before, after: 2 }; // 已是 GUI，幂等 no-op
  const f = await open(exePath, "r+");
  try {
    const buf = Buffer.alloc(4);
    await f.read(buf, 0, 4, 0x3c);
    const opt = buf.readUInt32LE(0) + 24;
    const gui = Buffer.from([0x02, 0x00]);
    await f.write(gui, 0, 2, opt + 68);
    await f.sync();
  } finally {
    await f.close();
  }
  return { before, after: await readSubsystem(exePath) };
}
