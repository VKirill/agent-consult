import { describe, it, expect } from "vitest";
import {
  CODEX_SANDBOX_MODES,
  CODEX_CONSULT_SANDBOX_MODE,
  assertCodexSandboxMode
} from "../core/constants.js";

describe("assertCodexSandboxMode", () => {
  it("принимает все канонические значения", () => {
    for (const mode of CODEX_SANDBOX_MODES) {
      expect(() => assertCodexSandboxMode(mode)).not.toThrow();
    }
  });

  it("отклоняет невалидный 'workspace-read' (тот самый инцидент)", () => {
    expect(() => assertCodexSandboxMode("workspace-read")).toThrow(/Недопустимый sandbox_mode/);
  });

  it("отклоняет произвольный мусор", () => {
    expect(() => assertCodexSandboxMode("nonsense")).toThrow();
  });

  it("режим консультанта — read-only и валиден", () => {
    expect(CODEX_CONSULT_SANDBOX_MODE).toBe("read-only");
    expect(() => assertCodexSandboxMode(CODEX_CONSULT_SANDBOX_MODE)).not.toThrow();
  });
});
