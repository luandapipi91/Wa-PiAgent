import { describe, test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModelSelector } from "../src/components/ui/ModelSelector";
import { useProvidersStore } from "../src/store/providers";

mock.module("../src/ws-instance", () => ({
  send: () => {},
  onMessage: () => () => {},
}));

describe("ModelSelector", () => {
  beforeEach(() => {
    useProvidersStore.setState({
      providers: [{
        id: "p1", name: "Test", baseUrl: "http://x", apiKey: "k", api: "openai-completions",
        models: [
          { id: "m1", contextWindow: 128000, maxTokens: 4096 },
          { id: "m2", contextWindow: 128000, maxTokens: 4096 },
        ],
      }],
    });
  });

  test("renders model options from providers", () => {
    const onChange = mock();
    render(<ModelSelector value="m1" onChange={onChange} />);
    expect(screen.getByTestId("model-selector")).toBeTruthy();
    expect(screen.getByText("Test/m1")).toBeTruthy();
    expect(screen.getByText("Test/m2")).toBeTruthy();
  });

  test("changing value triggers onChange", () => {
    const onChange = mock();
    render(<ModelSelector value="m1" onChange={onChange} />);
    const select = screen.getByTestId("model-selector") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "m2" } });
    expect(onChange).toHaveBeenCalledWith("m2");
  });

  test("disables the select when disabled is true", () => {
    render(<ModelSelector value="m1" onChange={() => {}} disabled />);
    const select = screen.getByTestId("model-selector") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  test("renders empty hint when no models are configured", () => {
    useProvidersStore.setState({ providers: [] });
    render(<ModelSelector value={null} onChange={() => {}} />);
    expect(screen.getByText("未配置模型")).toBeTruthy();
  });
});
