import { describe, it, expect } from "vitest";
import { classifyClaudeEvent, parseClaudeStreamLine } from "../agents/cli/claude-stream.js";

describe("classifyClaudeEvent", () => {
  it("tool_use напрямую", () => {
    expect(classifyClaudeEvent({ type: "tool_use", name: "grep", input: { q: 1 }, id: "t1" })).toEqual({
      kind: "tool_use", toolName: "grep", toolInput: { q: 1 }, toolUseId: "t1"
    });
  });

  it("tool_use через content_block_start", () => {
    const ev = { type: "content_block_start", content_block: { type: "tool_use", name: "read", input: {}, id: "cb1" } };
    expect(classifyClaudeEvent(ev)).toEqual({ kind: "tool_use", toolName: "read", toolInput: {}, toolUseId: "cb1" });
  });

  it("tool_use внутри assistant.message.content", () => {
    const ev = { type: "assistant", message: { content: [{ type: "text" }, { type: "tool_use", name: "glob", input: { p: "*" }, id: "a1" }] } };
    expect(classifyClaudeEvent(ev)).toEqual({ kind: "tool_use", toolName: "glob", toolInput: { p: "*" }, toolUseId: "a1" });
  });

  it("tool_result через user.message.content", () => {
    const ev = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1" }] } };
    expect(classifyClaudeEvent(ev)).toEqual({ kind: "tool_result", toolName: "a1", toolUseId: "a1" });
  });

  it("content_block_stop -> tool_result", () => {
    expect(classifyClaudeEvent({ type: "content_block_stop" }).kind).toBe("tool_result");
  });

  it("result", () => {
    expect(classifyClaudeEvent({ type: "result", result: "PONG" })).toEqual({ kind: "result", result: "PONG" });
  });

  it("result без поля -> пустая строка", () => {
    expect(classifyClaudeEvent({ type: "result" })).toEqual({ kind: "result", result: "" });
  });

  it("error", () => {
    expect(classifyClaudeEvent({ type: "error", message: "boom" })).toEqual({ kind: "error", message: "boom" });
  });

  it("неизвестный тип -> other", () => {
    expect(classifyClaudeEvent({ type: "system" }).kind).toBe("other");
  });
});

describe("parseClaudeStreamLine", () => {
  it("пустая строка -> null", () => {
    expect(parseClaudeStreamLine("   ")).toBeNull();
  });

  it("нераспарсиваемый JSON -> null", () => {
    expect(parseClaudeStreamLine("not json {")).toBeNull();
  });

  it("обрезает мусор после последней }", () => {
    const ev = parseClaudeStreamLine('{"type":"result","result":"ok"}garbage-tail');
    expect(ev).toEqual({ kind: "result", result: "ok" });
  });

  it("валидная строка result", () => {
    expect(parseClaudeStreamLine('{"type":"result","result":"PONG"}')).toEqual({ kind: "result", result: "PONG" });
  });
});
