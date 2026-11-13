import { describe, test, expect, afterAll } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { externalizeImages } from "../src/knowledge/convert/inline-images";

// 每次运行独立的临时目录，结束后整体清理
const tmp = mkdtempSync(join(tmpdir(), "kb-inline-img-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("data URI 外联化", () => {
  test("两个完整 data URI → 落盘 2 文件 + 相对引用 + 零残留", () => {
    const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const md = `# t\n\n![a](data:image/png;base64,${png1x1.toString("base64")})\n\n![b](data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDIzNP/AABEIAAEAAQMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAABfQECAwAEEQUSITFBBhNRYQcicQYygKFCkaGxwzI3InKjBGUr/lcX/9oADAMBAAIRAxEAPwCdABmX/9k=)`;
    const mdPath = join(tmp, "顾客", "x.docx.md");
    const r = externalizeImages(md, mdPath, "顾客/x.docx", join(tmp, "source"));
    expect(r.markdown).not.toMatch(/data:image/);      // 审查重点 1
    expect(r.images.length).toBe(2);
    // 引用经整段 encodeURI，中文「顾客」→ %E9%A1%BE%E5%AE%A2
    expect(r.markdown).toContain("../source/%E9%A1%BE%E5%AE%A2/x.docx/img1.png");
    expect(Bun.file(r.images[0]).size).toBeGreaterThan(0);
  });

  test("引用路径空格转 %20（审查重点 4）", () => {
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const mdPath = join(tmp, "员工 app", "y.md");
    const r = externalizeImages(`![p](data:image/png;base64,${tinyPng})`, mdPath, "员工 app/y.docx", join(tmp, "source"));
    expect(r.markdown).toContain("../source/%E5%91%98%E5%B7%A5%20app/");  // encodeURI 形态,空格→%20
    expect(r.markdown).not.toMatch(/\]\(\.\.\/source\/[^)]* [^)]*\)/);    // 引用内不得有空格
  });
});
