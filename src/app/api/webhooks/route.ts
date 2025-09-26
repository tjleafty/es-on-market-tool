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
  metadata: z.record(z.any()).optional(),
});

const UpdateWebhookSchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
});

const TestWebhookSchema = z.object({
  endpointId: z.string(),
  eventType: z.string().default('system.health'),
  testData: z.record(z.any()).optional(),
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
        details: error.errors,
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

// PUT /api/webhooks/[id] - Update webhook endpoint
export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  return await withAuth(async (req, authContext) => {
    try {
      const endpointId = params.id;
      const body = await request.json();
      const updateRequest = UpdateWebhookSchema.parse(body);

      console.log(`🔗 Updating webhook endpoint: ${endpointId}`);

      const updatedEndpoint = await webhookManager.updateEndpoint(endpointId, updateRequest);

      if (!updatedEndpoint) {
        return NextResponse.json({
          success: false,
          error: 'Webhook endpoint not found',
        }, { status: 404 });
      }

      return NextResponse.json({
        success: true,
        data: {
          id: updatedEndpoint.id,
          url: updatedEndpoint.url,
          events: updatedEndpoint.events,
          enabled: updatedEndpoint.enabled,
          lastDelivery: updatedEndpoint.lastDelivery,
          lastStatus: updatedEndpoint.lastStatus,
          metadata: updatedEndpoint.metadata,
        },
        message: 'Webhook endpoint updated successfully',
      });

    } catch (error) {
      console.error('Failed to update webhook endpoint:', error);

      if (error instanceof z.ZodError) {
        return NextResponse.json({
          success: false,
          error: 'Invalid webhook update request',
          details: error.errors,
        }, { status: 400 });
      }

      return NextResponse.json({
        success: false,
        error: 'Failed to update webhook endpoint',
        message: error instanceof Error ? error.message : 'Unknown error',
      }, { status: 500 });
    }
  }, {
    required: true,
    permissions: [PERMISSIONS.WEBSOCKET_SUBSCRIBE],
  })(request);
}

// DELETE /api/webhooks/[id] - Delete webhook endpoint
export async function DELETE(request: NextRequest, { params }: { params: { id: string } }) {
  return await withAuth(async (req, authContext) => {
    try {
      const endpointId = params.id;

      console.log(`🗑️ Deleting webhook endpoint: ${endpointId}`);

      const removed = await webhookManager.removeEndpoint(endpointId);

      if (!removed) {
        return NextResponse.json({
          success: false,
          error: 'Webhook endpoint not found',
        }, { status: 404 });
      }

      return NextResponse.json({
        success: true,
        message: 'Webhook endpoint deleted successfully',
      });

    } catch (error) {
      console.error('Failed to delete webhook endpoint:', error);

      return NextResponse.json({
        success: false,
        error: 'Failed to delete webhook endpoint',
        message: error instanceof Error ? error.message : 'Unknown error',
      }, { status: 500 });
    }
  }, {
    required: true,
    permissions: [PERMISSIONS.WEBSOCKET_SUBSCRIBE],
  })(request);
}

// POST /api/webhooks/test - Test webhook endpoint
export async function testWebhookEndpoint(request: NextRequest) {
  return await withAuth(async (req, authContext) => {
    try {
      const body = await request.json();
      const testRequest = TestWebhookSchema.parse(body);

      console.log(`🧪 Testing webhook endpoint: ${testRequest.endpointId}`);

      const endpoint = webhookManager.getEndpoint(testRequest.endpointId);
      if (!endpoint) {
        return NextResponse.json({
          success: false,
          error: 'Webhook endpoint not found',
        }, { status: 404 });
      }

      // Emit a test event
      await webhookManager.emitEvent({
        type: testRequest.eventType,
        data: testRequest.testData || {
          test: true,
          message: 'This is a test webhook delivery',
          timestamp: new Date().toISOString(),
        },
        timestamp: Date.now(),
        source: 'test',
        id: `test_${Date.now()}`,
      });

      return NextResponse.json({
        success: true,
        message: 'Test webhook sent successfully',
        data: {
          endpointId: endpoint.id,
          eventType: testRequest.eventType,
        },
      });

    } catch (error) {
      console.error('Failed to test webhook endpoint:', error);

      if (error instanceof z.ZodError) {
        return NextResponse.json({
          success: false,
          error: 'Invalid webhook test request',
          details: error.errors,
        }, { status: 400 });
      }

      return NextResponse.json({
        success: false,
        error: 'Failed to test webhook endpoint',
        message: error instanceof Error ? error.message : 'Unknown error',
      }, { status: 500 });
    }
  }, {
    required: true,
    permissions: [PERMISSIONS.WEBSOCKET_SUBSCRIBE],
  })(request);
}