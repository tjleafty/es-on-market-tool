import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/database';

interface ScrapingAnalytics {
  summary: {
    totalJobs: number;
    successfulJobs: number;
    failedJobs: number;
    totalListings: number;
    averageJobDuration: number;
    successRate: number;
  };
  trends: {
    jobsOverTime: TimeSeriesData[];
    listingsOverTime: TimeSeriesData[];
    errorRateOverTime: TimeSeriesData[];
    performanceOverTime: TimeSeriesData[];
  };
  breakdown: {
    jobsByStatus: StatusBreakdown[];
    jobsByIndustry: IndustryBreakdown[];
    jobsByState: StateBreakdown[];
    errorsByType: ErrorBreakdown[];
  };
  performance: {
    averageListingsPerJob: number;
    averageJobDuration: number;
    peakConcurrency: number;
    resourceUtilization: ResourceUtilization;
  };
}

interface TimeSeriesData {
  timestamp: string;
  value: number;
  label?: string;
}

interface StatusBreakdown {
  status: string;
  count: number;
  percentage: number;
}

interface IndustryBreakdown {
  industry: string;
  listingCount: number;
  jobCount: number;
  averagePrice: number;
}

interface StateBreakdown {
  state: string;
  listingCount: number;
  jobCount: number;
  averagePrice: number;
}

interface ErrorBreakdown {
  errorType: string;
  count: number;
  percentage: number;
  lastOccurrence: string;
}

interface ResourceUtilization {
  memoryPeak: number;
  memoryAverage: number;
  cpuPeak: number;
  cpuAverage: number;
}

const AnalyticsQuerySchema = z.object({
  period: z.enum(['1h', '6h', '24h', '7d', '30d']).default('24h'),
  granularity: z.enum(['minute', 'hour', 'day']).default('hour'),
  includeBreakdowns: z.boolean().default(true),
  includeTrends: z.boolean().default(true),
  industries: z.array(z.string()).optional(),
  states: z.array(z.string()).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = AnalyticsQuerySchema.parse({
      period: searchParams.get('period') || '24h',
      granularity: searchParams.get('granularity') || 'hour',
      includeBreakdowns: searchParams.get('includeBreakdowns') !== 'false',
      includeTrends: searchParams.get('includeTrends') !== 'false',
      industries: searchParams.getAll('industries'),
      states: searchParams.getAll('states'),
      dateFrom: searchParams.get('dateFrom'),
      dateTo: searchParams.get('dateTo'),
    });

    console.log(`📊 Analytics request: ${query.period} period with ${query.granularity} granularity`);

    const { dateFrom, dateTo } = getDateRange(query);
    const analytics = await generateAnalytics(dateFrom, dateTo, query);

    return NextResponse.json({
      success: true,
      data: analytics,
      metadata: {
        period: query.period,
        granularity: query.granularity,
        dateRange: { from: dateFrom.toISOString(), to: dateTo.toISOString() },
        generatedAt: new Date().toISOString(),
      },
    });

  } catch (error) {
    console.error('Analytics generation failed:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid analytics query',
        details: error.issues,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Analytics generation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

function getDateRange(query: any): { dateFrom: Date; dateTo: Date } {
  if (query.dateFrom && query.dateTo) {
    return {
      dateFrom: new Date(query.dateFrom),
      dateTo: new Date(query.dateTo),
    };
  }

  const now = new Date();
  const periodHours: Record<string, number> = {
    '1h': 1,
    '6h': 6,
    '24h': 24,
    '7d': 168,
    '30d': 720,
  };
  const selectedHours = periodHours[query.period] || 24;

  return {
    dateFrom: new Date(now.getTime() - selectedHours * 60 * 60 * 1000),
    dateTo: now,
  };
}

async function generateAnalytics(dateFrom: Date, dateTo: Date, query: any): Promise<ScrapingAnalytics> {
  const [
    summary,
    trends,
    breakdown,
    performance
  ] = await Promise.all([
    generateSummary(dateFrom, dateTo),
    query.includeTrends ? generateTrends(dateFrom, dateTo, query.granularity) : null,
    query.includeBreakdowns ? generateBreakdowns(dateFrom, dateTo, query) : null,
    generatePerformanceMetrics(dateFrom, dateTo),
  ]);

  return {
    summary,
    trends: trends || {
      jobsOverTime: [],
      listingsOverTime: [],
      errorRateOverTime: [],
      performanceOverTime: [],
    },
    breakdown: breakdown || {
      jobsByStatus: [],
      jobsByIndustry: [],
      jobsByState: [],
      errorsByType: [],
    },
    performance,
  };
}

async function generateSummary(dateFrom: Date, dateTo: Date) {
  const [jobStats, listingStats] = await Promise.all([
    prisma.scrapeJob.groupBy({
      by: ['status'],
      _count: { id: true },
      _avg: { duration: true },
      where: {
        createdAt: { gte: dateFrom, lte: dateTo },
      },
    }),
    prisma.businessListing.count({
      where: {
        createdAt: { gte: dateFrom, lte: dateTo },
      },
    }),
  ]);

  const totalJobs = jobStats.reduce((sum: number, stat: any) => sum + stat._count.id, 0);
  const successfulJobs = jobStats.find((s: any) => s.status === 'COMPLETED')?._count.id || 0;
  const failedJobs = jobStats.find((s: any) => s.status === 'FAILED')?._count.id || 0;

  const averageDurations = jobStats
    .filter((s: any) => s._avg.duration !== null)
    .map((s: any) => s._avg.duration || 0);
  const averageJobDuration = averageDurations.length > 0
    ? averageDurations.reduce((sum: number, dur: number) => sum + dur, 0) / averageDurations.length
    : 0;

  return {
    totalJobs,
    successfulJobs,
    failedJobs,
    totalListings: listingStats,
    averageJobDuration: Math.round(averageJobDuration),
    successRate: totalJobs > 0 ? Math.round((successfulJobs / totalJobs) * 100) : 0,
  };
}

async function generateTrends(dateFrom: Date, dateTo: Date, granularity: string) {
  const timeFormat = granularity === 'minute' ? 'YYYY-MM-DD HH24:MI' :
                    granularity === 'hour' ? 'YYYY-MM-DD HH24' : 'YYYY-MM-DD';

  const interval = granularity === 'minute' ? '1 minute' :
                  granularity === 'hour' ? '1 hour' : '1 day';

  // Jobs over time
  const jobsTrend = await prisma.$queryRaw`
    SELECT
      to_char(date_trunc(${granularity}, created_at), ${timeFormat}) as timestamp,
      COUNT(*) as value
    FROM "ScrapeJob"
    WHERE created_at >= ${dateFrom} AND created_at <= ${dateTo}
    GROUP BY date_trunc(${granularity}, created_at)
    ORDER BY timestamp
  ` as TimeSeriesData[];

  // Listings over time
  const listingsTrend = await prisma.$queryRaw`
    SELECT
      to_char(date_trunc(${granularity}, created_at), ${timeFormat}) as timestamp,
      COUNT(*) as value
    FROM "BusinessListing"
    WHERE created_at >= ${dateFrom} AND created_at <= ${dateTo}
    GROUP BY date_trunc(${granularity}, created_at)
    ORDER BY timestamp
  ` as TimeSeriesData[];

  // Error rate over time
  const errorRateTrend = await prisma.$queryRaw`
    SELECT
      to_char(date_trunc(${granularity}, created_at), ${timeFormat}) as timestamp,
      ROUND(
        (COUNT(*) FILTER (WHERE status = 'FAILED')::decimal / NULLIF(COUNT(*), 0)) * 100,
        2
      ) as value
    FROM "ScrapeJob"
    WHERE created_at >= ${dateFrom} AND created_at <= ${dateTo}
    GROUP BY date_trunc(${granularity}, created_at)
    ORDER BY timestamp
  ` as TimeSeriesData[];

  // Performance over time (average duration)
  const performanceTrend = await prisma.$queryRaw`
    SELECT
      to_char(date_trunc(${granularity}, created_at), ${timeFormat}) as timestamp,
      ROUND(AVG(duration)) as value
    FROM "ScrapeJob"
    WHERE created_at >= ${dateFrom} AND created_at <= ${dateTo}
    AND duration IS NOT NULL
    GROUP BY date_trunc(${granularity}, created_at)
    ORDER BY timestamp
  ` as TimeSeriesData[];

  return {
    jobsOverTime: jobsTrend.map(d => ({ ...d, value: Number(d.value) })),
    listingsOverTime: listingsTrend.map(d => ({ ...d, value: Number(d.value) })),
    errorRateOverTime: errorRateTrend.map(d => ({ ...d, value: Number(d.value) })),
    performanceOverTime: performanceTrend.map(d => ({ ...d, value: Number(d.value) })),
  };
}

async function generateBreakdowns(dateFrom: Date, dateTo: Date, query: any) {
  // Jobs by status
  const jobsByStatus = await prisma.scrapeJob.groupBy({
    by: ['status'],
    _count: { id: true },
    where: {
      createdAt: { gte: dateFrom, lte: dateTo },
    },
  });

  const totalJobsForStatus = jobsByStatus.reduce((sum, stat) => sum + stat._count.id, 0);
  const statusBreakdown: StatusBreakdown[] = jobsByStatus.map(stat => ({
    status: stat.status,
    count: stat._count.id,
    percentage: Math.round((stat._count.id / totalJobsForStatus) * 100),
  }));

  // Jobs and listings by industry
  const industryStats = await prisma.$queryRaw`
    SELECT
      bl.industry,
      COUNT(DISTINCT bl.id) as listing_count,
      COUNT(DISTINCT sj.id) as job_count,
      ROUND(AVG(bl.asking_price)) as average_price
    FROM "BusinessListing" bl
    LEFT JOIN "ScrapeJob" sj ON sj.created_at >= ${dateFrom} AND sj.created_at <= ${dateTo}
    WHERE bl.created_at >= ${dateFrom} AND bl.created_at <= ${dateTo}
    AND bl.industry IS NOT NULL
    GROUP BY bl.industry
    ORDER BY listing_count DESC
    LIMIT 10
  ` as any[];

  const industryBreakdown: IndustryBreakdown[] = industryStats.map((stat: any) => ({
    industry: stat.industry,
    listingCount: Number(stat.listing_count),
    jobCount: Number(stat.job_count),
    averagePrice: Number(stat.average_price) || 0,
  }));

  // Jobs and listings by state
  const stateStats = await prisma.$queryRaw`
    SELECT
      bl.state,
      COUNT(DISTINCT bl.id) as listing_count,
      COUNT(DISTINCT sj.id) as job_count,
      ROUND(AVG(bl.asking_price)) as average_price
    FROM "BusinessListing" bl
    LEFT JOIN "ScrapeJob" sj ON sj.created_at >= ${dateFrom} AND sj.created_at <= ${dateTo}
    WHERE bl.created_at >= ${dateFrom} AND bl.created_at <= ${dateTo}
    AND bl.state IS NOT NULL
    GROUP BY bl.state
    ORDER BY listing_count DESC
    LIMIT 10
  ` as any[];

  const stateBreakdown: StateBreakdown[] = stateStats.map((stat: any) => ({
    state: stat.state,
    listingCount: Number(stat.listing_count),
    jobCount: Number(stat.job_count),
    averagePrice: Number(stat.average_price) || 0,
  }));

  // Error analysis (simplified - in production you'd have proper error categorization)
  const errorStats = await prisma.scrapeJob.groupBy({
    by: ['status', 'error'],
    _count: { id: true },
    _max: { updatedAt: true },
    where: {
      createdAt: { gte: dateFrom, lte: dateTo },
      status: 'FAILED',
    },
  });

  const totalErrors = errorStats.reduce((sum, stat) => sum + stat._count.id, 0);
  const errorBreakdown: ErrorBreakdown[] = errorStats.map(stat => ({
    errorType: stat.error || 'Unknown Error',
    count: stat._count.id,
    percentage: Math.round((stat._count.id / totalErrors) * 100),
    lastOccurrence: stat._max.updatedAt?.toISOString() || '',
  }));

  return {
    jobsByStatus: statusBreakdown,
    jobsByIndustry: industryBreakdown,
    jobsByState: stateBreakdown,
    errorsByType: errorBreakdown,
  };
}

async function generatePerformanceMetrics(dateFrom: Date, dateTo: Date): Promise<any> {
  const jobMetrics = await prisma.scrapeJob.aggregate({
    _avg: {
      duration: true,
      listingsFound: true,
    },
    _max: {
      duration: true,
      listingsFound: true,
    },
    where: {
      createdAt: { gte: dateFrom, lte: dateTo },
      status: 'COMPLETED',
    },
  });

  // Mock resource utilization data (in production, collect from actual monitoring)
  return {
    averageListingsPerJob: Math.round(jobMetrics._avg.listingsFound || 0),
    averageJobDuration: Math.round(jobMetrics._avg.duration || 0),
    peakConcurrency: 5, // Mock value
    resourceUtilization: {
      memoryPeak: 85.2,
      memoryAverage: 65.8,
      cpuPeak: 92.1,
      cpuAverage: 45.3,
    },
  };
}