export class ConcurrencyLimiter {
  private counts = new Map<string, number>();

  acquire(key: string, limit: number): boolean {
    const current = this.counts.get(key) || 0;
    if (current >= limit) {
      return false;
    }
    this.counts.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.counts.get(key) || 0;
    if (current <= 1) {
      this.counts.delete(key);
    } else {
      this.counts.set(key, current - 1);
    }
  }

  clear(): void {
    this.counts.clear();
  }

  getCount(key: string): number {
    return this.counts.get(key) || 0;
  }
}
