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
});
