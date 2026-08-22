import { describe, expect, test } from "bun:test";
import { resolveAbsolutePath } from "./FilePill";

// resolveAbsolutePath 的路径归一化：盘符/绝对路径直接返回并转正斜杠，
// 相对路径才拼 cwd（cwd 解析依赖 store，盘符分支不触发，故无需 mock）。
describe("resolveAbsolutePath", () => {
  test("Windows 盘符绝对路径（反斜杠/正斜杠）直接返回并归一化", () => {
    expect(resolveAbsolutePath("H:\\workspace\\foo.ts", "s1")).toBe("H:/workspace/foo.ts");
    expect(resolveAbsolutePath("H:/workspace/foo.ts", "s1")).toBe("H:/workspace/foo.ts");
  });

  test("Unix 绝对路径与 ~ 直接返回", () => {
    expect(resolveAbsolutePath("/abs/foo.ts", "s1")).toBe("/abs/foo.ts");
    expect(resolveAbsolutePath("~/foo.ts", "s1")).toBe("~/foo.ts");
  });
});
