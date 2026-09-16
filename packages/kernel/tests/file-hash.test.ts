import { describe, expect, test } from "bun:test";
import { hashFileContent } from "../src/share/file-hash";

describe("hashFileContent", () => {
  test("确定性：相同内容+扩展名产生相同 hash", () => {
    const a = hashFileContent(new TextEncoder().encode("hello world"), "html");
    const b = hashFileContent(new TextEncoder().encode("hello world"), "html");
    expect(a).toBe(b);
  });

  test("不同内容产生不同 hash", () => {
    const a = hashFileContent(new TextEncoder().encode("hello"), "html");
    const b = hashFileContent(new TextEncoder().encode("world"), "html");
    expect(a).not.toBe(b);
  });

  test("hash 为 32 字符 hex（内容寻址 key 格式）", () => {
    const h = hashFileContent(new TextEncoder().encode("hello world"), "html");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
  });

  test("扩展名参与 hash（同内容不同扩展名结果不同）", () => {
    const a = hashFileContent(new TextEncoder().encode("hello"), "html");
    const b = hashFileContent(new TextEncoder().encode("hello"), "txt");
    expect(a).not.toBe(b);
  });
});
