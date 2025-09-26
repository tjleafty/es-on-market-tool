import { NextRequest, NextResponse } from 'next/server';
import { sseManager } from '@/lib/realtime/sse-manager';
import { getAuthContext } from '@/lib/auth/middleware';
import { PERMISSIONS } from '@/lib/auth/api-auth';

// GET /api/realtime/status - Get real-time connection status
export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const authContext = await getAuthContext(request);
    if (!authContext) {
      return NextResponse.json({
        success: false,
        error: 'Authentication required',
      }, { status: 401 });
    }

    const stats = sseManager.getStats();
    const clients = sseManager.getAllClients().map(client => ({
      id: client.id,
      subscriptions: Array.from(client.subscriptions),
      connectedAt: client.metadata.connectedAt,
      lastPing: client.lastPing,
      userAgent: client.metadata.userAgent,
    }));

    return NextResponse.json({
      success: true,
      realtime: {
        status: 'running',
        type: 'Server-Sent Events',
        stats,
        clients: authContext.permissions.has(PERMISSIONS.ADMIN_SYSTEM)
          ? clients
          : clients.slice(0, 5), // Limit for non-admin users
        totalClients: clients.length,
      },
    });

  } catch (error) {
    console.error('Failed to get real-time status:', error);

    return NextResponse.json({
      success: false,
      error: 'Failed to get real-time status',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

// POST /api/realtime/status - Send test messages or trigger broadcasts
export async function POST(request: NextRequest) {
  try {
    // Check authentication and admin permissions
    const authContext = await getAuthContext(request);
    if (!authContext || !authContext.permissions.has(PERMISSIONS.ADMIN_SYSTEM)) {
      return NextResponse.json({
        success: false,
        error: 'Admin access required',
      }, { status: 403 });
    }

    const body = await request.json();
    const { type, topic, data, clientId } = body;

    switch (type) {
      case 'broadcast':
        sseManager.broadcast({
          event: 'test_broadcast',
          data: {
            message: 'Test broadcast message',
            ...data,
            timestamp: Date.now(),
          },
        });
        break;

      case 'broadcastToTopic':
        if (!topic) {
          return NextResponse.json({
            success: false,
            error: 'Topic is required for topic broadcast',
          }, { status: 400 });
        }

        sseManager.broadcastToTopic(topic, {
          event: 'test_topic_broadcast',
          data: {
            message: `Test broadcast to topic: ${topic}`,
            topic,
            ...data,
            timestamp: Date.now(),
          },
        });
        break;

      case 'jobUpdate':
        if (!data?.jobId) {
          return NextResponse.json({
            success: false,
            error: 'Job ID is required for job updates',
          }, { status: 400 });
        }

        sseManager.sendJobUpdate(data.jobId, {
          status: 'PROCESSING',
          progress: 50,
          message: 'Test job update',
          ...data,
        });
        break;

      case 'systemStatus':
        sseManager.sendSystemStatus({
          status: 'healthy',
          message: 'Test system status update',
          ...data,
        });
        break;

      case 'ping':
        if (clientId) {
          const client = sseManager.getClientInfo(clientId);
          if (client) {
            sseManager.sendToClient(clientId, {
              event: 'ping',
              data: {
                message: 'Test ping from server',
                timestamp: Date.now(),
              },
            });
          } else {
            return NextResponse.json({
              success: false,
              error: 'Client not found',
            }, { status: 404 });
          }
        } else {
          // Ping all clients
          sseManager.broadcast({
            event: 'ping',
            data: {
              message: 'Test ping to all clients',
              timestamp: Date.now(),
            },
          });
        }
        break;

      default:
        return NextResponse.json({
          success: false,
          error: `Unknown broadcast type: ${type}`,
        }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: `${type} sent successfully`,
    });

  } catch (error) {
    console.error('Failed to send real-time message:', error);

    return NextResponse.json({
      success: false,
      error: 'Failed to send real-time message',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}