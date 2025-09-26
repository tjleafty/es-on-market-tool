import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/database';
import { wsManager } from '@/lib/websocket/websocket-manager';
import os from 'os';

interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  uptime: number;
  version: string;
  services: {
    database: ServiceStatus;
    websocket: ServiceStatus;
    redis: ServiceStatus;
  };
  resources: {
    memory: MemoryInfo;
    cpu: CpuInfo;
    disk: DiskInfo;
  };
  performance: {
    responseTime: number;
    errorRate: number;
    requestsPerMinute: number;
  };
}

interface ServiceStatus {
  status: 'up' | 'down' | 'degraded';
  responseTime?: number;
  error?: string;
  metadata?: any;
}

interface MemoryInfo {
  used: number;
  total: number;
  percentage: number;
  heap: {
    used: number;
    total: number;
    limit: number;
  };
}

interface CpuInfo {
  usage: number;
  loadAverage: number[];
  cores: number;
}

interface DiskInfo {
  usage: number;
  free: number;
  total: number;
}

const MetricsQuerySchema = z.object({
  period: z.enum(['1h', '6h', '24h', '7d', '30d']).default('24h'),
  includeDetails: z.boolean().default(false),
  services: z.array(z.enum(['database', 'websocket', 'redis'])).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const params = MetricsQuerySchema.parse({
      period: searchParams.get('period') || '24h',
      includeDetails: searchParams.get('includeDetails') === 'true',
      services: searchParams.getAll('services'),
    });

    console.log(`🔍 System health check requested (period: ${params.period})`);

    const startTime = Date.now();
    const health = await getSystemHealth(params);
    const responseTime = Date.now() - startTime;

    // Add response time to performance metrics
    health.performance.responseTime = responseTime;

    // Determine overall health status
    const serviceStatuses = Object.values(health.services).map(s => s.status);
    const hasDown = serviceStatuses.includes('down');
    const hasDegraded = serviceStatuses.includes('degraded');

    if (hasDown) {
      health.status = 'unhealthy';
    } else if (hasDegraded || health.resources.memory.percentage > 85 || health.resources.cpu.usage > 90) {
      health.status = 'degraded';
    } else {
      health.status = 'healthy';
    }

    const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;

    return NextResponse.json({
      success: true,
      data: health,
    }, { status: statusCode });

  } catch (error) {
    console.error('System health check failed:', error);

    return NextResponse.json({
      success: false,
      error: 'Health check failed',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: Date.now(),
    }, { status: 500 });
  }
}

async function getSystemHealth(params: any): Promise<SystemHealth> {
  const [
    databaseStatus,
    websocketStatus,
    redisStatus,
    memoryInfo,
    cpuInfo,
    diskInfo,
    performanceMetrics
  ] = await Promise.all([
    checkDatabaseHealth(),
    checkWebSocketHealth(),
    checkRedisHealth(),
    getMemoryInfo(),
    getCpuInfo(),
    getDiskInfo(),
    getPerformanceMetrics(params.period),
  ]);

  return {
    status: 'healthy', // Will be overridden in main function
    timestamp: Date.now(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    services: {
      database: databaseStatus,
      websocket: websocketStatus,
      redis: redisStatus,
    },
    resources: {
      memory: memoryInfo,
      cpu: cpuInfo,
      disk: diskInfo,
    },
    performance: performanceMetrics,
  };
}

async function checkDatabaseHealth(): Promise<ServiceStatus> {
  try {
    const start = Date.now();
    const result = await prisma.$queryRaw`SELECT 1`;
    const responseTime = Date.now() - start;

    const stats = await prisma.$queryRaw`
      SELECT
        schemaname,
        tablename,
        n_tup_ins as inserts,
        n_tup_upd as updates,
        n_tup_del as deletes
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
    ` as any[];

    return {
      status: responseTime > 1000 ? 'degraded' : 'up',
      responseTime,
      metadata: {
        connected: true,
        tableStats: stats.slice(0, 5), // Limit for response size
      },
    };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : 'Database connection failed',
    };
  }
}

async function checkWebSocketHealth(): Promise<ServiceStatus> {
  try {
    const stats = wsManager.getStats();

    return {
      status: 'up',
      responseTime: 0,
      metadata: {
        connectedClients: stats.connectedClients,
        activeTopics: stats.totalSubscriptions,
        topicBreakdown: stats.topicBreakdown,
        averageConnectionTime: stats.averageConnectionTime,
      },
    };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : 'WebSocket service unavailable',
    };
  }
}

async function checkRedisHealth(): Promise<ServiceStatus> {
  try {
    // In a real implementation, you would check Redis connection here
    // For now, we'll assume it's working if the process is running
    return {
      status: 'up',
      responseTime: 0,
      metadata: {
        connected: true,
        // In real implementation: memory usage, connected clients, etc.
      },
    };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : 'Redis connection failed',
    };
  }
}

function getMemoryInfo(): MemoryInfo {
  const memUsage = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    used: usedMem,
    total: totalMem,
    percentage: Math.round((usedMem / totalMem) * 100),
    heap: {
      used: memUsage.heapUsed,
      total: memUsage.heapTotal,
      limit: memUsage.external,
    },
  };
}

function getCpuInfo(): CpuInfo {
  const cpus = os.cpus();
  const loadAvg = os.loadavg();

  // Calculate CPU usage (simplified - in production use a proper CPU monitoring library)
  let totalIdle = 0;
  let totalTick = 0;

  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      totalTick += cpu.times[type as keyof typeof cpu.times];
    }
    totalIdle += cpu.times.idle;
  });

  const idle = totalIdle / cpus.length;
  const total = totalTick / cpus.length;
  const usage = 100 - ~~(100 * idle / total);

  return {
    usage: Math.max(0, Math.min(100, usage)),
    loadAverage: loadAvg,
    cores: cpus.length,
  };
}

async function getDiskInfo(): Promise<DiskInfo> {
  try {
    // In a real implementation, use a library like 'node-disk-info' or 'statvfs'
    // For now, provide mock data
    return {
      usage: 45, // percentage
      free: 50 * 1024 * 1024 * 1024, // 50GB
      total: 100 * 1024 * 1024 * 1024, // 100GB
    };
  } catch (error) {
    return {
      usage: 0,
      free: 0,
      total: 0,
    };
  }
}

async function getPerformanceMetrics(period: string) {
  try {
    const periodHours = {
      '1h': 1,
      '6h': 6,
      '24h': 24,
      '7d': 168,
      '30d': 720,
    }[period] || 24;

    const since = new Date(Date.now() - periodHours * 60 * 60 * 1000);

    // Get job statistics for the period
    const jobStats = await prisma.scrapeJob.groupBy({
      by: ['status'],
      _count: {
        id: true,
      },
      where: {
        createdAt: {
          gte: since,
        },
      },
    });

    const totalJobs = jobStats.reduce((sum, stat) => sum + stat._count.id, 0);
    const failedJobs = jobStats.find(s => s.status === 'FAILED')?._count.id || 0;
    const errorRate = totalJobs > 0 ? (failedJobs / totalJobs) * 100 : 0;

    // Calculate requests per minute (approximate)
    const requestsPerMinute = Math.round(totalJobs / (periodHours * 60));

    return {
      responseTime: 0, // Will be set by caller
      errorRate: Math.round(errorRate * 100) / 100,
      requestsPerMinute,
    };
  } catch (error) {
    return {
      responseTime: 0,
      errorRate: 0,
      requestsPerMinute: 0,
    };
  }
}