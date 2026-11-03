// tool-result-shared 单测：parseResultJson 纯函数（两组件共用的 JSON 探测）。
import { test, expect } from "bun:test";
import { parseResultJson } from "./tool-result-shared";

test("parseResultJson：object/array 返回解析数据", () => {
	expect(parseResultJson('{"ok":true,"n":1}')).toEqual({ ok: true, n: 1 });
	expect(parseResultJson("[1,2]")).toEqual([1, 2]);
	// 前后空白容忍（与旧内联实现一致）
	expect(parseResultJson('  {"ok":true}  ')).toEqual({ ok: true });
});

test("parseResultJson：顶层标量/非 JSON/畸形截断/null → null（降级原文）", () => {
	expect(parseResultJson('"just a string"')).toBeNull();
	expect(parseResultJson("42")).toBeNull();
	expect(parseResultJson("普通\n多行文本")).toBeNull();
	expect(parseResultJson('{"ok":true,')).toBeNull();
	expect(parseResultJson("null")).toBeNull();
	expect(parseResultJson("")).toBeNull();
});
