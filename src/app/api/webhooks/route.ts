import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { webhookManager, WebhookEventTypes } from '@/lib/webhooks/webhook-manager';
import { withAuth } from '@/lib/auth/middleware';
import { PERMISSIONS } from '@/lib/auth/api-auth';

const CreateWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum([
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
  ])).min(1),
  metadata: z.record(z.string(), z.any()).optional(),
});

const UpdateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const TestWebhookSchema = z.object({
  endpointId: z.string(),
  eventType: z.string().default('system.health'),
  testData: z.record(z.string(), z.any()).optional(),
});

// GET /api/webhooks - List webhook endpoints
export const GET = withAuth(async (request, authContext) => {
  try {
    const endpoints = webhookManager.getAllEndpoints();
    const stats = webhookManager.getStats();

    // Filter sensitive information for non-admin users
    const isAdmin = authContext?.permissions.has(PERMISSIONS.ADMIN_SYSTEM);
    const filteredEndpoints = endpoints.map(endpoint => ({
      id: endpoint.id,
      url: endpoint.url,
      events: endpoint.events,
      enabled: endpoint.enabled,
      createdAt: endpoint.createdAt,
      lastDelivery: endpoint.lastDelivery,
      lastStatus: endpoint.lastStatus,
      failureCount: isAdmin ? endpoint.failureCount : undefined,
      metadata: endpoint.metadata,
      // Never expose the secret
    }));

    return NextResponse.json({
      success: true,
      data: {
        endpoints: filteredEndpoints,
        stats,
        availableEvents: Object.values(WebhookEventTypes),
      },
    });

  } catch (error) {
    console.error('Failed to list webhook endpoints:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to list webhook endpoints',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}, {
  required: true,
  permissions: [PERMISSIONS.WEBSOCKET_CONNECT], // Basic permission for webhook access
});

// POST /api/webhooks - Create webhook endpoint
export const POST = withAuth(async (request, authContext) => {
  try {
    const body = await request.json();
    const webhookRequest = CreateWebhookSchema.parse(body);

    console.log(`🔗 Creating webhook endpoint: ${webhookRequest.url}`);

    const endpoint = await webhookManager.addEndpoint(
      webhookRequest.url,
      webhookRequest.events,
      webhookRequest.metadata
    );

    return NextResponse.json({
      success: true,
      data: {
        id: endpoint.id,
        url: endpoint.url,
        events: endpoint.events,
        secret: endpoint.secret, // Only returned on creation
        enabled: endpoint.enabled,
        createdAt: endpoint.createdAt,
        metadata: endpoint.metadata,
      },
      message: 'Webhook endpoint created successfully. Store the secret securely - it will not be shown again.',
    }, { status: 201 });

  } catch (error) {
    console.error('Failed to create webhook endpoint:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid webhook request',
        details: error.issues,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to create webhook endpoint',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}, {
  required: true,
  permissions: [PERMISSIONS.WEBSOCKET_SUBSCRIBE], // Higher permission for webhook creation
});

// Note: PUT and DELETE for specific webhook IDs would be in a [id]/route.ts file
// Test webhook endpoint would be in a separate test/route.ts file
// Removed to fix build issues since this is the main webhooks route