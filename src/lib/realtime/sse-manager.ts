import { EventEmitter } from 'events';

export interface SSEClient {
  id: string;
  response: Response;
  controller: ReadableStreamDefaultController;
  subscriptions: Set<string>;
  lastPing: number;
  metadata: {
    userAgent?: string;
    connectedAt: number;
  };
}

export interface SSEMessage {
  id?: string;
  event?: string;
  data: any;
  retry?: number;
}

export class SSEManager extends EventEmitter {
  private clients = new Map<string, SSEClient>();
  private subscriptions = new Map<string, Set<string>>(); // topic -> client IDs
  private pingInterval?: NodeJS.Timeout;

  constructor() {
    super();
    this.startPingInterval();
  }

  createConnection(request: Request): Response {
    const clientId = this.generateClientId();

    const stream = new ReadableStream({
      start: (controller) => {
        const client: SSEClient = {
          id: clientId,
          response: new Response(), // Will be overridden
          controller,
          subscriptions: new Set(),
          lastPing: Date.now(),
          metadata: {
            userAgent: request.headers.get('user-agent') || undefined,
            connectedAt: Date.now(),
          },
        };

        this.clients.set(clientId, client);

        // Send initial connection message
        this.sendToClient(clientId, {
          event: 'connected',
          data: {
            clientId,
            timestamp: Date.now(),
            message: 'Connected to real-time updates',
          },
        });

        console.log(`📡 SSE client connected: ${clientId}`);
        this.emit('clientConnected', client);
      },

      cancel: () => {
        this.handleClientDisconnect(clientId);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control',
      },
    });
  }

  private handleClientDisconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Remove from all subscriptions
    client.subscriptions.forEach(topic => {
      const topicSubscribers = this.subscriptions.get(topic);
      if (topicSubscribers) {
        topicSubscribers.delete(clientId);
        if (topicSubscribers.size === 0) {
          this.subscriptions.delete(topic);
        }
      }
    });

    this.clients.delete(clientId);

    const duration = Date.now() - client.metadata.connectedAt;
    console.log(`📡 SSE client disconnected: ${clientId} (connected for ${Math.round(duration / 1000)}s)`);

    this.emit('clientDisconnected', clientId, client);
  }

  subscribe(clientId: string, topic: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    // Add client to subscription
    client.subscriptions.add(topic);

    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, new Set());
    }
    this.subscriptions.get(topic)!.add(clientId);

    console.log(`📡 SSE client ${clientId} subscribed to: ${topic}`);

    this.sendToClient(clientId, {
      event: 'subscribed',
      data: {
        topic,
        message: `Subscribed to ${topic}`,
      },
    });

    return true;
  }

  unsubscribe(clientId: string, topic: string): boolean {
    const client = this.clients.get(clientId);
    if (!client) return false;

    client.subscriptions.delete(topic);

    const topicSubscribers = this.subscriptions.get(topic);
    if (topicSubscribers) {
      topicSubscribers.delete(clientId);
      if (topicSubscribers.size === 0) {
        this.subscriptions.delete(topic);
      }
    }

    console.log(`📡 SSE client ${clientId} unsubscribed from: ${topic}`);

    this.sendToClient(clientId, {
      event: 'unsubscribed',
      data: {
        topic,
        message: `Unsubscribed from ${topic}`,
      },
    });

    return true;
  }

  // Public methods for broadcasting updates
  broadcast(message: SSEMessage): void {
    this.clients.forEach((client, clientId) => {
      this.sendToClient(clientId, message);
    });
  }

  broadcastToTopic(topic: string, message: SSEMessage): void {
    const subscribers = this.subscriptions.get(topic);
    if (!subscribers) return;

    subscribers.forEach(clientId => {
      this.sendToClient(clientId, message);
    });
  }

  sendJobUpdate(jobId: string, update: any): void {
    const message: SSEMessage = {
      id: `job_${jobId}_${Date.now()}`,
      event: 'jobUpdate',
      data: {
        jobId,
        ...update,
        timestamp: Date.now(),
      },
    };

    // Send to job-specific subscribers
    this.broadcastToTopic(`job:${jobId}`, message);
    // Send to global job updates subscribers
    this.broadcastToTopic('jobs', message);
  }

  sendScrapingProgress(jobId: string, progress: any): void {
    const message: SSEMessage = {
      id: `progress_${jobId}_${Date.now()}`,
      event: 'scrapingProgress',
      data: {
        jobId,
        ...progress,
        timestamp: Date.now(),
      },
    };

    this.broadcastToTopic(`job:${jobId}`, message);
    this.broadcastToTopic('progress', message);
  }

  sendSystemStatus(status: any): void {
    const message: SSEMessage = {
      id: `system_${Date.now()}`,
      event: 'systemStatus',
      data: {
        ...status,
        timestamp: Date.now(),
      },
    };

    this.broadcastToTopic('system', message);
  }

  private sendToClient(clientId: string, message: SSEMessage): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    try {
      const sseData = this.formatSSEMessage(message);
      client.controller.enqueue(new TextEncoder().encode(sseData));
    } catch (error) {
      console.error(`Failed to send SSE message to client ${clientId}:`, error);
      this.handleClientDisconnect(clientId);
    }
  }

  private formatSSEMessage(message: SSEMessage): string {
    let sseString = '';

    if (message.id) {
      sseString += `id: ${message.id}\n`;
    }

    if (message.event) {
      sseString += `event: ${message.event}\n`;
    }

    if (message.retry) {
      sseString += `retry: ${message.retry}\n`;
    }

    // Format data - can be multiline
    const dataString = typeof message.data === 'string'
      ? message.data
      : JSON.stringify(message.data);

    dataString.split('\n').forEach(line => {
      sseString += `data: ${line}\n`;
    });

    sseString += '\n'; // Double newline ends the message

    return sseString;
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now();
      const staleThreshold = 60000; // 60 seconds

      this.clients.forEach((client, clientId) => {
        if (now - client.lastPing > staleThreshold) {
          console.warn(`Stale SSE client detected: ${clientId}, disconnecting...`);
          this.handleClientDisconnect(clientId);
          return;
        }

        // Send ping
        this.sendToClient(clientId, {
          event: 'ping',
          data: { timestamp: now },
        });

        client.lastPing = now;
      });
    }, 30000); // Every 30 seconds
  }

  private generateClientId(): string {
    return `sse_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  // Statistics and monitoring
  getStats(): {
    connectedClients: number;
    totalSubscriptions: number;
    topicBreakdown: Record<string, number>;
    averageConnectionTime: number;
  } {
    const now = Date.now();
    const connectionTimes = Array.from(this.clients.values())
      .map(client => now - client.metadata.connectedAt);

    const averageConnectionTime = connectionTimes.length > 0
      ? connectionTimes.reduce((sum, time) => sum + time, 0) / connectionTimes.length
      : 0;

    const topicBreakdown: Record<string, number> = {};
    this.subscriptions.forEach((subscribers, topic) => {
      topicBreakdown[topic] = subscribers.size;
    });

    return {
      connectedClients: this.clients.size,
      totalSubscriptions: Array.from(this.clients.values())
        .reduce((sum, client) => sum + client.subscriptions.size, 0),
      topicBreakdown,
      averageConnectionTime: Math.round(averageConnectionTime / 1000), // in seconds
    };
  }

  getClientInfo(clientId: string): SSEClient | undefined {
    return this.clients.get(clientId);
  }

  getAllClients(): SSEClient[] {
    return Array.from(this.clients.values());
  }

  // Cleanup
  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    // Close all connections
    this.clients.forEach((client, clientId) => {
      try {
        client.controller.close();
      } catch (error) {
        // Connection might already be closed
      }
    });

    this.clients.clear();
    this.subscriptions.clear();

    console.log('🛑 SSE manager stopped');
  }
}

// Global SSE manager instance
export const sseManager = new SSEManager();