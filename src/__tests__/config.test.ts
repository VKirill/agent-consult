import { describe, it, expect } from "vitest";
import { getAgentHome, AGENT_HOMES_ROOT, atomicWriteFile, linkCredentialSafe } from "../config.js";
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

  it("should linkCredentialSafe create symlink", async () => {
    await fs.mkdir(tempDir, { recursive: true });
    
    const realFile = path.join(tempDir, "real.txt");
    await fs.writeFile(realFile, "sensitive data");

    const destFile = path.join(tempDir, "dest.txt");
    
    await linkCredentialSafe(realFile, destFile);

    // Должна создаться символическая ссылка
    const stat = await fs.lstat(destFile);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = await fs.readlink(destFile);
    expect(target).toBe(realFile);

    await fs.unlink(realFile);
    await fs.unlink(destFile).catch(() => {});
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
