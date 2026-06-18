import { describe, it, expect, vi } from "vitest";
import {
  TimeoutController,
  ACTIVE_IDLE_TIMEOUT_MS,
  MCP_TOOL_IDLE_TIMEOUT_MS
} from "../agents/cli/timeout-controller.js";

function make(onTerminate = vi.fn()) {
  return new TimeoutController({
    agentName: "test",
    pid: undefined, // killProcessGroup no-op при undefined -> без реального process.kill
    isWindows: false,
    absoluteTimeoutMs: 1000,
    onTerminate
  });
}

describe("TimeoutController", () => {
  it("noteActivity возвращает ACTIVE/MCP idle в зависимости от выполнения инструмента", () => {
    const c = make();
    expect(c.noteActivity(false)).toBe(ACTIVE_IDLE_TIMEOUT_MS);
    expect(c.noteActivity(true)).toBe(MCP_TOOL_IDLE_TIMEOUT_MS);
    c.markSettled(); // гасим вооружённый idle-таймер
  });

  it("terminate зовёт onTerminate ровно один раз; повторный вызов — no-op", () => {
    const onT = vi.fn();
    const c = make(onT);
    c.terminate("boom", "SIGKILL");
    c.terminate("again", "SIGKILL");
    expect(onT).toHaveBeenCalledTimes(1);
    expect(onT).toHaveBeenCalledWith("boom");
    expect(c.isSettled).toBe(true);
  });

  it("markSettled блокирует последующий terminate", () => {
    const onT = vi.fn();
    const c = make(onT);
    c.markSettled();
    c.terminate("boom", "SIGTERM");
    expect(onT).not.toHaveBeenCalled();
  });

  it("абсолютный таймаут -> terminate (fake timers)", () => {
    vi.useFakeTimers();
    try {
      const onT = vi.fn();
      const c = make(onT);
      c.start();
      vi.advanceTimersByTime(1001);
      expect(onT).toHaveBeenCalledWith(expect.stringMatching(/абсолютный таймаут/));
    } finally {
      vi.useRealTimers();
    }
  });
});
