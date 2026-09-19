import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { buildMatchExpr } from "../src/memory/query";

test("汉字查询转为引号包裹的二元组 AND 序列", () => {
	expect(buildMatchExpr("发版")).toBe('"发版"');
	expect(buildMatchExpr("发版流程")).toBe('"发版" "版流" "流程"');
});

test("空查询与非空字符查询返回 null", () => {
	expect(buildMatchExpr("")).toBeNull();
	expect(buildMatchExpr("   ")).toBeNull();
});

test("双引号被翻倍转义，不破坏 FTS5 语法", () => {
	expect(buildMatchExpr('a"b')).toBe('"a""b"');
});

test("FTS5 运算符与括号被包进引号，不再抛错", () => {
	expect(buildMatchExpr("(")).toBe('"("');
	expect(buildMatchExpr("*")).toBe('"*"');
	expect(buildMatchExpr("AND OR")).toBe('"and" "or"');
});

test("真实数据库：特殊字符查询不再抛 SQLiteError", () => {
	const db = new Database(":memory:");
	db.run("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='unicode61')");
	db.run("INSERT INTO t(body) VALUES (?)", ['("a""b")']);

	for (const q of ['a"b', "(", "*", "AND OR"]) {
		const expr = buildMatchExpr(q);
		expect(expr).not.toBeNull();
		expect(() =>
			db.query("SELECT body FROM t WHERE t MATCH ?").all(expr as string),
		).not.toThrow();
	}
});
