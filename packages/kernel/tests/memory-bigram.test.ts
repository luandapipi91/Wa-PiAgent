import { test, expect } from "bun:test";
import { bigram } from "../src/memory/bigram";

test("连续汉字切成相邻二元组", () => {
	expect(bigram("发版流程")).toBe("发版 版流 流程");
});

test("单个汉字保留原字", () => {
	expect(bigram("好")).toBe("好");
});

test("英文与数字不切分，统一小写", () => {
	expect(bigram("Mac Win 11")).toBe("mac win 11");
});

test("中英混排只切汉字段", () => {
	expect(bigram("用 bun 打包 mac")).toBe("用 bun 打包 mac");
});

test("标点作为独立段保留", () => {
	expect(bigram("发版，打包")).toBe("发版 ， 打包");
});

test("空串与纯标点返回空串", () => {
	expect(bigram("")).toBe("");
	expect(bigram("   ")).toBe("");
});

test("emoji 不被破坏", () => {
	expect(bigram("完成 🎉")).toBe("完成 🎉");
});
