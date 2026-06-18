import { describe, it, expect, vi, afterEach } from "vitest";
import { checkOpenRouterLiveness } from "../openrouter-client.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkOpenRouterLiveness", () => {
  it("пустой ключ -> missing_key, без сетевого вызова", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await checkOpenRouterLiveness("")).toEqual({ ok: false, reason: "missing_key" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("плейсхолдер YOUR_... -> missing_key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await checkOpenRouterLiveness("YOUR_OPENROUTER_API_KEY")).toEqual({
      ok: false,
      reason: "missing_key"
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("200 -> ok (и бьёт именно в /auth/key)", async () => {
    const fetchSpy = vi.fn(async (..._args: unknown[]) => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    expect(await checkOpenRouterLiveness("sk-or-v1-real")).toEqual({ ok: true, reason: "ok" });
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/auth/key");
  });

  it("401 -> unauthorized (а не ложный ok, как было с /models)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401 })));
    expect(await checkOpenRouterLiveness("sk-or-v1-bad")).toEqual({
      ok: false,
      reason: "unauthorized"
    });
  });

  it("500 -> network", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500 })));
    expect(await checkOpenRouterLiveness("sk-or-v1-x")).toEqual({ ok: false, reason: "network" });
  });

  it("исключение fetch -> network", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await checkOpenRouterLiveness("sk-or-v1-x")).toEqual({ ok: false, reason: "network" });
  });
});
