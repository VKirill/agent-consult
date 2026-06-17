import { describe, it, expect } from "vitest";
import { cleanCLIOutput, stripAnsi } from "../consult-orchestrator.js";

describe("stripAnsi", () => {
  it("should remove color codes", () => {
    expect(stripAnsi("\u001b[31mHello\u001b[0m")).toBe("Hello");
  });

  it("should return empty string for empty input", () => {
    expect(stripAnsi("")).toBe("");
  });
});

describe("cleanCLIOutput", () => {
  it("should remove warnings and experimental messages", () => {
    const input = "Warning: Deprecated feature\n(node:12345) ExperimentalWarning: Custom warning\n[Codex] Starting...\nHello World\n> input line";
    expect(cleanCLIOutput(input)).toBe("Hello World");
  });

  it("should remove gemini CLI thought logs", () => {
    const input = "Reading file...\nsearching the web...\nI will examine the folder.\nActual important answer";
    expect(cleanCLIOutput(input)).toBe("Actual important answer");
  });

  it("should return trimmed output", () => {
    expect(cleanCLIOutput("  some output  ")).toBe("some output");
  });
});
