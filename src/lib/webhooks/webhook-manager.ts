import { EventEmitter } from 'events';
import { createHash, createHmac } from 'crypto';
import { z } from 'zod';

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  secret: string;
  enabled: boolean;
  createdAt: Date;
  lastDelivery?: Date;
  lastStatus?: number;
  failureCount: number;
  metadata?: Record<string, any>;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  event: string;
  payload: any;
  signature: string;
  status: 'pending' | 'delivered' | 'failed' | 'retry';
  attempts: number;
  lastAttempt?: Date;
  nextRetry?: Date;
  responseStatus?: number;
  responseBody?: string;
  error?: string;
  createdAt: Date;
}

export interface WebhookEvent {
  type: string;
  data: any;
  timestamp: number;
  source: string;
  id?: string;
}

const WebhookEventTypes = {
  // Job events
  JOB_CREATED: 'job.created',
  JOB_STARTED: 'job.started',
  JOB_PROGRESS: 'job.progress',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED: 'job.failed',
  JOB_CANCELLED: 'job.cancelled',

  // Listing events
  LISTING_CREATED: 'listing.created',
  LISTING_UPDATED: 'listing.updated',
  LISTING_BATCH: 'listing.batch',

  // System events
  SYSTEM_ALERT: 'system.alert',
  SYSTEM_HEALTH: 'system.health',
  API_LIMIT_EXCEEDED: 'api.limit_exceeded',

  // Export events
  EXPORT_STARTED: 'export.started',
  EXPORT_COMPLETED: 'export.completed',
  EXPORT_FAILED: 'export.failed',
} as const;

export type WebhookEventType = typeof WebhookEventTypes[keyof typeof WebhookEventTypes];

export class WebhookManager extends EventEmitter {
  private endpoints = new Map<string, WebhookEndpoint>();
  private deliveryQueue: WebhookDelivery[] = [];
  private retryQueue: WebhookDelivery[] = [];
  private processing = false;
  private retryIntervalId?: NodeJS.Timeout;

  private readonly MAX_RETRY_ATTEMPTS = 5;
  private readonly RETRY_DELAYS = [5000, 30000, 120000, 600000, 3600000]; // 5s, 30s, 2m, 10m, 1h
  private readonly DELIVERY_TIMEOUT = 30000; // 30 seconds

  constructor() {
    super();
    this.startRetryProcessor();
    this.loadEndpoints();
  }

  // Endpoint management
  async addEndpoint(
    url: string,
    events: string[],
    metadata?: Record<string, any>
  ): Promise<WebhookEndpoint> {
    const endpoint: WebhookEndpoint = {
      id: this.generateEndpointId(),
      url,
      events,
      secret: this.generateSecret(),
      enabled: true,
      createdAt: new Date(),
      failureCount: 0,
      metadata,
    };

    this.endpoints.set(endpoint.id, endpoint);
    await this.persistEndpoints();

    console.log(`🔗 Webhook endpoint added: ${endpoint.id} -> ${url}`);
    console.log(`📡 Listening for events: ${events.join(', ')}`);

    return endpoint;
  }

  async updateEndpoint(
    id: string,
    updates: Partial<Pick<WebhookEndpoint, 'url' | 'events' | 'enabled' | 'metadata'>>
  ): Promise<WebhookEndpoint | null> {
    const endpoint = this.endpoints.get(id);
    if (!endpoint) return null;

    Object.assign(endpoint, updates);
    await this.persistEndpoints();

    console.log(`🔗 Webhook endpoint updated: ${id}`);
    return endpoint;
  }

  async removeEndpoint(id: string): Promise<boolean> {
    const removed = this.endpoints.delete(id);
    if (removed) {
      await this.persistEndpoints();
      console.log(`🔗 Webhook endpoint removed: ${id}`);
    }
    return removed;
  }

  getEndpoint(id: string): WebhookEndpoint | undefined {
    return this.endpoints.get(id);
  }

  getAllEndpoints(): WebhookEndpoint[] {
    return Array.from(this.endpoints.values());
  }

  // Event emission
  async emitEvent(event: WebhookEvent): Promise<void> {
    const eventId = event.id || this.generateEventId();
    const timestamp = event.timestamp || Date.now();

    console.log(`📤 Webhook event: ${event.type} (${eventId})`);

    const relevantEndpoints = Array.from(this.endpoints.values())
      .filter(endpoint => endpoint.enabled && endpoint.events.includes(event.type));

    if (relevantEndpoints.length === 0) {
      console.log(`📭 No endpoints listening for event: ${event.type}`);
      return;
    }

    for (const endpoint of relevantEndpoints) {
      const delivery = this.createDelivery(endpoint, event, eventId, timestamp);
      this.deliveryQueue.push(delivery);
    }

    console.log(`📬 Queued ${relevantEndpoints.length} deliveries for event: ${event.type}`);
    this.processDeliveryQueue();
  }

  // Convenience methods for common events
  async emitJobCreated(jobId: string, jobData: any): Promise<void> {
    await this.emitEvent({
      type: WebhookEventTypes.JOB_CREATED,
      data: { jobId, ...jobData },
      timestamp: Date.now(),
      source: 'job-manager',
    });
  }

  async emitJobCompleted(jobId: string, result: any): Promise<void> {
    await this.emitEvent({
      type: WebhookEventTypes.JOB_COMPLETED,
      data: { jobId, result },
      timestamp: Date.now(),
      source: 'job-manager',
    });
  }

  async emitJobFailed(jobId: string, error: any): Promise<void> {
    await this.emitEvent({
      type: WebhookEventTypes.JOB_FAILED,
      data: { jobId, error: typeof error === 'string' ? error : error.message },
      timestamp: Date.now(),
      source: 'job-manager',
    });
  }

  async emitListingsBatch(listings: any[]): Promise<void> {
    await this.emitEvent({
      type: WebhookEventTypes.LISTING_BATCH,
      data: { listings, count: listings.length },
      timestamp: Date.now(),
      source: 'scraper',
    });
  }

  async emitSystemAlert(alert: any): Promise<void> {
    await this.emitEvent({
      type: WebhookEventTypes.SYSTEM_ALERT,
      data: alert,
      timestamp: Date.now(),
      source: 'monitoring',
    });
  }

  // Delivery processing
  private async processDeliveryQueue(): Promise<void> {
    if (this.processing || this.deliveryQueue.length === 0) return;

    this.processing = true;

    while (this.deliveryQueue.length > 0) {
      const delivery = this.deliveryQueue.shift()!;
      await this.attemptDelivery(delivery);
    }

    this.processing = false;
  }

  private async attemptDelivery(delivery: WebhookDelivery): Promise<void> {
    const endpoint = this.endpoints.get(delivery.endpointId);
    if (!endpoint || !endpoint.enabled) {
      console.log(`📪 Skipping delivery to disabled endpoint: ${delivery.endpointId}`);
      return;
    }

    try {
      console.log(`📮 Attempting webhook delivery: ${delivery.id} -> ${endpoint.url}`);

      const response = await this.sendWebhook(endpoint, delivery);

      if (response.ok) {
        delivery.status = 'delivered';
        delivery.responseStatus = response.status;
        delivery.lastAttempt = new Date();

        endpoint.lastDelivery = new Date();
        endpoint.lastStatus = response.status;
        endpoint.failureCount = 0;

        console.log(`✅ Webhook delivered successfully: ${delivery.id}`);
        this.emit('delivery:success', delivery, endpoint);
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

    } catch (error) {
      delivery.attempts++;
      delivery.lastAttempt = new Date();
      delivery.error = error instanceof Error ? error.message : String(error);
      delivery.responseStatus = error instanceof Error && 'status' in error ?
        (error as any).status : undefined;

      endpoint.failureCount++;

      if (delivery.attempts < this.MAX_RETRY_ATTEMPTS) {
        delivery.status = 'retry';
        delivery.nextRetry = new Date(Date.now() + this.RETRY_DELAYS[delivery.attempts - 1]);
        this.retryQueue.push(delivery);

        console.log(`🔄 Webhook delivery failed, will retry: ${delivery.id} (attempt ${delivery.attempts}/${this.MAX_RETRY_ATTEMPTS})`);
        this.emit('delivery:retry', delivery, endpoint);
      } else {
        delivery.status = 'failed';

        console.log(`❌ Webhook delivery failed permanently: ${delivery.id}`);
        this.emit('delivery:failed', delivery, endpoint);

        // Disable endpoint after too many failures
        if (endpoint.failureCount > 10) {
          endpoint.enabled = false;
          console.log(`🚫 Disabled webhook endpoint due to repeated failures: ${endpoint.id}`);
          await this.persistEndpoints();
        }
      }
    }

    await this.persistEndpoints();
  }

  private async sendWebhook(endpoint: WebhookEndpoint, delivery: WebhookDelivery): Promise<Response> {
    const payload = JSON.stringify(delivery.payload);
    const signature = this.generateSignature(payload, endpoint.secret);

    return fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'BizBuySell-Scraper-Webhook/1.0',
        'X-Webhook-Signature-256': signature,
        'X-Webhook-Delivery': delivery.id,
        'X-Webhook-Event': delivery.event,
        'X-Webhook-Timestamp': delivery.createdAt.getTime().toString(),
      },
      body: payload,
      signal: AbortSignal.timeout(this.DELIVERY_TIMEOUT),
    });
  }

  private createDelivery(
    endpoint: WebhookEndpoint,
    event: WebhookEvent,
    eventId: string,
    timestamp: number
  ): WebhookDelivery {
    const payload = {
      id: eventId,
      type: event.type,
      data: event.data,
      timestamp,
      source: event.source,
    };

    return {
      id: this.generateDeliveryId(),
      endpointId: endpoint.id,
      event: event.type,
      payload,
      signature: this.generateSignature(JSON.stringify(payload), endpoint.secret),
      status: 'pending',
      attempts: 0,
      createdAt: new Date(),
    };
  }

  // Retry processing
  private startRetryProcessor(): void {
    this.retryIntervalId = setInterval(() => {
      this.processRetryQueue();
    }, 30000); // Check every 30 seconds
  }

  private async processRetryQueue(): Promise<void> {
    const now = Date.now();
    const readyForRetry = this.retryQueue.filter(delivery =>
      delivery.nextRetry && delivery.nextRetry.getTime() <= now
    );

    for (const delivery of readyForRetry) {
      const index = this.retryQueue.indexOf(delivery);
      if (index !== -1) {
        this.retryQueue.splice(index, 1);
        await this.attemptDelivery(delivery);
      }
    }
  }

  // Signature generation and validation
  private generateSignature(payload: string, secret: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  }

  validateSignature(payload: string, signature: string, secret: string): boolean {
    const expectedSignature = this.generateSignature(payload, secret);
    return signature === expectedSignature;
  }

  // Utility methods
  private generateEndpointId(): string {
    return 'ep_' + createHash('md5').update(Date.now() + Math.random().toString()).digest('hex').substring(0, 16);
  }

  private generateDeliveryId(): string {
    return 'del_' + createHash('md5').update(Date.now() + Math.random().toString()).digest('hex').substring(0, 16);
  }

  private generateEventId(): string {
    return 'evt_' + createHash('md5').update(Date.now() + Math.random().toString()).digest('hex').substring(0, 16);
  }

  private generateSecret(): string {
    return createHash('sha256').update(Date.now() + Math.random().toString()).digest('hex');
  }

  // Persistence (in production, use database)
  private async loadEndpoints(): Promise<void> {
    try {
      // In production, load from database
      console.log('📝 Loading webhook endpoints from storage...');
    } catch (error) {
      console.error('Failed to load webhook endpoints:', error);
    }
  }

  private async persistEndpoints(): Promise<void> {
    try {
      // In production, save to database
      console.log('💾 Persisting webhook endpoints to storage...');
    } catch (error) {
      console.error('Failed to persist webhook endpoints:', error);
    }
  }

  // Statistics and monitoring
  getStats(): {
    totalEndpoints: number;
    activeEndpoints: number;
    pendingDeliveries: number;
    retryQueue: number;
    recentDeliveries: number;
  } {
    const activeEndpoints = Array.from(this.endpoints.values()).filter(e => e.enabled).length;

    return {
      totalEndpoints: this.endpoints.size,
      activeEndpoints,
      pendingDeliveries: this.deliveryQueue.length,
      retryQueue: this.retryQueue.length,
      recentDeliveries: 0, // Would track in production
    };
  }

  // Cleanup
  stop(): void {
    if (this.retryIntervalId) {
      clearInterval(this.retryIntervalId);
    }
    console.log('🛑 Webhook manager stopped');
  }
}

// Global webhook manager instance
export const webhookManager = new WebhookManager();

// Export event types for external use
export { WebhookEventTypes };