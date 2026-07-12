import { test, expect } from "bun:test";
import { writeFile, rm } from "node:fs/promises";
import { patchPeSubsystemToGui, readSubsystem } from "../src/util/pe-subsystem";

// 构造最小 PE32+ 头：DOS header + PE sig + COFF + optional header（subsystem=3）。
// 真实 PE 结构的字节布局，避免复制 ~100MB 的 bun.exe。
function buildMinimalPe(subsystem: number): Buffer {
  const buf = Buffer.alloc(512, 0);
  // DOS: e_lfanew @ 0x3c → PE header at 0x40
  buf.writeUInt32LE(0x40, 0x3c);
  // PE signature "PE\0\0" @ 0x40
  buf.write("PE\0\0", 0x40, "ascii");
  // COFF header @ 0x44 (20 bytes): Machine=AMD64, SizeOfOptionalHeader=0xF0
  buf.writeUInt16LE(0x8664, 0x44); // Machine = IMAGE_FILE_MACHINE_AMD64
  buf.writeUInt16LE(0x00f0, 0x54); // SizeOfOptionalHeader = 240 (PE32+)
  // Optional header @ 0x58
  buf.writeUInt16LE(0x020b, 0x58); // Magic = 0x20B (PE32+)
  // Subsystem @ optional+68 = 0x58 + 0x44 = 0x9C
  buf.writeUInt16LE(subsystem, 0x9c);
  return buf;
}

test("patchPeSubsystemToGui: 把 CONSOLE(3) 改成 GUI(2)", async () => {
  const fixture = `${import.meta.dir}/.fixture.exe`;
  await writeFile(fixture, buildMinimalPe(3));
  try {
    const before = await readSubsystem(fixture);
    expect(before).toBe(3);
    const { after } = await patchPeSubsystemToGui(fixture);
    expect(after).toBe(2);
    expect(await readSubsystem(fixture)).toBe(2);
  } finally {
    await rm(fixture, { force: true });
  }
});

test("patchPeSubsystemToGui: 已是 GUI(2) 时是 no-op（幂等）", async () => {
  const fixture = `${import.meta.dir}/.fixture-gui.exe`;
  await writeFile(fixture, buildMinimalPe(2));
  try {
    const { before, after } = await patchPeSubsystemToGui(fixture);
    expect(before).toBe(2);
    expect(after).toBe(2);
    expect(await readSubsystem(fixture)).toBe(2);
  } finally {
    await rm(fixture, { force: true });
  }
});
