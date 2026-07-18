import { test, expect, beforeEach } from "bun:test";
import { useExtensionsStore } from "../src/store/extensions";

beforeEach(() => {
  useExtensionsStore.setState({ packages: [], installs: {}, upgrading: {}, error: null });
});

test("installPackage 添加 installing 占位条目", () => {
  useExtensionsStore.getState().installPackage("foo");
  expect(useExtensionsStore.getState().installs["foo"]).toEqual({
    name: "foo",
    status: "installing",
  });
});

test("applyProgress 更新 installing 条目的进度消息", () => {
  useExtensionsStore.getState().installPackage("foo");
  useExtensionsStore.getState().applyProgress({
    type: "extension:progress",
    name: "foo",
    message: "下载 foo@1.2.3",
  });
  expect(useExtensionsStore.getState().installs["foo"].progress).toBe("下载 foo@1.2.3");
});

test("applyProgress 对未知条目无副作用", () => {
  useExtensionsStore.getState().applyProgress({
    type: "extension:progress",
    name: "nope",
    message: "x",
  });
  expect(useExtensionsStore.getState().installs["nope"]).toBeUndefined();
});

test("completeInstall 移除占位条目（真实卡片由 packages 提供）", () => {
  useExtensionsStore.getState().installPackage("foo");
  useExtensionsStore.getState().completeInstall({
    type: "extension:install:done",
    name: "foo",
  });
  expect(useExtensionsStore.getState().installs["foo"]).toBeUndefined();
});

test("setError 对 installing 条目标记 failed + 错误信息", () => {
  useExtensionsStore.getState().installPackage("foo");
  useExtensionsStore.getState().setError({
    type: "extension:error",
    name: "foo",
    error: "网络超时",
  });
  const entry = useExtensionsStore.getState().installs["foo"];
  expect(entry.status).toBe("failed");
  expect(entry.error).toBe("网络超时");
});

test("setError 对无占位条目（如卸载失败）落到全局 error", () => {
  useExtensionsStore.getState().setError({
    type: "extension:error",
    name: "bar",
    error: "卸载失败",
  });
  expect(useExtensionsStore.getState().installs["bar"]).toBeUndefined();
  expect(useExtensionsStore.getState().error).toBe("卸载失败");
});

test("retryInstall 把 failed 条目重置为 installing 并清错", () => {
  useExtensionsStore.getState().installPackage("foo");
  useExtensionsStore.getState().setError({
    type: "extension:error",
    name: "foo",
    error: "boom",
  });
  useExtensionsStore.getState().retryInstall("foo");
  const entry = useExtensionsStore.getState().installs["foo"];
  expect(entry.status).toBe("installing");
  expect(entry.error).toBeUndefined();
});

test("removeInstall 删除条目", () => {
  useExtensionsStore.getState().installPackage("foo");
  useExtensionsStore.getState().removeInstall("foo");
  expect(useExtensionsStore.getState().installs["foo"]).toBeUndefined();
});

test("setAll 更新 packages 但不影响 installs", () => {
  useExtensionsStore.getState().installPackage("foo");
  useExtensionsStore.getState().setAll({
    type: "extension:changed",
    packages: [{ name: "real", source: "npm", enabled: true }],
  });
  expect(useExtensionsStore.getState().packages).toHaveLength(1);
  expect(useExtensionsStore.getState().installs["foo"]).toBeDefined();
});

// ===== 升级反馈（upgrading 状态）=====

test("upgradePackage 标记 upgrading 状态（升级中）", () => {
  useExtensionsStore.getState().upgradePackage("foo");
  expect(useExtensionsStore.getState().upgrading["foo"]).toBe("");
});

test("applyProgress 更新 upgrading 条目的进度消息", () => {
  useExtensionsStore.getState().upgradePackage("foo");
  useExtensionsStore.getState().applyProgress({
    type: "extension:progress",
    name: "foo",
    message: "下载 foo@2.0.0",
  });
  expect(useExtensionsStore.getState().upgrading["foo"]).toBe("下载 foo@2.0.0");
});

test("setAll（extension:changed）清除 upgrading（升级完成）", () => {
  useExtensionsStore.setState({ upgrading: { foo: "下载中" } });
  useExtensionsStore.getState().setAll({
    type: "extension:changed",
    packages: [{ name: "foo", source: "npm", enabled: true }],
  });
  expect(useExtensionsStore.getState().upgrading["foo"]).toBeUndefined();
});

test("setError 清除 upgrading 并落到全局 error（升级失败）", () => {
  useExtensionsStore.setState({ upgrading: { foo: "下载中" } });
  useExtensionsStore.getState().setError({
    type: "extension:error",
    name: "foo",
    error: "升级失败",
  });
  expect(useExtensionsStore.getState().upgrading["foo"]).toBeUndefined();
  expect(useExtensionsStore.getState().error).toBe("升级失败");
});
