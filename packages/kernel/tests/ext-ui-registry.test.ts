import { test, expect, beforeEach } from "bun:test";
import { ExtUiRegistry } from "../src/ext-ui-registry";

let reg: ExtUiRegistry;
beforeEach(() => { reg = new ExtUiRegistry(); });

const req = (id: string) => ({ type: "extension_ui_request" as const, id, method: "confirm", title: "t" });

test("register 阻塞直到 respond，返回业务字段", async () => {
  const p = reg.register("s1", req("r1"));
  expect(reg.respond("r1", { confirmed: true })).toBe(true);
  await expect(p).resolves.toEqual({ confirmed: true });
});

test("respond 未知/重复 id 返回 false", async () => {
  expect(reg.respond("nope", { cancelled: true })).toBe(false);
  const p = reg.register("s1", req("r2"));
  expect(reg.respond("r2", { cancelled: true })).toBe(true);
  expect(reg.respond("r2", { cancelled: true })).toBe(false);
  await p;
});

test("cancelAllForSession 以 cancelled 解决该会话全部 pending，不影响其他会话", async () => {
  const p1 = reg.register("s1", req("a"));
  const p2 = reg.register("s2", req("b"));
  reg.cancelAllForSession("s1");
  await expect(p1).resolves.toEqual({ cancelled: true });
  expect(reg.respond("b", { value: "x" })).toBe(true);
  await expect(p2).resolves.toEqual({ value: "x" });
});
