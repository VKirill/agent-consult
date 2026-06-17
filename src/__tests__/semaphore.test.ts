import { describe, it, expect, vi } from "vitest";
import { Semaphore } from "../index.js";

describe("Semaphore", () => {
  it("should limit concurrency", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    const results: number[] = [];

    const task = async (id: number) => {
      await sem.acquire();
      active++;
      expect(active).toBeLessThanOrEqual(2);
      // Имитируем работу
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      results.push(id);
      sem.release();
    };

    await Promise.all([task(1), task(2), task(3)]);
    expect(results).toHaveLength(3);
    expect(sem.getActiveCount()).toBe(0);
  });

  it("should fail when queue is full", async () => {
    const sem = new Semaphore(1, 2); // max 1 active, queue size 2
    await sem.acquire(); // 1st active

    // Добавляем в очередь
    const q1 = sem.acquire();
    const q2 = sem.acquire();

    // Третий запрос в очередь должен сразу упасть с ошибкой
    await expect(sem.acquire()).rejects.toThrow(/переполнена/);

    // Очистим семафор, чтобы завершить начатые промисы
    sem.release();
    await q1;
    sem.release();
    await q2;
    sem.release();
  });

  it("should timeout in queue", async () => {
    vi.useFakeTimers();
    const sem = new Semaphore(1, 5, 100); // 100ms timeout
    await sem.acquire(); // active

    const p = sem.acquire(); // queueing
    
    // Перематываем время вперед
    vi.advanceTimersByTime(150);

    await expect(p).rejects.toThrow(/Превышен таймаут/);
    expect(sem.getQueueLength()).toBe(0);
    vi.useRealTimers();
  });

  it("should validate release invariant", () => {
    const sem = new Semaphore(1);
    expect(() => sem.release()).toThrow(/попытка вызвать release/);
  });

  it("should validate constructor arguments", () => {
    expect(() => new Semaphore(0)).toThrow(/maxConcurrency/);
    expect(() => new Semaphore(-1)).toThrow(/maxConcurrency/);
    expect(() => new Semaphore(2, -1)).toThrow(/maxQueueSize/);
    expect(() => new Semaphore(2, 5, -1)).toThrow(/queueTimeoutMs/);
  });
});
