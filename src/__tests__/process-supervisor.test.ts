import { describe, it, expect, vi, afterEach } from "vitest";
import { killProcessGroup } from "../agents/cli/process-supervisor.js";

afterEach(() => vi.restoreAllMocks());

describe("killProcessGroup", () => {
  it("pid<=0 или undefined -> ничего не делает", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    killProcessGroup(0, "SIGTERM", false);
    killProcessGroup(undefined, "SIGTERM", false);
    killProcessGroup(-5, "SIGTERM", false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("валидный pid -> сигнал группе процессов (-pid)", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    killProcessGroup(12345, "SIGTERM", false);
    expect(spy).toHaveBeenCalledWith(-12345, "SIGTERM");
  });

  it("ESRCH на группе -> фолбэк на одиночный pid", () => {
    const spy = vi.spyOn(process, "kill").mockImplementation((p: number) => {
      if (p === -777) {
        const e = new Error("no such group") as NodeJS.ErrnoException;
        e.code = "ESRCH";
        throw e;
      }
      return true;
    });
    killProcessGroup(777, "SIGKILL", false);
    expect(spy).toHaveBeenCalledWith(-777, "SIGKILL");
    expect(spy).toHaveBeenCalledWith(777, "SIGKILL");
  });

  it("прочая ошибка kill проглатывается (процесс уже мёртв)", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("EPERM");
    });
    expect(() => killProcessGroup(42, "SIGTERM", false)).not.toThrow();
  });
});
