import { describe, it, expect, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThinkingSelector } from "../src/components/ui/ThinkingSelector";

describe("ThinkingSelector", () => {
  it("renders four options", () => {
    render(<ThinkingSelector value="disabled" onChange={() => {}} />);
    const select = screen.getByTestId("thinking-selector") as HTMLSelectElement;
    expect(select.options.length).toBe(4);
    expect(select.options[0].text).toBe("思考 off");
    expect(select.options[1].text).toBe("思考 mid");
    expect(select.options[2].text).toBe("思考 high");
    expect(select.options[3].text).toBe("思考 max");
  });

  it("calls onChange with selected value", () => {
    const onChange = mock();
    render(<ThinkingSelector value="disabled" onChange={onChange} />);
    const select = screen.getByTestId("thinking-selector") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "max" } });
    expect(onChange).toHaveBeenCalledWith("max");
  });
});
