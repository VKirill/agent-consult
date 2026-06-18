import { describe, it, expect } from "vitest";
import {
  detectsInteractiveAuth,
  detectToolActivity,
  parseToolNameFromText
} from "../agents/cli/output-filters.js";

describe("detectsInteractiveAuth", () => {
  it("ловит claude/codex/grok auth-приглашения", () => {
    expect(detectsInteractiveAuth("To sign in, open this URL: https://x")).toBe(true);
    expect(detectsInteractiveAuth("Waiting for authorization")).toBe(true);
    expect(detectsInteractiveAuth("visit https://x/oauth2/device now")).toBe(true);
  });

  it("не ложно срабатывает на исходном коде с теми же словами", () => {
    expect(detectsInteractiveAuth('if (outputToCheck.includes("To sign in, open this URL: https://"))')).toBe(false);
    expect(detectsInteractiveAuth("const x = 1; // Waiting for authorization")).toBe(false);
  });

  it("обычный вывод -> false", () => {
    expect(detectsInteractiveAuth("PONG")).toBe(false);
  });
});

describe("detectToolActivity", () => {
  it("вызов инструмента", () => {
    expect(detectToolActivity("Calling tool grep")).toEqual({ isToolCall: true, isToolResult: false });
    expect(detectToolActivity("запуск инструмента")).toEqual({ isToolCall: true, isToolResult: false });
  });
  it("результат инструмента", () => {
    expect(detectToolActivity("tool_result received")).toEqual({ isToolCall: false, isToolResult: true });
  });
  it("undefined / нерелевантный текст", () => {
    expect(detectToolActivity(undefined)).toEqual({ isToolCall: false, isToolResult: false });
    expect(detectToolActivity("just generating text")).toEqual({ isToolCall: false, isToolResult: false });
  });
});

describe("parseToolNameFromText", () => {
  it("вытаскивает имя после ключевого слова", () => {
    expect(parseToolNameFromText("running gitnexus/impact done")).toBe("gitnexus/impact");
  });
  it("квирк: при 'using tool X' ловит само слово 'tool' (поведение сохранено)", () => {
    expect(parseToolNameFromText("using tool gitnexus/impact next")).toBe("tool");
  });
  it("дефолт при отсутствии", () => {
    expect(parseToolNameFromText("nothing here")).toBe("unknown_mcp_tool");
    expect(parseToolNameFromText(undefined)).toBe("unknown_mcp_tool");
  });
});
