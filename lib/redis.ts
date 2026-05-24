import { Redis } from "@upstash/redis";

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  throw new Error("Redis environment variables are not set");
}

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

/**
 * Distributed lock implementation using Redis
 * This ensures only one process can execute critical sections at a time
 */
export class DistributedLock {
  private redis: Redis;
  private lockKey: string;
  private lockValue: string;
  private ttl: number;

  constructor(lockKey: string, ttl: number = 10000) {
    this.redis = redis;
    this.lockKey = `lock:${lockKey}`;
    this.lockValue = `${Date.now()}-${Math.random()}`;
    this.ttl = ttl;
  }

  /**
   * Acquire the lock with retry mechanism
   */
  async acquire(maxRetries: number = 20, retryDelay: number = 50): Promise<boolean> {
    for (let i = 0; i < maxRetries; i++) {
      const acquired = await this.redis.set(this.lockKey, this.lockValue, {
        nx: true,
        px: this.ttl,
      });

      if (acquired === "OK") {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }

    return false;
  }

  /**
   * Release the lock
   */
  async release(): Promise<void> {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    await this.redis.eval(script, [this.lockKey], [this.lockValue]);
  }

  /**
   * Execute a function with automatic lock acquisition and release
   */
  static async withLock<T>(
    lockKey: string,
    fn: () => Promise<T>,
    ttl: number = 10000
  ): Promise<T> {
    const lock = new DistributedLock(lockKey, ttl);

    const acquired = await lock.acquire();
    if (!acquired) {
      throw new Error("Failed to acquire lock");
    }

    try {
      return await fn();
    } finally {
      await lock.release();
    }
  }
}
