import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/database';
import { wsManager } from '@/lib/websocket/websocket-manager';

interface DashboardData {
  overview: {
    activeJobs: number;
    queuedJobs: number;
    completedJobsToday: number;
    failedJobsToday: number;
    totalListingsToday: number;
    systemStatus: 'healthy' | 'degraded' | 'unhealthy';
  };
  realTimeMetrics: {
    connectedClients: number;
    activeTopics: number;
    memoryUsage: number;
    cpuUsage: number;
    requestsPerMinute: number;
  };
  recentJobs: JobSummary[];
  alerts: Alert[];
  quickStats: {
    topIndustries: IndustryStat[];
    topStates: StateStat[];
    recentErrors: ErrorStat[];
  };
}

interface JobSummary {
  id: string;
  status: string;
  progress: number;
  listingsFound: number;
  duration: number;
  createdAt: string;
  error?: string;
}

interface Alert {
  id: string;
  type: 'error' | 'warning' | 'info';
  title: string;
  message: string;
  timestamp: string;
  acknowledged: boolean;
}

interface IndustryStat {
  name: string;
  count: number;
  trend: 'up' | 'down' | 'stable';
}

interface StateStat {
  name: string;
  count: number;
  trend: 'up' | 'down' | 'stable';
}

interface ErrorStat {
  error: string;
  count: number;
  lastOccurrence: string;
}

const DashboardQuerySchema = z.object({
  refresh: z.boolean().default(false),
  includeAlerts: z.boolean().default(true),
  jobLimit: z.number().min(1).max(50).default(10),
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = DashboardQuerySchema.parse({
      refresh: searchParams.get('refresh') === 'true',
      includeAlerts: searchParams.get('includeAlerts') !== 'false',
      jobLimit: parseInt(searchParams.get('jobLimit') || '10'),
    });

    console.log('📊 Dashboard data request');

    const dashboardData = await generateDashboardData(query);

    return NextResponse.json({
      success: true,
      data: dashboardData,
      metadata: {
        generatedAt: new Date().toISOString(),
        refreshed: query.refresh,
      },
    });

  } catch (error) {
    console.error('Dashboard data generation failed:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid dashboard query',
        details: error.errors,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Dashboard data generation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

async function generateDashboardData(query: any): Promise<DashboardData> {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [
    overview,
    realTimeMetrics,
    recentJobs,
    alerts,
    quickStats
  ] = await Promise.all([
    generateOverview(todayStart),
    generateRealTimeMetrics(),
    getRecentJobs(query.jobLimit),
    query.includeAlerts ? generateAlerts() : [],
    generateQuickStats(todayStart),
  ]);

  return {
    overview,
    realTimeMetrics,
    recentJobs,
    alerts,
    quickStats,
  };
}

async function generateOverview(todayStart: Date) {
  const [jobCounts, todayListings] = await Promise.all([
    prisma.scrapeJob.groupBy({
      by: ['status'],
      _count: { id: true },
      where: {
        OR: [
          { status: { in: ['PENDING', 'PROCESSING'] } }, // Active jobs
          { createdAt: { gte: todayStart } } // Today's jobs
        ],
      },
    }),
    prisma.businessListing.count({
      where: {
        createdAt: { gte: todayStart },
      },
    }),
  ]);

  const activeJobs = jobCounts
    .filter(j => ['PROCESSING'].includes(j.status))
    .reduce((sum, j) => sum + j._count.id, 0);

  const queuedJobs = jobCounts
    .filter(j => ['PENDING'].includes(j.status))
    .reduce((sum, j) => sum + j._count.id, 0);

  const todayJobs = jobCounts
    .filter(j => j.status !== 'PENDING' && j.status !== 'PROCESSING');

  const completedJobsToday = todayJobs
    .filter(j => j.status === 'COMPLETED')
    .reduce((sum, j) => sum + j._count.id, 0);

  const failedJobsToday = todayJobs
    .filter(j => j.status === 'FAILED')
    .reduce((sum, j) => sum + j._count.id, 0);

  // Determine system status based on metrics
  const systemStatus = failedJobsToday > completedJobsToday ? 'degraded' :
                      activeJobs > 10 ? 'degraded' : 'healthy';

  return {
    activeJobs,
    queuedJobs,
    completedJobsToday,
    failedJobsToday,
    totalListingsToday: todayListings,
    systemStatus,
  };
}

async function generateRealTimeMetrics() {
  const wsStats = wsManager.getStats();
  const memUsage = process.memoryUsage();
  const totalMem = memUsage.heapTotal;
  const usedMem = memUsage.heapUsed;

  // Calculate requests per minute (approximate based on recent job activity)
  const recentActivity = await prisma.scrapeJob.count({
    where: {
      createdAt: {
        gte: new Date(Date.now() - 60000), // Last minute
      },
    },
  });

  return {
    connectedClients: wsStats.connectedClients,
    activeTopics: Object.keys(wsStats.topicBreakdown).length,
    memoryUsage: Math.round((usedMem / totalMem) * 100),
    cpuUsage: Math.round(Math.random() * 30 + 20), // Mock CPU usage
    requestsPerMinute: recentActivity * 60, // Extrapolate from last minute
  };
}

async function getRecentJobs(limit: number): Promise<JobSummary[]> {
  const jobs = await prisma.scrapeJob.findMany({
    take: limit,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      progress: true,
      listingsFound: true,
      duration: true,
      createdAt: true,
      error: true,
    },
  });

  return jobs.map(job => ({
    id: job.id,
    status: job.status,
    progress: job.progress || 0,
    listingsFound: job.listingsFound || 0,
    duration: job.duration || 0,
    createdAt: job.createdAt.toISOString(),
    error: job.error || undefined,
  }));
}

async function generateAlerts(): Promise<Alert[]> {
  const alerts: Alert[] = [];

  // Check for recent failures
  const recentFailures = await prisma.scrapeJob.count({
    where: {
      status: 'FAILED',
      createdAt: {
        gte: new Date(Date.now() - 60000), // Last minute
      },
    },
  });

  if (recentFailures > 2) {
    alerts.push({
      id: `alert_failures_${Date.now()}`,
      type: 'error',
      title: 'High Failure Rate',
      message: `${recentFailures} jobs failed in the last minute`,
      timestamp: new Date().toISOString(),
      acknowledged: false,
    });
  }

  // Check for stalled jobs
  const stalledJobs = await prisma.scrapeJob.count({
    where: {
      status: 'PROCESSING',
      updatedAt: {
        lt: new Date(Date.now() - 10 * 60000), // 10 minutes ago
      },
    },
  });

  if (stalledJobs > 0) {
    alerts.push({
      id: `alert_stalled_${Date.now()}`,
      type: 'warning',
      title: 'Stalled Jobs Detected',
      message: `${stalledJobs} jobs appear to be stalled (no updates in 10+ minutes)`,
      timestamp: new Date().toISOString(),
      acknowledged: false,
    });
  }

  // Check memory usage
  const memUsage = process.memoryUsage();
  const memPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

  if (memPercent > 85) {
    alerts.push({
      id: `alert_memory_${Date.now()}`,
      type: 'warning',
      title: 'High Memory Usage',
      message: `Memory usage is at ${Math.round(memPercent)}%`,
      timestamp: new Date().toISOString(),
      acknowledged: false,
    });
  }

  // Check WebSocket connections
  const wsStats = wsManager.getStats();
  if (wsStats.connectedClients > 100) {
    alerts.push({
      id: `alert_connections_${Date.now()}`,
      type: 'info',
      title: 'High WebSocket Activity',
      message: `${wsStats.connectedClients} clients connected`,
      timestamp: new Date().toISOString(),
      acknowledged: false,
    });
  }

  return alerts;
}

async function generateQuickStats(todayStart: Date) {
  // Top industries today
  const industryStats = await prisma.$queryRaw`
    SELECT
      industry,
      COUNT(*) as count
    FROM "BusinessListing"
    WHERE created_at >= ${todayStart}
    AND industry IS NOT NULL
    GROUP BY industry
    ORDER BY count DESC
    LIMIT 5
  ` as any[];

  const topIndustries: IndustryStat[] = industryStats.map((stat: any) => ({
    name: stat.industry,
    count: Number(stat.count),
    trend: 'stable' as const, // In production, compare with previous period
  }));

  // Top states today
  const stateStats = await prisma.$queryRaw`
    SELECT
      state,
      COUNT(*) as count
    FROM "BusinessListing"
    WHERE created_at >= ${todayStart}
    AND state IS NOT NULL
    GROUP BY state
    ORDER BY count DESC
    LIMIT 5
  ` as any[];

  const topStates: StateStat[] = stateStats.map((stat: any) => ({
    name: stat.state,
    count: Number(stat.count),
    trend: 'stable' as const,
  }));

  // Recent errors
  const errorStats = await prisma.$queryRaw`
    SELECT
      error,
      COUNT(*) as count,
      MAX(updated_at) as last_occurrence
    FROM "ScrapeJob"
    WHERE status = 'FAILED'
    AND created_at >= ${new Date(Date.now() - 24 * 60 * 60 * 1000)} -- Last 24 hours
    AND error IS NOT NULL
    GROUP BY error
    ORDER BY count DESC
    LIMIT 5
  ` as any[];

  const recentErrors: ErrorStat[] = errorStats.map((stat: any) => ({
    error: stat.error,
    count: Number(stat.count),
    lastOccurrence: new Date(stat.last_occurrence).toISOString(),
  }));

  return {
    topIndustries,
    topStates,
    recentErrors,
  };
}