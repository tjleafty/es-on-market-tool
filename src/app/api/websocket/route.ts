import { NextRequest, NextResponse } from 'next/server';
import { wsManager } from '@/lib/websocket/websocket-manager';

export async function GET(request: NextRequest) {
  try {
    const stats = wsManager.getStats();
    const clients = wsManager.getAllClients().map(client => ({
      id: client.id,
      subscriptions: Array.from(client.subscriptions),
      connectedAt: client.metadata.connectedAt,
      lastPing: client.lastPing,
      userAgent: client.metadata.userAgent,
      ipAddress: client.metadata.ipAddress,
    }));

    return NextResponse.json({
      success: true,
      websocket: {
        status: 'running',
        stats,
        clients: clients.slice(0, 10), // Limit for security
        totalClients: clients.length,
      },
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: 'Failed to get WebSocket status',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, topic, data, jobId } = body;

    switch (type) {
      case 'broadcast':
        wsManager.broadcast({
          type: 'broadcast',
          data,
          timestamp: Date.now(),
        });
        break;

      case 'broadcastToTopic':
        if (!topic) {
          return NextResponse.json({
            success: false,
            error: 'Topic is required for topic broadcast',
          }, { status: 400 });
        }

        wsManager.broadcastToTopic(topic, {
          type: 'topicBroadcast',
          data,
          timestamp: Date.now(),
        });
        break;

      case 'jobUpdate':
        if (!jobId) {
          return NextResponse.json({
            success: false,
            error: 'Job ID is required for job updates',
          }, { status: 400 });
        }

        wsManager.sendJobUpdate(jobId, data);
        break;

      case 'systemStatus':
        wsManager.sendSystemStatus(data);
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
    return NextResponse.json({
      success: false,
      error: 'Failed to send WebSocket message',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}