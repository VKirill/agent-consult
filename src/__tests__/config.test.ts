import { describe, it, expect } from "vitest";
import { getAgentHome, AGENT_HOMES_ROOT, atomicWriteFile, copyCredentialSafe } from "../config.js";
import path from "path";
import fs from "fs/promises";
import os from "os";

describe("getAgentHome", () => {
  it("should return correct path without sessionId", () => {
    const agentHome = getAgentHome("claude");
    expect(agentHome).toBe(path.join(AGENT_HOMES_ROOT, "claude"));
  });

  it("should return correct path with sessionId", () => {
    const agentHome = getAgentHome("claude", "test-session-123");
    expect(agentHome).toBe(path.join(AGENT_HOMES_ROOT, "sessions", "test-session-123", "claude"));
  });

  it("should sanitize agentName and sessionId to prevent path traversal", () => {
    const agentHome = getAgentHome("claude/../invalid", "session/../invalid");
    expect(agentHome).toContain("sessions");
    expect(agentHome).not.toContain("..");
  });
});

describe("atomicWriteFile and copyCredentialSafe security", () => {
  const tempDir = path.join(os.tmpdir(), `agent-consult-test-${Date.now()}`);

  it("should write file atomically and with 0o600 permissions", async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const targetFile = path.join(tempDir, "test.txt");
    await atomicWriteFile(targetFile, "hello world");

    const content = await fs.readFile(targetFile, "utf-8");
    expect(content).toBe("hello world");

    const stat = await fs.stat(targetFile);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }

    await fs.unlink(targetFile);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should prevent copyCredentialSafe from following symlinks (TOCTOU protection)", async () => {
    await fs.mkdir(tempDir, { recursive: true });
    
    const realFile = path.join(tempDir, "real.txt");
    await fs.writeFile(realFile, "sensitive data");

    const symlinkFile = path.join(tempDir, "symlink.txt");
    try {
      await fs.symlink(realFile, symlinkFile);
    } catch (symErr) {
      // На Windows создание симлинков может требовать прав администратора, пропускаем если не удалось
      await fs.rm(tempDir, { recursive: true, force: true });
      return;
    }

    const destFile = path.join(tempDir, "dest.txt");
    
    // Пытаемся скопировать симлинк. Метод должен проигнорировать его
    await copyCredentialSafe(symlinkFile, destFile);

    // Целевой файл не должен быть создан
    await expect(fs.access(destFile)).rejects.toThrow();

    await fs.unlink(realFile);
    await fs.unlink(symlinkFile).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
