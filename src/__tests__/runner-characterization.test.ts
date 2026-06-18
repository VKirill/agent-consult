import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { AgentConfig } from "../core/config.js";

// Характеризационный harness: подменяем child_process.spawn фейковым
// процессом и драйвим его события, чтобы зафиксировать поведение
// queryLocalCLI БЕЗ запуска реальных CLI. Это страховка перед
// дальнейшей декомпозицией spawn/timer-ядра.

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { on: () => void; write: () => void; end: () => void };
  pid: number;
  kill: () => void;
}

vi.mock("child_process", () => {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { on: () => {}, write: () => {}, end: () => {} };
  child.pid = 999999;
  child.kill = () => {};
  return {
    spawn: () => child,
    spawnSync: () => ({ status: 0 }),
    __child: child
  };
});

import * as childProcess from "child_process";
import { queryLocalCLI } from "../agents/runner.js";

function getChild(): FakeChild {
  return (childProcess as unknown as { __child: FakeChild }).__child;
}

const cfg = (model: string) => ({ model }) as unknown as AgentConfig;

describe("queryLocalCLI (characterization, mock spawn)", () => {
  beforeEach(() => {
    const c = getChild();
    c.stdout.removeAllListeners();
    c.stderr.removeAllListeners();
    c.removeAllListeners();
  });

  it("claude: собирает результат из stream-json события result", async () => {
    const p = queryLocalCLI("claude", cfg("sonnet"), "sys", "вопрос", 1000);
    const c = getChild();
    await new Promise((r) => setImmediate(r));
    c.stdout.emit("data", Buffer.from('{"type":"result","result":"ПРИВЕТ-ОТВЕТ"}\n'));
    c.emit("close", 0);
    const res = await p;
    expect(res).toContain("ПРИВЕТ-ОТВЕТ");
  });

  it("ненулевой код выхода -> reject со stderr", async () => {
    const p = queryLocalCLI("codex", cfg("gpt-5.5"), "sys", "вопрос", 1000);
    const c = getChild();
    await new Promise((r) => setImmediate(r));
    c.stderr.emit("data", Buffer.from("boom failure"));
    c.emit("close", 1);
    await expect(p).rejects.toThrow(/завершился с кодом 1[\s\S]*boom failure/);
  });

  it("обычный (не-claude) агент: возвращает очищенный stdout", async () => {
    const p = queryLocalCLI("gemini", cfg("gemini-2.5-pro"), "sys", "вопрос", 1000);
    const c = getChild();
    await new Promise((r) => setImmediate(r));
    c.stdout.emit("data", Buffer.from("PONG\n"));
    c.emit("close", 0);
    const res = await p;
    expect(res).toContain("PONG");
  });

  it("idle-таймаут без данных -> reject (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const p = queryLocalCLI("gemini", cfg("gemini-2.5-pro"), "sys", "вопрос", 1000);
      p.catch(() => {}); // не даём unhandled rejection до advance
      // INITIAL_IDLE_TIMEOUT_MS = 120000; данные не шлём
      await vi.advanceTimersByTimeAsync(120_001);
      await expect(p).rejects.toThrow(/таймаут неактивности/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("error-событие процесса -> reject с ошибкой", async () => {
    const p = queryLocalCLI("gemini", cfg("x"), "sys", "вопрос", 1000);
    const c = getChild();
    await new Promise((r) => setImmediate(r));
    c.emit("error", new Error("spawn ENOENT"));
    await expect(p).rejects.toThrow(/spawn ENOENT/);
  });

  it("интерактивный auth в stdout -> reject (SIGKILL)", async () => {
    const p = queryLocalCLI("gemini", cfg("x"), "sys", "вопрос", 1000);
    const c = getChild();
    await new Promise((r) => setImmediate(r));
    c.stdout.emit("data", Buffer.from("To sign in, open this URL: https://auth.example/login"));
    await expect(p).rejects.toThrow(/не авторизован/);
  });

  it("превышение лимита 10MB stdout -> reject", async () => {
    const p = queryLocalCLI("gemini", cfg("x"), "sys", "вопрос", 1000);
    const c = getChild();
    await new Promise((r) => setImmediate(r));
    c.stdout.emit("data", Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
    await expect(p).rejects.toThrow(/Превышен лимит вывода/);
  });

  it("idle при активном MCP-инструменте -> сообщение про выполнение инструмента", async () => {
    vi.useFakeTimers();
    try {
      const p = queryLocalCLI("gemini", cfg("x"), "sys", "вопрос", 1000);
      p.catch(() => {});
      const c = getChild();
      // активность инструмента -> idle переключается на MCP_TOOL_IDLE_TIMEOUT_MS (150000)
      c.stdout.emit("data", Buffer.from("calling tool gitnexus"));
      await vi.advanceTimersByTimeAsync(150_001);
      await expect(p).rejects.toThrow(/активное выполнение MCP-инструмента/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("kill-escalation: SIGTERM, затем через 3с SIGKILL группе", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const p = queryLocalCLI("gemini", cfg("x"), "sys", "вопрос", 1000);
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(120_001); // idle -> terminate SIGTERM
      killSpy.mockClear();
      await vi.advanceTimersByTimeAsync(3_001); // эскалация -> SIGKILL
      expect(killSpy).toHaveBeenCalledWith(-999999, "SIGKILL");
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
