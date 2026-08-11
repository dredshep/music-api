import { AppError } from "./errors";

export class Semaphore {
  private current = 0;
  constructor(private max: number, private name: string) {}

  acquire(): boolean {
    if (this.current >= this.max) return false;
    this.current++;
    return true;
  }

  release(): void {
    this.current = Math.max(0, this.current - 1);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.acquire()) {
      throw new AppError(
        "CONCURRENCY_LIMIT",
        `Too many concurrent ${this.name} operations (max ${this.max})`,
        503,
        true
      );
    }
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export const searchSemaphore = new Semaphore(2, "search");
export const generateSemaphore = new Semaphore(1, "recommendation generation");
export const catalogRefreshSemaphore = new Semaphore(2, "catalog refresh");
