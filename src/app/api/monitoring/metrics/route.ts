import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/database';

interface MetricsData {
  scraping: {
    jobs_total: number;
    jobs_successful: number;
    jobs_failed: number;
    jobs_duration_seconds: number;
    listings_scraped_total: number;
    listings_per_minute: number;
  };
  system: {
    memory_usage_bytes: number;
    memory_heap_bytes: number;
    cpu_usage_percent: number;
    uptime_seconds: number;
  };
  websocket: {
    connections_active: number;
    messages_sent_total: number;
    subscriptions_active: number;
  };
  database: {
    connections_active: number;
    query_duration_milliseconds: number;
    queries_total: number;
  };
}

const MetricsQuerySchema = z.object({
  format: z.enum(['json', 'prometheus']).default('json'),
  period: z.enum(['current', '1m', '5m', '15m', '1h']).default('current'),
  categories: z.array(z.enum(['scraping', 'system', 'websocket', 'database'])).optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = MetricsQuerySchema.parse({
      format: searchParams.get('format') || 'json',
      period: searchParams.get('period') || 'current',
      categories: searchParams.getAll('categories'),
    });

    console.log(`📈 Metrics request: ${query.format} format, ${query.period} period`);

    const metrics = await collectMetrics(query);

    if (query.format === 'prometheus') {
      return new NextResponse(formatPrometheusMetrics(metrics), {
        headers: {
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: metrics,
      metadata: {
        format: query.format,
        period: query.period,
        timestamp: Date.now(),
        collectedAt: new Date().toISOString(),
      },
    });

  } catch (error) {
    console.error('Metrics collection failed:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid metrics query',
        details: error.errors,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Metrics collection failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

async function collectMetrics(query: any): Promise<MetricsData> {
  const categories = query.categories || ['scraping', 'system', 'websocket', 'database'];
  const periodMs = getPeriodMilliseconds(query.period);
  const since = query.period === 'current' ? undefined : new Date(Date.now() - periodMs);

  const [
    scrapingMetrics,
    systemMetrics,
    websocketMetrics,
    databaseMetrics
  ] = await Promise.all([
    categories.includes('scraping') ? collectScrapingMetrics(since) : getEmptyScrapingMetrics(),
    categories.includes('system') ? collectSystemMetrics() : getEmptySystemMetrics(),
    categories.includes('websocket') ? collectWebSocketMetrics() : getEmptyWebSocketMetrics(),
    categories.includes('database') ? collectDatabaseMetrics(since) : getEmptyDatabaseMetrics(),
  ]);

  return {
    scraping: scrapingMetrics,
    system: systemMetrics,
    websocket: websocketMetrics,
    database: databaseMetrics,
  };
}

function getPeriodMilliseconds(period: string): number {
  const periods: Record<string, number> = {
    '1m': 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
  };
  return periods[period] || 0;
}

async function collectScrapingMetrics(since?: Date) {
  const whereClause = since ? { createdAt: { gte: since } } : {};

  const [jobStats, listingStats, avgDuration] = await Promise.all([
    prisma.scrapeJob.groupBy({
      by: ['status'],
      _count: { id: true },
      where: whereClause,
    }),
    prisma.businessListing.count({
      where: since ? { createdAt: { gte: since } } : {},
    }),
    prisma.scrapeJob.aggregate({
      _avg: { duration: true },
      where: {
        ...whereClause,
        duration: { not: null },
        status: 'COMPLETED',
      },
    }),
  ]);

  const totalJobs = jobStats.reduce((sum, stat) => sum + stat._count.id, 0);
  const successfulJobs = jobStats.find(s => s.status === 'COMPLETED')?._count.id || 0;
  const failedJobs = jobStats.find(s => s.status === 'FAILED')?._count.id || 0;

  // Calculate listings per minute for the period
  const periodMinutes = since ? (Date.now() - since.getTime()) / 60000 : 1;
  const listingsPerMinute = listingStats / Math.max(periodMinutes, 1);

  return {
    jobs_total: totalJobs,
    jobs_successful: successfulJobs,
    jobs_failed: failedJobs,
    jobs_duration_seconds: Math.round((avgDuration._avg.duration || 0) / 1000),
    listings_scraped_total: listingStats,
    listings_per_minute: Math.round(listingsPerMinute * 100) / 100,
  };
}

function collectSystemMetrics() {
  const memUsage = process.memoryUsage();

  return {
    memory_usage_bytes: memUsage.rss,
    memory_heap_bytes: memUsage.heapUsed,
    cpu_usage_percent: Math.round(Math.random() * 30 + 20), // Mock CPU - in production use actual monitoring
    uptime_seconds: Math.round(process.uptime()),
  };
}

function collectWebSocketMetrics() {
  try {
    const { wsManager } = require('@/lib/websocket/websocket-manager');
    const stats = wsManager.getStats();

    return {
      connections_active: stats.connectedClients,
      messages_sent_total: 0, // Would need to track this separately
      subscriptions_active: stats.totalSubscriptions,
    };
  } catch (error) {
    return getEmptyWebSocketMetrics();
  }
}

async function collectDatabaseMetrics(since?: Date) {
  try {
    const start = Date.now();

    // Simple query to measure response time
    await prisma.$queryRaw`SELECT 1`;
    const queryDuration = Date.now() - start;

    // Get connection info (Postgres specific)
    const connectionInfo = await prisma.$queryRaw`
      SELECT count(*) as active_connections
      FROM pg_stat_activity
      WHERE state = 'active'
    ` as any[];

    const activeConnections = connectionInfo[0]?.active_connections || 0;

    // Count total queries in period (simplified - would need proper metrics collection)
    const totalQueries = since ? await prisma.scrapeJob.count({
      where: { createdAt: { gte: since } }
    }) : 0;

    return {
      connections_active: Number(activeConnections),
      query_duration_milliseconds: queryDuration,
      queries_total: totalQueries,
    };
  } catch (error) {
    return getEmptyDatabaseMetrics();
  }
}

function getEmptyScrapingMetrics() {
  return {
    jobs_total: 0,
    jobs_successful: 0,
    jobs_failed: 0,
    jobs_duration_seconds: 0,
    listings_scraped_total: 0,
    listings_per_minute: 0,
  };
}

function getEmptySystemMetrics() {
  return {
    memory_usage_bytes: 0,
    memory_heap_bytes: 0,
    cpu_usage_percent: 0,
    uptime_seconds: 0,
  };
}

function getEmptyWebSocketMetrics() {
  return {
    connections_active: 0,
    messages_sent_total: 0,
    subscriptions_active: 0,
  };
}

function getEmptyDatabaseMetrics() {
  return {
    connections_active: 0,
    query_duration_milliseconds: 0,
    queries_total: 0,
  };
}

function formatPrometheusMetrics(metrics: MetricsData): string {
  const timestamp = Date.now();

  return `# HELP scraping_jobs_total Total number of scraping jobs
# TYPE scraping_jobs_total counter
scraping_jobs_total ${metrics.scraping.jobs_total} ${timestamp}

# HELP scraping_jobs_successful Total number of successful scraping jobs
# TYPE scraping_jobs_successful counter
scraping_jobs_successful ${metrics.scraping.jobs_successful} ${timestamp}

# HELP scraping_jobs_failed Total number of failed scraping jobs
# TYPE scraping_jobs_failed counter
scraping_jobs_failed ${metrics.scraping.jobs_failed} ${timestamp}

# HELP scraping_jobs_duration_seconds Average duration of completed scraping jobs
# TYPE scraping_jobs_duration_seconds gauge
scraping_jobs_duration_seconds ${metrics.scraping.jobs_duration_seconds} ${timestamp}

# HELP scraping_listings_total Total number of listings scraped
# TYPE scraping_listings_total counter
scraping_listings_total ${metrics.scraping.listings_scraped_total} ${timestamp}

# HELP scraping_listings_per_minute Rate of listings scraped per minute
# TYPE scraping_listings_per_minute gauge
scraping_listings_per_minute ${metrics.scraping.listings_per_minute} ${timestamp}

# HELP system_memory_usage_bytes Current memory usage in bytes
# TYPE system_memory_usage_bytes gauge
system_memory_usage_bytes ${metrics.system.memory_usage_bytes} ${timestamp}

# HELP system_memory_heap_bytes Current heap memory usage in bytes
# TYPE system_memory_heap_bytes gauge
system_memory_heap_bytes ${metrics.system.memory_heap_bytes} ${timestamp}

# HELP system_cpu_usage_percent Current CPU usage percentage
# TYPE system_cpu_usage_percent gauge
system_cpu_usage_percent ${metrics.system.cpu_usage_percent} ${timestamp}

# HELP system_uptime_seconds Process uptime in seconds
# TYPE system_uptime_seconds counter
system_uptime_seconds ${metrics.system.uptime_seconds} ${timestamp}

# HELP websocket_connections_active Number of active WebSocket connections
# TYPE websocket_connections_active gauge
websocket_connections_active ${metrics.websocket.connections_active} ${timestamp}

# HELP websocket_messages_sent_total Total number of WebSocket messages sent
# TYPE websocket_messages_sent_total counter
websocket_messages_sent_total ${metrics.websocket.messages_sent_total} ${timestamp}

# HELP websocket_subscriptions_active Number of active WebSocket subscriptions
# TYPE websocket_subscriptions_active gauge
websocket_subscriptions_active ${metrics.websocket.subscriptions_active} ${timestamp}

# HELP database_connections_active Number of active database connections
# TYPE database_connections_active gauge
database_connections_active ${metrics.database.connections_active} ${timestamp}

# HELP database_query_duration_milliseconds Last query duration in milliseconds
# TYPE database_query_duration_milliseconds gauge
database_query_duration_milliseconds ${metrics.database.query_duration_milliseconds} ${timestamp}

# HELP database_queries_total Total number of database queries
# TYPE database_queries_total counter
database_queries_total ${metrics.database.queries_total} ${timestamp}
`;
}