import { describe, it, expect } from "vitest";
import {
  cleanAndValidateModel,
  buildCliArgs,
  sanitizeEnvPath,
  buildChildEnv
} from "../agents/cli/invocation.js";

describe("cleanAndValidateModel", () => {
  it("срезает провайдерский префикс", () => {
    expect(cleanAndValidateModel("openai/gpt-5.5")).toBe("gpt-5.5");
    expect(cleanAndValidateModel("xai/grok-composer-2.5-fast")).toBe("grok-composer-2.5-fast");
  });
  it("пропускает имя без префикса", () => {
    expect(cleanAndValidateModel("sonnet")).toBe("sonnet");
  });
  it("бросает на инъекционном имени модели", () => {
    expect(() => cleanAndValidateModel("evil; rm -rf /")).toThrow(/Некорректное имя модели/);
  });
});

describe("buildCliArgs", () => {
  it("codex без reasoning", () => {
    expect(buildCliArgs("codex", "gpt-5.5", undefined, "")).toEqual([
      "exec", "-", "--model", "gpt-5.5"
    ]);
  });
  it("codex с reasoning добавляет effort", () => {
    expect(buildCliArgs("codex", "gpt-5.5", { enable: true, reasoning_effort: "high", flag: ["-c", "model_reasoning_effort={effort}"] }, "")).toEqual([
      "exec", "-", "--model", "gpt-5.5", "-c", "model_reasoning_effort=high"
    ]);
  });
  it("claude использует stream-json и план-режим; неизвестная модель -> sonnet", () => {
    expect(buildCliArgs("claude", "gpt-5.5", undefined, "")).toEqual([
      "-p", "--model", "sonnet", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"
    ]);
    expect(buildCliArgs("claude", "opus", undefined, "")).toContain("opus");
  });
  it("claude с reasoning -> добавляет --effort <level>", () => {
    const args = buildCliArgs("claude", "opus", { enable: true, reasoning_effort: "high", flag: ["--effort", "{effort}"] }, "");
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });
  it("agy/gemini -> -p -", () => {
    expect(buildCliArgs("agy", "x", undefined, "")).toEqual(["-p", "-"]);
    expect(buildCliArgs("gemini", "x", undefined, "")).toEqual(["-p", "-"]);
  });
  it("mimo без модели -> run --pure", () => {
    expect(buildCliArgs("mimo", "x", undefined, "")).toEqual(["run", "--pure"]);
  });
  it("mimo с моделью -> добавляет --model полный provider/model", () => {
    expect(buildCliArgs("mimo", "mimo-v2.5-pro", undefined, "", "xiaomi/mimo-v2.5-pro")).toEqual([
      "run", "--pure", "--model", "xiaomi/mimo-v2.5-pro"
    ]);
  });
  it("mimo с reasoning -> добавляет --variant <effort>", () => {
    expect(buildCliArgs("mimo", "mimo-v2.5-pro", { enable: true, reasoning_effort: "high", flag: ["--variant", "{effort}"] }, "", "xiaomi/mimo-v2.5-pro")).toEqual([
      "run", "--pure", "--model", "xiaomi/mimo-v2.5-pro", "--variant", "high"
    ]);
  });
  it("grok передаёт prompt-file и модель, кроме дефолтной 'grok'", () => {
    expect(buildCliArgs("grok", "grok-composer-2.5-fast", undefined, "/tmp/p.txt")).toEqual([
      "--no-memory", "--permission-mode", "auto", "--prompt-file", "/tmp/p.txt", "--model", "grok-composer-2.5-fast"
    ]);
    expect(buildCliArgs("grok", "grok", undefined, "/tmp/p.txt")).toEqual([
      "--no-memory", "--permission-mode", "auto", "--prompt-file", "/tmp/p.txt"
    ]);
  });
});

describe("sanitizeEnvPath", () => {
  it("оставляет только абсолютные пути без .. и .", () => {
    const res = sanitizeEnvPath("/usr/bin:relative/bin:/opt/x/..:/sbin:.");
    expect(res).toBe("/usr/bin:/sbin");
  });
});

describe("buildChildEnv", () => {
  it("ставит HOME/PATH и hardening-переменные", () => {
    const env = buildChildEnv("/home/agent", "/usr/bin");
    expect(env.HOME).toBe("/home/agent");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.NO_COLOR).toBe("1");
    expect(env.PAGER).toBe("cat");
    expect(env.GEMINI_CLI_NO_RELAUNCH).toBe("1");
  });
});
