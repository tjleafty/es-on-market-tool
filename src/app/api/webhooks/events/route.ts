import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { webhookManager, WebhookEventTypes } from '@/lib/webhooks/webhook-manager';
import { withAuth } from '@/lib/auth/middleware';
import { PERMISSIONS } from '@/lib/auth/api-auth';

const ManualEventSchema = z.object({
  type: z.enum([
    'job.created',
    'job.started',
    'job.progress',
    'job.completed',
    'job.failed',
    'job.cancelled',
    'listing.created',
    'listing.updated',
    'listing.batch',
    'system.alert',
    'system.health',
    'api.limit_exceeded',
    'export.started',
    'export.completed',
    'export.failed',
  ]),
  data: z.record(z.string(), z.any()),
  source: z.string().default('manual'),
});

const BulkEventSchema = z.object({
  events: z.array(ManualEventSchema).min(1).max(50), // Limit bulk events
});

// GET /api/webhooks/events - Get webhook event types and documentation
export const GET = withAuth(async (request, authContext) => {
  try {
    const eventDocumentation = {
      [WebhookEventTypes.JOB_CREATED]: {
        description: 'Fired when a new scraping job is created',
        payload: {
          jobId: 'string',
          status: 'PENDING',
          filters: 'object',
          createdAt: 'ISO 8601 timestamp',
          estimatedDuration: 'number (milliseconds)',
        },
        example: {
          jobId: 'job_abc123',
          status: 'PENDING',
          filters: { state: 'CA', industry: 'restaurant' },
          createdAt: '2024-01-01T00:00:00Z',
          estimatedDuration: 300000,
        },
      },
      [WebhookEventTypes.JOB_COMPLETED]: {
        description: 'Fired when a scraping job completes successfully',
        payload: {
          jobId: 'string',
          status: 'COMPLETED',
          result: 'object',
          duration: 'number (milliseconds)',
          listingsFound: 'number',
          completedAt: 'ISO 8601 timestamp',
        },
        example: {
          jobId: 'job_abc123',
          status: 'COMPLETED',
          result: { success: true },
          duration: 285000,
          listingsFound: 157,
          completedAt: '2024-01-01T00:05:00Z',
        },
      },
      [WebhookEventTypes.JOB_FAILED]: {
        description: 'Fired when a scraping job fails',
        payload: {
          jobId: 'string',
          status: 'FAILED',
          error: 'string',
          duration: 'number (milliseconds)',
          failedAt: 'ISO 8601 timestamp',
        },
        example: {
          jobId: 'job_abc123',
          status: 'FAILED',
          error: 'Connection timeout',
          duration: 60000,
          failedAt: '2024-01-01T00:01:00Z',
        },
      },
      [WebhookEventTypes.LISTING_BATCH]: {
        description: 'Fired when a batch of listings is processed',
        payload: {
          listings: 'array of listing objects',
          count: 'number',
          jobId: 'string',
          batchNumber: 'number',
        },
        example: {
          listings: [
            { id: 'listing_1', title: 'Pizza Restaurant', price: 150000 },
            { id: 'listing_2', title: 'Coffee Shop', price: 85000 },
          ],
          count: 2,
          jobId: 'job_abc123',
          batchNumber: 1,
        },
      },
      [WebhookEventTypes.SYSTEM_ALERT]: {
        description: 'Fired when system alerts are triggered',
        payload: {
          level: 'info | warning | error',
          title: 'string',
          message: 'string',
          component: 'string',
          metadata: 'object (optional)',
        },
        example: {
          level: 'warning',
          title: 'High Memory Usage',
          message: 'Memory usage is at 85%',
          component: 'scraper',
          metadata: { currentUsage: 85.2, threshold: 85 },
        },
      },
      [WebhookEventTypes.EXPORT_COMPLETED]: {
        description: 'Fired when a data export completes',
        payload: {
          exportId: 'string',
          format: 'csv | excel | json | xml',
          recordCount: 'number',
          fileSize: 'number (bytes)',
          downloadUrl: 'string (optional)',
          completedAt: 'ISO 8601 timestamp',
        },
        example: {
          exportId: 'export_xyz789',
          format: 'csv',
          recordCount: 1500,
          fileSize: 245760,
          downloadUrl: 'https://api.example.com/exports/xyz789/download',
          completedAt: '2024-01-01T00:10:00Z',
        },
      },
    };

    const { searchParams } = new URL(request.url);
    const eventType = searchParams.get('type');

    if (eventType && eventType in eventDocumentation) {
      return NextResponse.json({
        success: true,
        data: {
          type: eventType,
          ...eventDocumentation[eventType as keyof typeof eventDocumentation],
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        availableEvents: Object.keys(eventDocumentation),
        events: eventDocumentation,
        webhookFormat: {
          description: 'All webhooks are sent as HTTP POST requests with the following format',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'BizBuySell-Scraper-Webhook/1.0',
            'X-Webhook-Signature-256': 'sha256=<signature>',
            'X-Webhook-Delivery': '<delivery_id>',
            'X-Webhook-Event': '<event_type>',
            'X-Webhook-Timestamp': '<unix_timestamp>',
          },
          payload: {
            id: 'unique event ID',
            type: 'event type',
            data: 'event-specific payload',
            timestamp: 'unix timestamp',
            source: 'source component',
          },
        },
        signatureVerification: {
          description: 'Verify webhook authenticity using HMAC-SHA256',
          algorithm: 'HMAC-SHA256',
          format: 'sha256=<hex_digest>',
          example_code: {
            node_js: `
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const digest = 'sha256=' + hmac.digest('hex');
  return signature === digest;
}`,
            python: `
import hmac
import hashlib

def verify_webhook(payload, signature, secret):
    digest = 'sha256=' + hmac.new(
        secret.encode(),
        payload.encode(),
        hashlib.sha256
    ).hexdigest()
    return signature == digest`,
          },
        },
      },
    });

  } catch (error) {
    console.error('Failed to get webhook events:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to get webhook events',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}, {
  required: true,
  permissions: [PERMISSIONS.WEBSOCKET_CONNECT],
});

// POST /api/webhooks/events - Manually trigger webhook events (admin only)
export const POST = withAuth(async (request, authContext) => {
  try {
    const body = await request.json();
    const isBulk = 'events' in body;

    if (isBulk) {
      const bulkRequest = BulkEventSchema.parse(body);

      console.log(`📤 Manually triggering ${bulkRequest.events.length} webhook events`);

      for (const eventData of bulkRequest.events) {
        await webhookManager.emitEvent({
          type: eventData.type,
          data: eventData.data,
          timestamp: Date.now(),
          source: eventData.source,
        });
      }

      return NextResponse.json({
        success: true,
        message: `${bulkRequest.events.length} events triggered successfully`,
        data: {
          eventCount: bulkRequest.events.length,
          events: bulkRequest.events.map(e => e.type),
        },
      });
    } else {
      const eventRequest = ManualEventSchema.parse(body);

      console.log(`📤 Manually triggering webhook event: ${eventRequest.type}`);

      await webhookManager.emitEvent({
        type: eventRequest.type,
        data: eventRequest.data,
        timestamp: Date.now(),
        source: eventRequest.source,
      });

      return NextResponse.json({
        success: true,
        message: 'Event triggered successfully',
        data: {
          type: eventRequest.type,
          source: eventRequest.source,
        },
      });
    }

  } catch (error) {
    console.error('Failed to trigger webhook event:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid event request',
        details: error.issues,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to trigger webhook event',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}, {
  required: true,
  permissions: [PERMISSIONS.ADMIN_SYSTEM], // Admin only for manual events
});