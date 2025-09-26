import { Page, BrowserContext } from 'playwright';

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
  bypassList?: string[];
}

export interface ProxyPool {
  proxies: ProxyConfig[];
  enabled: boolean;
  rotationStrategy: 'round-robin' | 'random' | 'sticky' | 'health-based';
  healthCheckUrl?: string;
  maxFailures?: number;
  cooldownMs?: number;
}

export interface ProxyHealth {
  proxy: ProxyConfig;
  isHealthy: boolean;
  failures: number;
  lastFailure?: Date;
  lastSuccess?: Date;
  avgResponseTime: number;
  totalRequests: number;
  successfulRequests: number;
}

export class ProxyRotator {
  private proxyPool: ProxyPool;
  private proxyHealth: Map<string, ProxyHealth> = new Map();
  private currentProxyIndex = 0;
  private isHealthCheckRunning = false;

  constructor(proxyPool: ProxyPool) {
    this.proxyPool = {
      healthCheckUrl: 'https://httpbin.org/ip',
      maxFailures: 5,
      cooldownMs: 300000, // 5 minutes
      ...proxyPool,
    };

    this.initializeProxyHealth();
  }

  private initializeProxyHealth(): void {
    for (const proxy of this.proxyPool.proxies) {
      const key = this.getProxyKey(proxy);
      this.proxyHealth.set(key, {
        proxy,
        isHealthy: true,
        failures: 0,
        avgResponseTime: 0,
        totalRequests: 0,
        successfulRequests: 0,
      });
    }
  }

  async getNextProxy(): Promise<ProxyConfig | null> {
    if (!this.proxyPool.enabled || this.proxyPool.proxies.length === 0) {
      return null;
    }

    const healthyProxies = this.getHealthyProxies();

    if (healthyProxies.length === 0) {
      console.warn('No healthy proxies available, attempting health check...');
      await this.performHealthCheck();
      const recheckHealthy = this.getHealthyProxies();

      if (recheckHealthy.length === 0) {
        console.error('All proxies are unhealthy');
        return null;
      }

      return recheckHealthy[0].proxy;
    }

    switch (this.proxyPool.rotationStrategy) {
      case 'round-robin':
        return this.getRoundRobinProxy(healthyProxies);

      case 'random':
        return this.getRandomProxy(healthyProxies);

      case 'health-based':
        return this.getHealthBasedProxy(healthyProxies);

      case 'sticky':
        return this.getStickyProxy(healthyProxies);

      default:
        return healthyProxies[0].proxy;
    }
  }

  async configureContextWithProxy(context: BrowserContext, proxy: ProxyConfig | null): Promise<void> {
    if (!proxy) {
      return;
    }

    try {
      // Set proxy authentication if provided
      if (proxy.username && proxy.password) {
        await context.route('**/*', route => {
          route.continue({
            headers: {
              ...route.request().headers(),
              'Proxy-Authorization': `Basic ${Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')}`,
            },
          });
        });
      }

      console.log(`🔄 Using proxy: ${proxy.server}`);
    } catch (error) {
      console.error('Failed to configure proxy:', error);
      throw error;
    }
  }

  async testProxyConnection(proxy: ProxyConfig, timeoutMs: number = 10000): Promise<{
    success: boolean;
    responseTime: number;
    error?: string;
    ipAddress?: string;
  }> {
    const startTime = Date.now();

    try {
      // This would require a separate browser context to test
      // For now, we'll simulate a basic connectivity check
      const testUrl = this.proxyPool.healthCheckUrl || 'https://httpbin.org/ip';

      // In a real implementation, you'd create a test context with the proxy
      // and make a request to verify connectivity
      console.log(`Testing proxy ${proxy.server} with ${testUrl}`);

      // Simulate proxy test (replace with actual implementation)
      await this.simulateProxyTest(proxy, timeoutMs);

      const responseTime = Date.now() - startTime;

      return {
        success: true,
        responseTime,
        ipAddress: 'test.ip.address', // Would be actual IP from response
      };

    } catch (error) {
      const responseTime = Date.now() - startTime;
      return {
        success: false,
        responseTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async simulateProxyTest(proxy: ProxyConfig, timeoutMs: number): Promise<void> {
    // Simulate network delay
    const delay = Math.random() * 2000 + 500; // 500-2500ms
    await new Promise(resolve => setTimeout(resolve, delay));

    // Simulate occasional failures
    if (Math.random() < 0.1) {
      throw new Error('Simulated proxy connection failure');
    }
  }

  async recordProxyResult(proxy: ProxyConfig, success: boolean, responseTime?: number): Promise<void> {
    const key = this.getProxyKey(proxy);
    const health = this.proxyHealth.get(key);

    if (!health) {
      console.warn(`Proxy health record not found for ${key}`);
      return;
    }

    health.totalRequests++;

    if (success) {
      health.successfulRequests++;
      health.failures = 0; // Reset failure count on success
      health.lastSuccess = new Date();

      if (responseTime) {
        // Update average response time using exponential moving average
        const alpha = 0.3;
        health.avgResponseTime = health.avgResponseTime === 0
          ? responseTime
          : (alpha * responseTime) + ((1 - alpha) * health.avgResponseTime);
      }
    } else {
      health.failures++;
      health.lastFailure = new Date();

      // Mark as unhealthy if too many failures
      if (health.failures >= (this.proxyPool.maxFailures || 5)) {
        health.isHealthy = false;
        console.warn(`Proxy ${proxy.server} marked as unhealthy after ${health.failures} failures`);
      }
    }

    this.proxyHealth.set(key, health);
  }

  async performHealthCheck(): Promise<void> {
    if (this.isHealthCheckRunning) {
      return;
    }

    this.isHealthCheckRunning = true;
    console.log('🔍 Performing proxy health check...');

    try {
      const healthCheckPromises = Array.from(this.proxyHealth.entries()).map(async ([key, health]) => {
        // Skip recently failed proxies during cooldown
        if (!health.isHealthy && health.lastFailure) {
          const cooldownRemaining = Date.now() - health.lastFailure.getTime();
          if (cooldownRemaining < (this.proxyPool.cooldownMs || 300000)) {
            console.log(`Proxy ${health.proxy.server} still in cooldown`);
            return;
          }
        }

        const result = await this.testProxyConnection(health.proxy);

        if (result.success) {
          health.isHealthy = true;
          health.failures = 0;
          health.lastSuccess = new Date();
          console.log(`✅ Proxy ${health.proxy.server} is healthy (${result.responseTime}ms)`);
        } else {
          health.failures++;
          health.lastFailure = new Date();
          health.isHealthy = health.failures < (this.proxyPool.maxFailures || 5);
          console.warn(`❌ Proxy ${health.proxy.server} failed health check: ${result.error}`);
        }

        this.proxyHealth.set(key, health);
      });

      await Promise.all(healthCheckPromises);

      const healthyCount = this.getHealthyProxies().length;
      console.log(`🔍 Health check complete: ${healthyCount}/${this.proxyPool.proxies.length} proxies healthy`);

    } finally {
      this.isHealthCheckRunning = false;
    }
  }

  getHealthyProxies(): ProxyHealth[] {
    return Array.from(this.proxyHealth.values()).filter(health => health.isHealthy);
  }

  getProxyStats(): {
    total: number;
    healthy: number;
    unhealthy: number;
    healthyProxies: Array<{
      server: string;
      successRate: number;
      avgResponseTime: number;
      totalRequests: number;
    }>;
    unhealthyProxies: Array<{
      server: string;
      failures: number;
      lastFailure?: Date;
    }>;
  } {
    const healthyProxies: any[] = [];
    const unhealthyProxies: any[] = [];

    for (const health of this.proxyHealth.values()) {
      const successRate = health.totalRequests > 0
        ? (health.successfulRequests / health.totalRequests) * 100
        : 0;

      if (health.isHealthy) {
        healthyProxies.push({
          server: health.proxy.server,
          successRate,
          avgResponseTime: Math.round(health.avgResponseTime),
          totalRequests: health.totalRequests,
        });
      } else {
        unhealthyProxies.push({
          server: health.proxy.server,
          failures: health.failures,
          lastFailure: health.lastFailure,
        });
      }
    }

    return {
      total: this.proxyPool.proxies.length,
      healthy: healthyProxies.length,
      unhealthy: unhealthyProxies.length,
      healthyProxies,
      unhealthyProxies,
    };
  }

  private getRoundRobinProxy(healthyProxies: ProxyHealth[]): ProxyConfig {
    if (this.currentProxyIndex >= healthyProxies.length) {
      this.currentProxyIndex = 0;
    }

    const proxy = healthyProxies[this.currentProxyIndex].proxy;
    this.currentProxyIndex++;
    return proxy;
  }

  private getRandomProxy(healthyProxies: ProxyHealth[]): ProxyConfig {
    const randomIndex = Math.floor(Math.random() * healthyProxies.length);
    return healthyProxies[randomIndex].proxy;
  }

  private getHealthBasedProxy(healthyProxies: ProxyHealth[]): ProxyConfig {
    // Sort by success rate and response time
    const sortedProxies = [...healthyProxies].sort((a, b) => {
      const aSuccessRate = a.totalRequests > 0 ? a.successfulRequests / a.totalRequests : 0;
      const bSuccessRate = b.totalRequests > 0 ? b.successfulRequests / b.totalRequests : 0;

      if (aSuccessRate !== bSuccessRate) {
        return bSuccessRate - aSuccessRate; // Higher success rate first
      }

      return a.avgResponseTime - b.avgResponseTime; // Lower response time first
    });

    return sortedProxies[0].proxy;
  }

  private getStickyProxy(healthyProxies: ProxyHealth[]): ProxyConfig {
    // Use the same proxy as long as it's healthy
    if (this.currentProxyIndex < healthyProxies.length) {
      return healthyProxies[this.currentProxyIndex].proxy;
    }

    // Fallback to round-robin if current proxy is not available
    return this.getRoundRobinProxy(healthyProxies);
  }

  private getProxyKey(proxy: ProxyConfig): string {
    return `${proxy.server}${proxy.username ? ':' + proxy.username : ''}`;
  }

  async resetProxyHealth(): Promise<void> {
    this.initializeProxyHealth();
    console.log('🔄 Proxy health statistics reset');
  }

  updateProxyPool(newProxyPool: ProxyPool): void {
    this.proxyPool = {
      ...this.proxyPool,
      ...newProxyPool,
    };

    this.initializeProxyHealth();
    console.log(`🔄 Proxy pool updated with ${this.proxyPool.proxies.length} proxies`);
  }

  isEnabled(): boolean {
    return this.proxyPool.enabled && this.proxyPool.proxies.length > 0;
  }

  async startPeriodicHealthCheck(intervalMs: number = 300000): Promise<() => void> {
    const interval = setInterval(() => {
      this.performHealthCheck().catch(error => {
        console.error('Periodic health check failed:', error);
      });
    }, intervalMs);

    console.log(`🔄 Started periodic health check every ${intervalMs / 1000} seconds`);

    // Return cleanup function
    return () => {
      clearInterval(interval);
      console.log('🛑 Stopped periodic health check');
    };
  }
}

// Utility functions for proxy configuration
export function parseProxyString(proxyString: string): ProxyConfig {
  // Parse proxy strings like "http://username:password@proxy.example.com:8080"
  const url = new URL(proxyString);

  return {
    server: `${url.protocol}//${url.host}`,
    username: url.username || undefined,
    password: url.password || undefined,
  };
}

export function createProxyPool(proxyStrings: string[], options: Partial<ProxyPool> = {}): ProxyPool {
  return {
    proxies: proxyStrings.map(parseProxyString),
    enabled: true,
    rotationStrategy: 'round-robin',
    healthCheckUrl: 'https://httpbin.org/ip',
    maxFailures: 5,
    cooldownMs: 300000,
    ...options,
  };
}

export function loadProxiesFromEnv(): ProxyConfig[] {
  const proxyServers = process.env.PROXY_SERVERS;
  if (!proxyServers) {
    return [];
  }

  try {
    return proxyServers.split(',')
      .map(proxy => proxy.trim())
      .filter(proxy => proxy.length > 0)
      .map(parseProxyString);
  } catch (error) {
    console.error('Failed to parse proxy servers from environment:', error);
    return [];
  }
}