/**
 * Graceful Degradation Module
 * Handles offline mode, connection failures, and fallback behaviors
 */

import { EventEmitter } from 'events';

export type ConnectionState = 'online' | 'offline' | 'degraded' | 'connecting';

export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'unhealthy' | 'degraded' | 'unknown';
  lastCheck: Date;
  lastSuccess: Date | null;
  consecutiveFailures: number;
  message?: string;
}

export interface ResilienceConfig {
  /** Max consecutive failures before marking service unhealthy */
  maxFailures: number;
  /** Health check interval in milliseconds */
  healthCheckInterval: number;
  /** Timeout for health checks in milliseconds */
  healthCheckTimeout: number;
  /** Time to wait before retry after failure */
  retryDelay: number;
  /** Max retry delay (exponential backoff cap) */
  maxRetryDelay: number;
  /** Enable offline data caching */
  enableOfflineCache: boolean;
  /** Max cached items */
  maxCacheSize: number;
}

const defaultConfig: ResilienceConfig = {
  maxFailures: 3,
  healthCheckInterval: 30000, // 30 seconds
  healthCheckTimeout: 5000, // 5 seconds
  retryDelay: 1000, // 1 second
  maxRetryDelay: 60000, // 1 minute
  enableOfflineCache: true,
  maxCacheSize: 1000,
};

/**
 * Connection Manager
 * Tracks connection state and provides fallback behaviors
 */
export class ConnectionManager extends EventEmitter {
  private state: ConnectionState = 'connecting';
  private services: Map<string, ServiceHealth> = new Map();
  private config: ResilienceConfig;
  private healthCheckTimers: Map<string, NodeJS.Timeout> = new Map();
  private offlineQueue: Array<{ action: string; data: unknown; timestamp: Date }> = [];

  constructor(config: Partial<ResilienceConfig> = {}) {
    super();
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if system is operational (online or degraded)
   */
  isOperational(): boolean {
    return this.state === 'online' || this.state === 'degraded';
  }

  /**
   * Register a service for health monitoring
   */
  registerService(
    name: string,
    healthCheck: () => Promise<boolean>
  ): void {
    this.services.set(name, {
      name,
      status: 'unknown',
      lastCheck: new Date(),
      lastSuccess: null,
      consecutiveFailures: 0,
    });

    this.startHealthCheck(name, healthCheck);
  }

  /**
   * Unregister a service
   */
  unregisterService(name: string): void {
    const timer = this.healthCheckTimers.get(name);
    if (timer) {
      clearInterval(timer);
      this.healthCheckTimers.delete(name);
    }
    this.services.delete(name);
  }

  /**
   * Start periodic health checks for a service
   */
  private startHealthCheck(
    name: string,
    healthCheck: () => Promise<boolean>
  ): void {
    const check = async () => {
      const service = this.services.get(name);
      if (!service) return;

      try {
        const timeoutPromise = new Promise<boolean>((_, reject) => {
          setTimeout(() => reject(new Error('Timeout')), this.config.healthCheckTimeout);
        });

        const healthy = await Promise.race([healthCheck(), timeoutPromise]);

        if (healthy) {
          this.markServiceHealthy(name);
        } else {
          this.markServiceUnhealthy(name, 'Health check returned false');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.markServiceUnhealthy(name, message);
      }
    };

    // Initial check
    check();

    // Periodic checks
    const timer = setInterval(check, this.config.healthCheckInterval);
    this.healthCheckTimers.set(name, timer);
  }

  /**
   * Mark a service as healthy
   */
  private markServiceHealthy(name: string): void {
    const service = this.services.get(name);
    if (!service) return;

    const wasUnhealthy = service.status !== 'healthy';
    
    service.status = 'healthy';
    service.lastCheck = new Date();
    service.lastSuccess = new Date();
    service.consecutiveFailures = 0;
    service.message = undefined;

    if (wasUnhealthy) {
      this.emit('serviceRecovered', { name, service });
    }

    this.updateOverallState();
  }

  /**
   * Mark a service as unhealthy
   */
  private markServiceUnhealthy(name: string, message: string): void {
    const service = this.services.get(name);
    if (!service) return;

    service.consecutiveFailures++;
    service.lastCheck = new Date();
    service.message = message;

    if (service.consecutiveFailures >= this.config.maxFailures) {
      const wasHealthy = service.status === 'healthy';
      service.status = 'unhealthy';
      
      if (wasHealthy) {
        this.emit('serviceDown', { name, service });
      }
    } else {
      service.status = 'degraded';
    }

    this.updateOverallState();
  }

  /**
   * Update overall connection state based on service health
   */
  private updateOverallState(): void {
    const services = Array.from(this.services.values());
    
    if (services.length === 0) {
      this.setState('connecting');
      return;
    }

    const healthyCount = services.filter(s => s.status === 'healthy').length;
    const unhealthyCount = services.filter(s => s.status === 'unhealthy').length;

    if (healthyCount === services.length) {
      this.setState('online');
    } else if (unhealthyCount === services.length) {
      this.setState('offline');
    } else {
      this.setState('degraded');
    }
  }

  /**
   * Set connection state
   */
  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      const oldState = this.state;
      this.state = newState;
      this.emit('stateChange', { from: oldState, to: newState });

      if (newState === 'online' && oldState === 'offline') {
        this.processOfflineQueue();
      }
    }
  }

  /**
   * Get health status of all services
   */
  getServiceHealth(): Map<string, ServiceHealth> {
    return new Map(this.services);
  }

  /**
   * Queue an action for later execution (when offline)
   */
  queueOfflineAction(action: string, data: unknown): void {
    if (!this.config.enableOfflineCache) return;

    if (this.offlineQueue.length >= this.config.maxCacheSize) {
      this.offlineQueue.shift(); // Remove oldest
    }

    this.offlineQueue.push({
      action,
      data,
      timestamp: new Date(),
    });

    this.emit('actionQueued', { action, queueLength: this.offlineQueue.length });
  }

  /**
   * Process queued actions when back online
   */
  private async processOfflineQueue(): Promise<void> {
    if (this.offlineQueue.length === 0) return;

    this.emit('processingQueue', { count: this.offlineQueue.length });

    const queue = [...this.offlineQueue];
    this.offlineQueue = [];

    for (const item of queue) {
      this.emit('processQueuedAction', item);
    }
  }

  /**
   * Get number of queued actions
   */
  getQueueLength(): number {
    return this.offlineQueue.length;
  }

  /**
   * Cleanup
   */
  destroy(): void {
    for (const timer of this.healthCheckTimers.values()) {
      clearInterval(timer);
    }
    this.healthCheckTimers.clear();
    this.services.clear();
    this.removeAllListeners();
  }
}

/**
 * Circuit Breaker
 * Prevents cascading failures by failing fast
 */
export class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failures = 0;
  private lastFailure: Date | null = null;
  private successCount = 0;

  constructor(
    private threshold: number = 5,
    private resetTimeout: number = 30000,
    private successThreshold: number = 3
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      // Check if we should try again
      if (this.lastFailure && Date.now() - this.lastFailure.getTime() > this.resetTimeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'closed';
        this.failures = 0;
        this.successCount = 0;
      }
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailure = new Date();
    this.successCount = 0;

    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }

  getState(): 'closed' | 'open' | 'half-open' {
    return this.state;
  }

  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.successCount = 0;
    this.lastFailure = null;
  }
}

/**
 * Retry with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    factor?: number;
    onRetry?: (attempt: number, error: Error) => void;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    factor = 2,
    onRetry,
  } = options;

  let lastError: Error;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt === maxRetries) {
        throw lastError;
      }

      onRetry?.(attempt, lastError);

      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(delay * factor, maxDelay);
    }
  }

  throw lastError!;
}

/**
 * Fallback data provider
 * Returns cached data when live data is unavailable
 */
export class FallbackDataProvider<T> {
  private cache: T | null = null;
  private cacheTime: Date | null = null;
  private maxAge: number;

  constructor(maxAge: number = 3600000) { // 1 hour default
    this.maxAge = maxAge;
  }

  async get(fetchFn: () => Promise<T>): Promise<{ data: T; fromCache: boolean; stale: boolean }> {
    try {
      const data = await fetchFn();
      this.cache = data;
      this.cacheTime = new Date();
      return { data, fromCache: false, stale: false };
    } catch (error) {
      if (this.cache !== null) {
        const stale = this.cacheTime 
          ? Date.now() - this.cacheTime.getTime() > this.maxAge
          : true;
        return { data: this.cache, fromCache: true, stale };
      }
      throw error;
    }
  }

  getCached(): T | null {
    return this.cache;
  }

  isStale(): boolean {
    if (!this.cacheTime) return true;
    return Date.now() - this.cacheTime.getTime() > this.maxAge;
  }

  invalidate(): void {
    this.cache = null;
    this.cacheTime = null;
  }
}

/**
 * Singleton connection manager instance
 */
export const connectionManager = new ConnectionManager();
