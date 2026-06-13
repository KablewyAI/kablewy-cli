import { UploadSession, UploadRateLimiterState } from '../types/index.js';

export interface RateLimiterOptions {
  maxRequestsPerMinute?: number;
  maxBytesPerMinute?: number;
  adaptiveConcurrency?: {
    min: number;
    max: number;
    initial: number;
    slowStartFactor?: number;
    errorPenaltyFactor?: number;
  };
}

export class UploadRateLimiter {
  private readonly maxRequests: number | undefined;
  private readonly maxBytes: number | undefined;
  private state: UploadRateLimiterState;
  private adaptive?: Required<RateLimiterOptions['adaptiveConcurrency']>;
  private advisoryConcurrency?: number;

  constructor(private readonly session: UploadSession, options: RateLimiterOptions) {
    this.maxRequests = options.maxRequestsPerMinute;
    this.maxBytes = options.maxBytesPerMinute;
    const now = Date.now();
    const persisted = session.rateLimiter;
    this.state = persisted
      ? persisted
      : {
          windowStart: now,
          requestsInWindow: 0,
          bytesInWindow: 0
        };

    if (options.adaptiveConcurrency) {
      const config = options.adaptiveConcurrency;
      this.adaptive = {
        min: Math.max(1, config.min),
        max: Math.max(config.max, config.min),
        initial: Math.max(config.min, Math.min(config.initial, config.max)),
        slowStartFactor: config.slowStartFactor ?? 1.25,
        errorPenaltyFactor: config.errorPenaltyFactor ?? 0.5
      };
      const stored = persisted?.advisoryConcurrency;
      this.advisoryConcurrency = stored ?? this.adaptive.initial;
    } else {
      this.advisoryConcurrency = persisted?.advisoryConcurrency;
    }
  }

  async beforeRequest(bytes: number): Promise<void> {
    if (!this.maxRequests && !this.maxBytes) return;
    while (true) {
      const now = Date.now();
      this.resetIfNeeded(now);
      if (this.hasCapacity(bytes)) break;
      const sleepMs = this.timeUntilReset(now);
      await sleep(Math.max(sleepMs, 100));
    }

    this.state.requestsInWindow += 1;
    this.state.bytesInWindow += bytes;
    this.persistState();
  }

  private resetIfNeeded(now: number): void {
    const windowMs = 60_000;
    if (now - this.state.windowStart >= windowMs) {
      this.state = {
        windowStart: now,
        requestsInWindow: 0,
        bytesInWindow: 0,
        advisoryConcurrency: this.advisoryConcurrency
      };
      this.persistState();
      if (this.adaptive) {
        this.advisoryConcurrency = Math.min(
          (this.advisoryConcurrency ?? this.adaptive.initial) * this.adaptive.slowStartFactor,
          this.adaptive.max
        );
        this.persistState();
      }
    }
  }

  private hasCapacity(bytes: number): boolean {
    const underRequestLimit = this.maxRequests
      ? this.state.requestsInWindow < this.maxRequests
      : true;
    const underByteLimit = this.maxBytes
      ? this.state.bytesInWindow + bytes <= this.maxBytes
      : true;
    return underRequestLimit && underByteLimit;
  }

  private timeUntilReset(now: number): number {
    const windowMs = 60_000;
    const elapsed = now - this.state.windowStart;
    return windowMs - elapsed;
  }

  getSuggestedConcurrency(defaultValue: number): number {
    if (!this.adaptive) return defaultValue;
    // Clamp suggested concurrency so the user-configured value is respected but capped.
    return Math.max(
      this.adaptive.min,
      Math.min(this.advisoryConcurrency ?? this.adaptive.initial, defaultValue, this.adaptive.max)
    );
  }

  recordError(): void {
    if (!this.adaptive) return;
    this.advisoryConcurrency = Math.max(
      this.adaptive.min,
      Math.floor((this.advisoryConcurrency ?? this.adaptive.initial) * this.adaptive.errorPenaltyFactor)
    );
    this.persistState();
  }

  private persistState(): void {
    this.state.advisoryConcurrency = this.advisoryConcurrency;
    this.session.rateLimiter = { ...this.state };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
