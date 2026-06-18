import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

export async function atomicWriteFile(filePath: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    const options = typeof content === "string"
      ? { encoding: "utf-8" as const, mode: 0o600 }
      : { mode: 0o600 };
    await fs.writeFile(tmpPath, content, options);
    await fs.rename(tmpPath, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (err: unknown) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export async function linkCredentialSafe(src: string, dest: string): Promise<void> {
  try {
    const srcExists = await fs.access(src).then(() => true).catch(() => false);
    if (!srcExists) return;

    const dir = path.dirname(dest);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    // Удаляем старый файл/симлинк, если он есть, чтобы избежать EEXIST
    await fs.unlink(dest).catch(() => {});

    await fs.symlink(src, dest);
  } catch (err: any) {
    process.stderr.write(`[Config] Ошибка создания символической ссылки с ${src} на ${dest}: ${err.message}\n`);
  }
}
