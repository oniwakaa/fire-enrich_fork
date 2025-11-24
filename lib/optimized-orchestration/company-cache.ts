// Simplified in-memory company cache
export class CompanyCache {
  private cache = new Map<string, any>();
  private readonly defaultTTL = 30 * 24 * 60 * 60 * 1000; // 30 days

  generateCacheKey(companyName: string, domain: string): string {
    return `${companyName.toLowerCase().replace(/\s+/g, "_")}:${domain}`;
  }

  async get(key: string): Promise<any | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.createdAt > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  async set(
    key: string,
    data: any,
    ttl: number = this.defaultTTL,
  ): Promise<void> {
    const entry = {
      data,
      createdAt: Date.now(),
      ttl,
    };
    this.cache.set(key, entry);
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  getSize(): number {
    return this.cache.size;
  }
}
