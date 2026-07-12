import { test, expect } from "bun:test";
import { buildTrayMenu } from "../src/util/menu.cjs";

test("buildTrayMenu: 两项 + 分隔（label 顺序）", () => {
  const m = buildTrayMenu(() => {}, () => {});
  const labels = m.filter((x: any) => x.type !== "separator").map((x: any) => x.label);
  expect(labels).toEqual(["打开 HiAgent", "退出"]);
});

test("buildTrayMenu: 点退出触发 onQuit", () => {
  let quit = 0;
  const m = buildTrayMenu(() => {}, () => { quit++; });
  const item: any = m.find((x: any) => x.label === "退出");
  item.click();
  expect(quit).toBe(1);
});
