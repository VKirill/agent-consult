import { spawnSync } from "child_process";

// Завершение группы процессов дочернего CLI. Leaf-функция без общего
// изменяемого состояния — первый вынесенный кусок spawn/timer-ядра
// queryLocalCLI. POSIX: сначала шлём сигнал группе (-pid), при ESRCH
// (нет группы) — самому процессу.

export function killProcessGroup(
  pid: number | undefined,
  signal: "SIGTERM" | "SIGKILL",
  isWindows: boolean
): void {
  if (!pid || pid <= 0) return;
  try {
    if (isWindows) {
      spawnSync("C:\\Windows\\System32\\taskkill.exe", ["/pid", pid.toString(), "/f", "/t"]);
    } else {
      try {
        process.kill(-pid, signal);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") {
          process.kill(pid, signal);
        } else {
          throw err;
        }
      }
    }
  } catch {
    // Процесс уже мог завершиться — игнорируем.
  }
}
