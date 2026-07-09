import { describe, it, expect, beforeEach } from "bun:test";
import { useComposerPrefsStore } from "../src/store/composer-prefs";

describe("composer-prefs store", () => {
  beforeEach(() => {
    useComposerPrefsStore.setState({
      defaults: { model: null, thinking: "disabled" },
      bySession: {},
    });
  });

  it("updates session prefs and defaults", () => {
    useComposerPrefsStore.getState().setSessionPrefs("s1", { model: "gpt-4o", thinking: "high" });
    const state = useComposerPrefsStore.getState();
    expect(state.bySession["s1"].model).toBe("gpt-4o");
    expect(state.defaults.model).toBe("gpt-4o");
  });
});
