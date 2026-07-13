import { test, expect } from "bun:test";
import { buildTrayMenu, buildAppMenuTemplate } from "../src/util/menu.cjs";

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

test("buildAppMenuTemplate: macOS 菜单为中文且仅保留必要菜单", () => {
  const menu = buildAppMenuTemplate("HiAgent");
  const labels = menu.map((m: any) => m.label);
  expect(labels).toEqual(["HiAgent", "编辑", "窗口"]);
});

test("buildAppMenuTemplate: App 菜单含关于/隐藏/退出", () => {
  const menu = buildAppMenuTemplate("HiAgent");
  const appMenu = menu.find((m: any) => m.label === "HiAgent");
  const labels = appMenu.submenu.filter((x: any) => x.type !== "separator").map((x: any) => x.label);
  expect(labels).toEqual(["关于 HiAgent", "隐藏 HiAgent", "隐藏其他", "显示全部", "退出 HiAgent"]);
});

test("buildAppMenuTemplate: 编辑菜单含复制粘贴全选", () => {
  const menu = buildAppMenuTemplate("HiAgent");
  const editMenu = menu.find((m: any) => m.label === "编辑");
  const roles = editMenu.submenu.filter((x: any) => x.type !== "separator").map((x: any) => x.role);
  expect(roles).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
});
