import { NextRequest } from 'next/server';
import { sseManager } from '@/lib/realtime/sse-manager';
import { getAuthContext } from '@/lib/auth/middleware';
import { PERMISSIONS } from '@/lib/auth/api-auth';

// GET /api/realtime - Establish Server-Sent Events connection
export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const authContext = await getAuthContext(request);
    if (!authContext) {
      return new Response('Authentication required', { status: 401 });
    }

    // Check permissions
    if (!authContext.permissions.has(PERMISSIONS.WEBSOCKET_CONNECT)) {
      return new Response('Insufficient permissions', { status: 403 });
    }

    console.log('📡 New SSE connection request');

    // Create SSE connection
    const response = sseManager.createConnection(request);

    return response;

  } catch (error) {
    console.error('SSE connection error:', error);
    return new Response('Connection failed', { status: 500 });
  }
}

// POST /api/realtime - Handle subscription requests
export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const authContext = await getAuthContext(request);
    if (!authContext) {
      return Response.json({
        success: false,
        error: 'Authentication required',
      }, { status: 401 });
    }

    const body = await request.json();
    const { clientId, action, topic } = body;

    if (!clientId || !action) {
      return Response.json({
        success: false,
        error: 'Client ID and action are required',
      }, { status: 400 });
    }

    switch (action) {
      case 'subscribe':
        if (!topic) {
          return Response.json({
            success: false,
            error: 'Topic is required for subscription',
          }, { status: 400 });
        }

        const subscribed = sseManager.subscribe(clientId, topic);
        return Response.json({
          success: subscribed,
          message: subscribed ? 'Subscribed successfully' : 'Client not found',
        });

      case 'unsubscribe':
        if (!topic) {
          return Response.json({
            success: false,
            error: 'Topic is required for unsubscription',
          }, { status: 400 });
        }

        const unsubscribed = sseManager.unsubscribe(clientId, topic);
        return Response.json({
          success: unsubscribed,
          message: unsubscribed ? 'Unsubscribed successfully' : 'Client not found',
        });

      case 'status':
        const client = sseManager.getClientInfo(clientId);
        return Response.json({
          success: true,
          data: client ? {
            id: client.id,
            subscriptions: Array.from(client.subscriptions),
            connectedAt: client.metadata.connectedAt,
            lastPing: client.lastPing,
          } : null,
        });

      default:
        return Response.json({
          success: false,
          error: `Unknown action: ${action}`,
        }, { status: 400 });
    }

  } catch (error) {
    console.error('SSE request error:', error);
    return Response.json({
      success: false,
      error: 'Request failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}