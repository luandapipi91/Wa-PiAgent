// 官网青蛙彩蛋音效回归测试。
// 官网（website/index.html，单文件静态页）的青蛙点击音效必须使用
// 产品系统内置的真实青蛙叫（event-done-3.mp3 字节级一致，base64 内嵌），
// 不允许回退为 Web Audio oscillator 合成的电子模拟音。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "bun:test";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const html = readFileSync(join(repoRoot, "website", "index.html"), "utf8");
const frogMp3 = readFileSync(
	join(import.meta.dir, "..", "public", "sounds", "event-done-3.mp3"),
);

test("官网青蛙彩蛋不再使用 Web Audio 合成电子蛙鸣", () => {
	expect(html).not.toContain("createOscillator");
	expect(html).not.toContain("sawtooth");
});

test("官网内嵌音频与产品系统青蛙叫 event-done-3.mp3 字节级一致", () => {
	const marker = "data:audio/mpeg;base64,";
	const start = html.indexOf(marker);
	expect(start).toBeGreaterThan(-1);
	const b64 = html.slice(start + marker.length).match(/^[A-Za-z0-9+/=]+/)?.[0];
	expect(b64).toBeDefined();
	const embedded = Buffer.from(b64 ?? "", "base64");
	expect(embedded.equals(frogMp3)).toBe(true);
});

test("官网青蛙点击走 Audio 播放逻辑且静默降级", () => {
	expect(html).toMatch(/new Audio\(FROG_CROAK_SRC\)/);
	expect(html).toMatch(/\.play\(\)\.catch/);
});
