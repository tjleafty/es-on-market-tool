import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { prisma } from '@/lib/database';

export interface ApiKey {
  id: string;
  name: string;
  keyHash: string;
  permissions: string[];
  rateLimitTier: 'basic' | 'premium' | 'enterprise';
  enabled: boolean;
  createdAt: Date;
  lastUsedAt?: Date;
  expiresAt?: Date;
  metadata?: Record<string, any>;
}

export interface AuthContext {
  apiKey: ApiKey;
  permissions: Set<string>;
  rateLimitTier: string;
  clientId: string;
}

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

const API_KEY_HEADER = 'X-API-Key';
const API_SECRET_HEADER = 'X-API-Secret';
const CLIENT_ID_HEADER = 'X-Client-ID';

// Rate limit configurations by tier
const RATE_LIMITS: Record<string, RateLimitConfig> = {
  basic: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 100,
  },
  premium: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 1000,
  },
  enterprise: {
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10000,
  },
};

// Permission definitions
export const PERMISSIONS = {
  // Job management
  JOBS_READ: 'jobs:read',
  JOBS_CREATE: 'jobs:create',
  JOBS_UPDATE: 'jobs:update',
  JOBS_DELETE: 'jobs:delete',

  // Listings access
  LISTINGS_READ: 'listings:read',
  LISTINGS_SEARCH: 'listings:search',
  LISTINGS_EXPORT: 'listings:export',

  // Monitoring access
  MONITORING_READ: 'monitoring:read',
  METRICS_READ: 'metrics:read',

  // WebSocket access
  WEBSOCKET_CONNECT: 'websocket:connect',
  WEBSOCKET_SUBSCRIBE: 'websocket:subscribe',

  // Admin functions
  ADMIN_KEYS: 'admin:keys',
  ADMIN_SYSTEM: 'admin:system',
} as const;

// Default permission sets by tier
const DEFAULT_PERMISSIONS: Record<string, string[]> = {
  basic: [
    PERMISSIONS.JOBS_READ,
    PERMISSIONS.LISTINGS_READ,
    PERMISSIONS.LISTINGS_SEARCH,
    PERMISSIONS.WEBSOCKET_CONNECT,
  ],
  premium: [
    PERMISSIONS.JOBS_READ,
    PERMISSIONS.JOBS_CREATE,
    PERMISSIONS.JOBS_UPDATE,
    PERMISSIONS.LISTINGS_READ,
    PERMISSIONS.LISTINGS_SEARCH,
    PERMISSIONS.LISTINGS_EXPORT,
    PERMISSIONS.MONITORING_READ,
    PERMISSIONS.WEBSOCKET_CONNECT,
    PERMISSIONS.WEBSOCKET_SUBSCRIBE,
  ],
  enterprise: [
    ...Object.values(PERMISSIONS),
  ],
};

class ApiAuthService {
  private rateLimitStore = new Map<string, { count: number; resetTime: number }>();

  async authenticate(request: NextRequest): Promise<AuthContext | null> {
    const apiKey = request.headers.get(API_KEY_HEADER);
    const apiSecret = request.headers.get(API_SECRET_HEADER);
    const clientId = request.headers.get(CLIENT_ID_HEADER) || this.generateClientId(request);

    if (!apiKey) {
      return null;
    }

    try {
      const keyData = await this.validateApiKey(apiKey, apiSecret);
      if (!keyData) {
        return null;
      }

      // Update last used timestamp
      await this.updateLastUsed(keyData.id);

      return {
        apiKey: keyData,
        permissions: new Set(keyData.permissions),
        rateLimitTier: keyData.rateLimitTier,
        clientId,
      };
    } catch (error) {
      console.error('API authentication error:', error);
      return null;
    }
  }

  async validateApiKey(key: string, secret?: string): Promise<ApiKey | null> {
    try {
      const keyHash = this.hashApiKey(key);

      // In production, this would query a dedicated API keys table
      // For now, we'll simulate with environment variables or a mock system
      const mockApiKeys: ApiKey[] = [
        {
          id: 'key_basic_1',
          name: 'Basic Development Key',
          keyHash: this.hashApiKey('sk_test_basic_123'),
          permissions: DEFAULT_PERMISSIONS.basic,
          rateLimitTier: 'basic',
          enabled: true,
          createdAt: new Date(),
        },
        {
          id: 'key_premium_1',
          name: 'Premium API Key',
          keyHash: this.hashApiKey('sk_live_premium_456'),
          permissions: DEFAULT_PERMISSIONS.premium,
          rateLimitTier: 'premium',
          enabled: true,
          createdAt: new Date(),
        },
        {
          id: 'key_enterprise_1',
          name: 'Enterprise Master Key',
          keyHash: this.hashApiKey('sk_live_enterprise_789'),
          permissions: DEFAULT_PERMISSIONS.enterprise,
          rateLimitTier: 'enterprise',
          enabled: true,
          createdAt: new Date(),
        },
      ];

      const apiKey = mockApiKeys.find(k => this.compareHashes(k.keyHash, keyHash));

      if (!apiKey || !apiKey.enabled) {
        return null;
      }

      // Check expiration
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        return null;
      }

      // Validate secret if provided (for enhanced security)
      if (secret && !this.validateSecret(apiKey.id, secret)) {
        return null;
      }

      return apiKey;
    } catch (error) {
      console.error('API key validation error:', error);
      return null;
    }
  }

  async checkRateLimit(authContext: AuthContext, endpoint: string): Promise<boolean> {
    const config = RATE_LIMITS[authContext.rateLimitTier];
    if (!config) {
      return false;
    }

    const key = `${authContext.clientId}:${endpoint}`;
    const now = Date.now();
    const windowStart = now - config.windowMs;

    const existing = this.rateLimitStore.get(key);

    if (!existing || existing.resetTime <= windowStart) {
      // New window
      this.rateLimitStore.set(key, {
        count: 1,
        resetTime: now + config.windowMs,
      });
      return true;
    }

    if (existing.count >= config.maxRequests) {
      return false;
    }

    existing.count++;
    return true;
  }

  getRateLimitInfo(authContext: AuthContext, endpoint: string) {
    const config = RATE_LIMITS[authContext.rateLimitTier];
    const key = `${authContext.clientId}:${endpoint}`;
    const existing = this.rateLimitStore.get(key);

    return {
      limit: config.maxRequests,
      remaining: existing ? Math.max(0, config.maxRequests - existing.count) : config.maxRequests,
      resetTime: existing?.resetTime || Date.now() + config.windowMs,
      retryAfter: existing && existing.count >= config.maxRequests
        ? Math.ceil((existing.resetTime - Date.now()) / 1000)
        : null,
    };
  }

  hasPermission(authContext: AuthContext, permission: string): boolean {
    return authContext.permissions.has(permission);
  }

  requirePermission(authContext: AuthContext, permission: string): void {
    if (!this.hasPermission(authContext, permission)) {
      throw new Error(`Insufficient permissions: ${permission} required`);
    }
  }

  async generateApiKey(name: string, tier: string = 'basic', permissions?: string[]): Promise<{ key: string; secret: string }> {
    const prefix = tier === 'basic' ? 'sk_test_' : 'sk_live_';
    const keyId = randomBytes(8).toString('hex');
    const key = `${prefix}${tier}_${keyId}`;
    const secret = randomBytes(32).toString('hex');

    // In production, store this in database
    console.log(`Generated API key: ${name}`);
    console.log(`Key: ${key}`);
    console.log(`Secret: ${secret}`);
    console.log(`Tier: ${tier}`);
    console.log(`Permissions: ${permissions || DEFAULT_PERMISSIONS[tier]}`);

    return { key, secret };
  }

  private hashApiKey(key: string): string {
    return createHash('sha256').update(key + process.env.API_KEY_SALT || 'default-salt').digest('hex');
  }

  private compareHashes(hash1: string, hash2: string): boolean {
    try {
      const buf1 = Buffer.from(hash1, 'hex');
      const buf2 = Buffer.from(hash2, 'hex');
      return buf1.length === buf2.length && timingSafeEqual(buf1, buf2);
    } catch {
      return false;
    }
  }

  private validateSecret(keyId: string, secret: string): boolean {
    // In production, validate against stored secret hash
    // For now, just check if secret is provided and not empty
    return secret.length >= 32;
  }

  private generateClientId(request: NextRequest): string {
    const userAgent = request.headers.get('user-agent') || 'unknown';
    const forwarded = request.headers.get('x-forwarded-for') || 'unknown';

    return createHash('md5')
      .update(`${userAgent}:${forwarded}:${Date.now()}`)
      .digest('hex')
      .substring(0, 16);
  }

  private async updateLastUsed(keyId: string): Promise<void> {
    try {
      // In production, update database record
      console.log(`API key ${keyId} used at ${new Date().toISOString()}`);
    } catch (error) {
      console.error('Failed to update last used timestamp:', error);
    }
  }

  // Cleanup expired rate limit entries
  cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.rateLimitStore.entries()) {
      if (value.resetTime <= now) {
        this.rateLimitStore.delete(key);
      }
    }
  }
}

// Singleton instance
export const apiAuthService = new ApiAuthService();

// Cleanup rate limit store every 5 minutes
setInterval(() => {
  apiAuthService.cleanup();
}, 5 * 60 * 1000);