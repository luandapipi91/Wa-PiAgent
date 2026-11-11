import { describe, test, expect } from "bun:test";
import { stemToken, tokenizeForSearch, signalTokens, normalizedQueryText, STOP_WORDS } from "../src/knowledge/search/query";
import { MAX_SEARCH_RESULTS, MAX_SEARCH_WINDOW } from "../src/knowledge/search/contracts";

describe("分词（对齐上游 query.js）", () => {
  test("契约常量", () => {
    expect(MAX_SEARCH_RESULTS).toBe(50);
    expect(MAX_SEARCH_WINDOW).toBe(800);
  });
  test("stem：ies→y、ing、ed、复数 s", () => {
    expect(stemToken("policies")).toBe("policy");
    expect(stemToken("indexing")).toBe("index");
    expect(stemToken("indexed")).toBe("index");
    expect(stemToken("tokens")).toBe("token");
    expect(stemToken("cat")).toBe("cat");
  });
  test("英文分词小写、去标点、拼写纠正", () => {
    const t = tokenizeForSearch("How to Setup the Config?");
    expect(t.has("how")).toBe(true);
    expect(t.has("setup")).toBe(true);
    expect(t.has("setpu")).toBe(false);
  });
  test("中文查询保留单字 token（不允许被过滤成空集）", () => {
    const t = tokenizeForSearch("定价政策");
    expect(t.size).toBeGreaterThan(0);
  });
  test("signalTokens 去掉停用词并 stem", () => {
    const s = signalTokens(new Set(["the", "policies", "how"]));
    expect([...s].sort()).toEqual(["policy"]);
    expect(STOP_WORDS.has("the")).toBe(true);
  });
  test("normalizedQueryText 是空格连接的 token 串", () => {
    expect(normalizedQueryText("定价 政策")).toBe("定价 政策");
  });
});
