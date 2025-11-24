// Simplified staircase backoff rate limiter
export class StaircaseBackoff {
  private requestTimestamps = new Map<string, number[]>();
  private queue: Array<() => Promise<any>> = [];
  private processing = false;

  constructor(private options: StaircaseBackoffOptions = {}) {
    this.options = {
      maxRetries: 3,
      baseDelay: 2000,
      maxDelay: 30000,
      defaultQPS: 1,
      maxConcurrentRequests: 5,
      ...options
    };
  }

  async execute<T>(
    request: () => Promise<T>,
    endpoint: string = 'default',
    qps: number = this.options.defaultQPS!
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const executeRequest = async () => {
        try {
          // Calculate delay based on QPS
          const delay = this.calculateDelay(endpoint, qps);
          if (delay > 0) {
            await this.sleep(delay);
          }

          // Record timestamp
          this.recordRequest(endpoint);

          const result = await request();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };

      executeRequest();
    });
  }

  private calculateDelay(endpoint: string, qps: number): number {
    const now = Date.now();
    const timestamps = this.requestTimestamps.get(endpoint) || [];

    // Clean old timestamps (keep last minute)
    const recentTimestamps = timestamps.filter(ts => now - ts < 60000);
    this.requestTimestamps.set(endpoint, recentTimestamps);

    // Calculate minimum interval based on QPS
    const minInterval = 1000 / qps;

    if (recentTimestamps.length === 0) {
      return 0; // First request
    }

    const lastRequest = recentTimestamps[recentTimestamps.length - 1];
    const timeSinceLast = now - lastRequest;

    if (timeSinceLast >= minInterval) {
      return 0; // Ready to execute
    }

    return minInterval - timeSinceLast; // Need to wait
  }

  private recordRequest(endpoint: string): void {
    const timestamps = this.requestTimestamps.get(endpoint) || [];
    timestamps.push(Date.now());
    this.requestTimestamps.set(endpoint, timestamps);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

interface StaircaseBackoffOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  defaultQPS?: number;
  maxConcurrentRequests?: number;
}
