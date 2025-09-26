import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { parse } from 'url';
import { EventEmitter } from 'events';

export interface WebSocketMessage {
  type: string;
  id?: string;
  data: any;
  timestamp: number;
}

export interface ClientConnection {
  ws: WebSocket;
  id: string;
  subscriptions: Set<string>;
  lastPing: number;
  metadata: {
    userAgent?: string;
    ipAddress?: string;
    connectedAt: number;
  };
}

export class WebSocketManager extends EventEmitter {
  private wss?: WebSocketServer;
  private clients = new Map<string, ClientConnection>();
  private subscriptions = new Map<string, Set<string>>(); // topic -> client IDs
  private pingInterval?: NodeJS.Timeout;

  constructor(private port: number = 8080) {
    super();
  }

  start(): void {
    this.wss = new WebSocketServer({
      port: this.port,
      perMessageDeflate: false,
    });

    this.wss.on('connection', this.handleConnection.bind(this));
    this.startPingInterval();

    console.log(`🌐 WebSocket server started on port ${this.port}`);
  }

  stop(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    this.clients.forEach(client => {
      client.ws.close();
    });

    if (this.wss) {
      this.wss.close();
    }

    console.log('🛑 WebSocket server stopped');
  }

  private handleConnection(ws: WebSocket, request: IncomingMessage): void {
    const clientId = this.generateClientId();
    const url = parse(request.url || '', true);

    const client: ClientConnection = {
      ws,
      id: clientId,
      subscriptions: new Set(),
      lastPing: Date.now(),
      metadata: {
        userAgent: request.headers['user-agent'],
        ipAddress: request.headers['x-forwarded-for'] as string || request.socket.remoteAddress,
        connectedAt: Date.now(),
      },
    };

    this.clients.set(clientId, client);

    console.log(`🔌 Client connected: ${clientId} (${client.metadata.ipAddress})`);

    // Send welcome message
    this.sendToClient(clientId, {
      type: 'connection',
      id: clientId,
      data: {
        message: 'Connected to scraper WebSocket',
        clientId,
        serverTime: Date.now(),
      },
      timestamp: Date.now(),
    });

    // Handle messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleClientMessage(clientId, message);
      } catch (error) {
        console.warn(`Invalid message from client ${clientId}:`, error);
        this.sendError(clientId, 'Invalid JSON message');
      }
    });

    // Handle connection close
    ws.on('close', () => {
      this.handleClientDisconnect(clientId);
    });

    // Handle errors
    ws.on('error', (error) => {
      console.error(`WebSocket error for client ${clientId}:`, error);
      this.handleClientDisconnect(clientId);
    });

    // Handle pong responses
    ws.on('pong', () => {
      const client = this.clients.get(clientId);
      if (client) {
        client.lastPing = Date.now();
      }
    });

    this.emit('clientConnected', client);
  }

  private handleClientMessage(clientId: string, message: any): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    switch (message.type) {
      case 'subscribe':
        this.handleSubscribe(clientId, message.topic);
        break;

      case 'unsubscribe':
        this.handleUnsubscribe(clientId, message.topic);
        break;

      case 'ping':
        this.sendToClient(clientId, {
          type: 'pong',
          data: { timestamp: Date.now() },
          timestamp: Date.now(),
        });
        break;

      case 'getStatus':
        this.sendJobStatus(clientId, message.jobId);
        break;

      default:
        console.warn(`Unknown message type from client ${clientId}:`, message.type);
        this.sendError(clientId, `Unknown message type: ${message.type}`);
    }
  }

  private handleSubscribe(clientId: string, topic: string): void {
    if (!topic) {
      this.sendError(clientId, 'Topic is required for subscription');
      return;
    }

    const client = this.clients.get(clientId);
    if (!client) return;

    // Add client to subscription
    client.subscriptions.add(topic);

    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, new Set());
    }
    this.subscriptions.get(topic)!.add(clientId);

    console.log(`📡 Client ${clientId} subscribed to: ${topic}`);

    this.sendToClient(clientId, {
      type: 'subscribed',
      data: {
        topic,
        message: `Subscribed to ${topic}`,
      },
      timestamp: Date.now(),
    });

    // Send initial data if available
    this.sendInitialTopicData(clientId, topic);
  }

  private handleUnsubscribe(clientId: string, topic: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.subscriptions.delete(topic);

    const topicSubscribers = this.subscriptions.get(topic);
    if (topicSubscribers) {
      topicSubscribers.delete(clientId);
      if (topicSubscribers.size === 0) {
        this.subscriptions.delete(topic);
      }
    }

    console.log(`📡 Client ${clientId} unsubscribed from: ${topic}`);

    this.sendToClient(clientId, {
      type: 'unsubscribed',
      data: {
        topic,
        message: `Unsubscribed from ${topic}`,
      },
      timestamp: Date.now(),
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
    console.log(`🔌 Client disconnected: ${clientId} (connected for ${Math.round(duration / 1000)}s)`);

    this.emit('clientDisconnected', clientId, client);
  }

  // Public methods for broadcasting updates
  broadcast(message: WebSocketMessage): void {
    this.clients.forEach((client, clientId) => {
      this.sendToClient(clientId, message);
    });
  }

  broadcastToTopic(topic: string, message: WebSocketMessage): void {
    const subscribers = this.subscriptions.get(topic);
    if (!subscribers) return;

    subscribers.forEach(clientId => {
      this.sendToClient(clientId, message);
    });
  }

  sendJobUpdate(jobId: string, update: any): void {
    const message: WebSocketMessage = {
      type: 'jobUpdate',
      id: jobId,
      data: update,
      timestamp: Date.now(),
    };

    // Send to job-specific subscribers
    this.broadcastToTopic(`job:${jobId}`, message);
    // Send to global job updates subscribers
    this.broadcastToTopic('jobs', message);
  }

  sendScrapingProgress(jobId: string, progress: any): void {
    const message: WebSocketMessage = {
      type: 'scrapingProgress',
      id: jobId,
      data: progress,
      timestamp: Date.now(),
    };

    this.broadcastToTopic(`job:${jobId}`, message);
    this.broadcastToTopic('progress', message);
  }

  sendSystemStatus(status: any): void {
    const message: WebSocketMessage = {
      type: 'systemStatus',
      data: status,
      timestamp: Date.now(),
    };

    this.broadcastToTopic('system', message);
  }

  private sendToClient(clientId: string, message: WebSocketMessage): void {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      client.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error(`Failed to send message to client ${clientId}:`, error);
      this.handleClientDisconnect(clientId);
    }
  }

  private sendError(clientId: string, error: string): void {
    this.sendToClient(clientId, {
      type: 'error',
      data: { error },
      timestamp: Date.now(),
    });
  }

  private async sendJobStatus(clientId: string, jobId: string): Promise<void> {
    try {
      // This would fetch current job status from database
      // For now, send a placeholder response
      this.sendToClient(clientId, {
        type: 'jobStatus',
        id: jobId,
        data: {
          jobId,
          status: 'PROCESSING',
          message: 'Job status would be fetched from database',
        },
        timestamp: Date.now(),
      });
    } catch (error) {
      this.sendError(clientId, `Failed to get job status: ${error}`);
    }
  }

  private async sendInitialTopicData(clientId: string, topic: string): Promise<void> {
    // Send relevant initial data based on topic
    if (topic.startsWith('job:')) {
      const jobId = topic.substring(4);
      await this.sendJobStatus(clientId, jobId);
    } else if (topic === 'system') {
      this.sendSystemStatus(await this.getSystemStatus());
    }
  }

  private async getSystemStatus(): Promise<any> {
    return {
      connectedClients: this.clients.size,
      activeTopics: this.subscriptions.size,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    };
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now();
      const staleThreshold = 60000; // 60 seconds

      this.clients.forEach((client, clientId) => {
        if (now - client.lastPing > staleThreshold) {
          console.warn(`Stale client detected: ${clientId}, disconnecting...`);
          client.ws.close();
          return;
        }

        // Send ping
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        }
      });
    }, 30000); // Every 30 seconds
  }

  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
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

  getClientInfo(clientId: string): ClientConnection | undefined {
    return this.clients.get(clientId);
  }

  getAllClients(): ClientConnection[] {
    return Array.from(this.clients.values());
  }
}

// Global WebSocket manager instance
export const wsManager = new WebSocketManager(parseInt(process.env.WS_PORT || '8080'));