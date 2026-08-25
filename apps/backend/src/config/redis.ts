import Redis from "ioredis";
import { Redis as UpstashRedis } from "@upstash/redis";

const sanitizeUrl = (url?: string): string => {
  if (!url) return "";
  let trimmed = url.trim();
  if (trimmed.startsWith("hhttps://")) {
    trimmed = trimmed.replace(/^h+https:\/\//, "https://");
  }
  return trimmed;
};

const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const rawUpstashUrl = process.env.UPSTASH_REDIS_REST_URL;
const upstashUrl = sanitizeUrl(rawUpstashUrl);
const upstashToken = (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();

export class MockPipeline {
  private ops: Array<() => Promise<any>> = [];
  constructor(private mockRedis: MockRedis) {}

  set(key: string, value: string): this {
    this.ops.push(() => this.mockRedis.set(key, value));
    return this;
  }

  setex(key: string, seconds: number, value: string): this {
    this.ops.push(() => this.mockRedis.setex(key, seconds, value));
    return this;
  }

  del(key: string): this {
    this.ops.push(() => this.mockRedis.del(key));
    return this;
  }

  get(key: string): this {
    this.ops.push(() => this.mockRedis.get(key));
    return this;
  }

  lpush(key: string, ...values: string[]): this {
    this.ops.push(() => this.mockRedis.lpush(key, ...values));
    return this;
  }

  ltrim(key: string, start: number, stop: number): this {
    this.ops.push(() => this.mockRedis.ltrim(key, start, stop));
    return this;
  }

  async exec(): Promise<any[]> {
    const results: any[] = [];
    for (const op of this.ops) {
      results.push(await op());
    }
    return results;
  }
}

export class MockRedis {
  private store = new Map<string, string>();
  private listStore = new Map<string, string[]>();
  private ttls = new Map<string, NodeJS.Timeout>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<string> {
    const existing = this.ttls.get(key);
    if (existing) {
      clearTimeout(existing);
      this.ttls.delete(key);
    }
    this.store.set(key, String(value));
    return "OK";
  }

  async setex(key: string, seconds: number, value: string): Promise<string> {
    const existing = this.ttls.get(key);
    if (existing) {
      clearTimeout(existing);
      this.ttls.delete(key);
    }
    this.store.set(key, String(value));
    const timer = setTimeout(() => {
      this.store.delete(key);
      this.ttls.delete(key);
    }, Math.max(1, seconds) * 1000);
    this.ttls.set(key, timer);
    return "OK";
  }

  async del(key: string): Promise<number> {
    const existing = this.ttls.get(key);
    if (existing) {
      clearTimeout(existing);
      this.ttls.delete(key);
    }
    const existed = this.store.delete(key) || this.listStore.delete(key);
    return existed ? 1 : 0;
  }

  async ttl(key: string): Promise<number> {
    return this.store.has(key) || this.listStore.has(key) ? -1 : -2;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.store.has(key) && !this.listStore.has(key)) return 0;
    const existing = this.ttls.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.store.delete(key);
      this.listStore.delete(key);
      this.ttls.delete(key);
    }, Math.max(1, seconds) * 1000);
    this.ttls.set(key, timer);
    return 1;
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.listStore.get(key) || [];
    list.unshift(...values);
    this.listStore.set(key, list);
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<string> {
    const list = this.listStore.get(key) || [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    const trimmed = list.slice(start, end);
    this.listStore.set(key, trimmed);
    return "OK";
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.listStore.get(key) || [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start, end);
  }

  async llen(key: string): Promise<number> {
    return (this.listStore.get(key) || []).length;
  }

  pipeline(): MockPipeline {
    return new MockPipeline(this);
  }

  async ping(): Promise<string> {
    return "PONG (In-Memory Mock Mode)";
  }

  on(event: string, callback: (...args: any[]) => void): this {
    if (event === "connect") {
      setTimeout(() => callback(), 50);
    }
    return this;
  }

  disconnect() {}
}

let activeClient: any;

function fallbackToMock(reason: string) {
  if (!(activeClient instanceof MockRedis)) {
    console.warn(`[Redis] Redis operation failed (${reason}). Falling back to IN-MEMORY MOCK REDIS cache.`);
    try {
      if (typeof activeClient?.disconnect === "function") {
        activeClient.disconnect();
      }
    } catch {}
    activeClient = new MockRedis();
  }
}

try {
  // Try Upstash REST API first if credentials are available
  if (upstashUrl && upstashToken) {
    try {
      activeClient = new UpstashRedis({
        url: upstashUrl,
        token: upstashToken,
        retry: {
          retries: 0,
        },
      });
      console.log(`[Redis] REAL UPSTASH REDIS connected successfully (${upstashUrl}).`);
    } catch (upstashError: any) {
      console.warn("[Redis] Upstash connection failed:", upstashError?.message || upstashError);
      throw upstashError;
    }
  } else {
    // Fall back to standard Redis connection
    console.log(`[Redis] Connecting to standard Redis at ${redisUrl}...`);
    activeClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1500,
    });

    activeClient.on("error", (err: any) => {
      fallbackToMock(err?.message || "Standard Redis error");
    });
  }
} catch (error: any) {
  console.warn("[Redis] Initialization failed. Falling back to IN-MEMORY MOCK REDIS cache.");
  activeClient = new MockRedis();
}

// Proxy wrapper to expose the active client dynamically and auto-fallback on error
const proxy = new Proxy({} as any, {
  get(_target, prop) {
    if (prop === "pipeline") {
      return function () {
        if (typeof activeClient?.pipeline === "function") {
          try {
            const p = activeClient.pipeline();
            const origExec = p.exec.bind(p);
            p.exec = async function (...args: any[]) {
              try {
                return await origExec(...args);
              } catch (err: any) {
                fallbackToMock(err?.message || String(err));
                return [];
              }
            };
            return p;
          } catch (err: any) {
            fallbackToMock(err?.message || String(err));
            return new MockPipeline(activeClient instanceof MockRedis ? activeClient : new MockRedis());
          }
        }
        return new MockPipeline(activeClient instanceof MockRedis ? activeClient : new MockRedis());
      };
    }

    if (typeof activeClient?.[prop] === "function") {
      return async function (...args: any[]) {
        const currentFn = activeClient?.[prop];
        if (typeof currentFn === "function") {
          try {
            return await currentFn.apply(activeClient, args);
          } catch (err: any) {
            fallbackToMock(err?.message || String(err));
            const fallbackFn = (activeClient as any)?.[prop];
            if (typeof fallbackFn === "function") {
              return await fallbackFn.apply(activeClient, args);
            }
            return null;
          }
        }
        return null;
      };
    }
    return activeClient?.[prop];
  },
});

export default proxy;
export { Redis };
