import { test, expect } from "bun:test";
import {
  buildTrayMenu,
  buildAppMenuTemplate,
  buildEditMenuTemplate,
} from "../src/util/menu.cjs";

test("buildTrayMenu: 两项 + 分隔（label 顺序）", () => {
  const m = buildTrayMenu(
    () => {},
    () => {},
  );
  const labels = m
    .filter((x: any) => x.type !== "separator")
    .map((x: any) => x.label);
  expect(labels).toEqual(["打开 WA PI Agent", "退出"]);
});

test("buildTrayMenu: 点退出触发 onQuit", () => {
  let quit = 0;
  const m = buildTrayMenu(
    () => {},
    () => {
      quit++;
    },
  );
  const item: any = m.find((x: any) => x.label === "退出");
  item.click();
  expect(quit).toBe(1);
});

test("buildAppMenuTemplate: macOS 菜单为中文且仅保留必要菜单", () => {
  const menu = buildAppMenuTemplate("WaPi");
  const labels = menu.map((m: any) => m.label);
  expect(labels).toEqual(["WaPi", "编辑", "窗口"]);
});

test("buildAppMenuTemplate: App 菜单含关于/隐藏/退出", () => {
  const menu = buildAppMenuTemplate("WaPi");
  const appMenu = menu.find((m: any) => m.label === "WaPi");
  const labels = appMenu.submenu
    .filter((x: any) => x.type !== "separator")
    .map((x: any) => x.label);
  expect(labels).toEqual([
    "关于 WaPi",
    "隐藏 WaPi",
    "隐藏其他",
    "显示全部",
    "退出 WaPi",
  ]);
});

test("buildAppMenuTemplate: 编辑菜单含复制粘贴全选", () => {
  const menu = buildAppMenuTemplate("WaPi");
  const editMenu = menu.find((m: any) => m.label === "编辑");
  const roles = editMenu.submenu
    .filter((x: any) => x.type !== "separator")
    .map((x: any) => x.role);
  expect(roles).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
});

test("buildEditMenuTemplate: 仅含编辑菜单且带全部编辑 role（撤销快捷键依赖）", () => {
  const menu = buildEditMenuTemplate();
  expect(menu).toHaveLength(1);
  expect(menu[0].label).toBe("编辑");
  const roles = menu[0].submenu
    .filter((x: any) => x.type !== "separator")
    .map((x: any) => x.role);
  expect(roles).toEqual(["undo", "redo", "cut", "copy", "paste", "selectAll"]);
});

test("buildAppMenuTemplate: 编辑菜单复用 buildEditMenuTemplate 同一数据", () => {
  const shared = buildEditMenuTemplate()[0];
  const menu = buildAppMenuTemplate("WaPi");
  const editMenu = menu.find((m: any) => m.label === "编辑");
  expect(editMenu).toEqual(shared);
});
