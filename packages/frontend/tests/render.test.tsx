import { test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";

test("App 渲染占位", () => {
  render(<App />);
  expect(screen.getByText("HiAgent 占位")).toBeTruthy();
});
