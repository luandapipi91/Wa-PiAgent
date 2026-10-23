import { test, expect, beforeEach } from "bun:test";
import { useSettingsStore } from "../src/store/settings";

beforeEach(() => useSettingsStore.setState({ showSettings: false }));

test("open 设置 showSettings true", () => {
  useSettingsStore.getState().open();
  expect(useSettingsStore.getState().showSettings).toBe(true);
});

test("close 设置 showSettings false", () => {
  useSettingsStore.getState().open();
  useSettingsStore.getState().close();
  expect(useSettingsStore.getState().showSettings).toBe(false);
});
