import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/database';
import { scrapeQueue } from '@/lib/queue/scrape-queue';
import { FilterValidator } from '@/lib/scraper/filters/filter-validator';
import { Scraper } from '@/lib/scraper/core/scraper';
import { ScrapeFilters } from '@/types';

const CreateJobSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  filters: z.record(z.any()),
  priority: z.number().min(1).max(10).default(5),
  config: z.object({
    maxPages: z.number().min(1).max(100).optional(),
    maxResults: z.number().min(1).max(10000).optional(),
    detailScraping: z.boolean().default(false),
    webhookUrl: z.string().url().optional(),
  }).optional(),
  scheduledFor: z.string().datetime().optional(),
  tags: z.array(z.string()).optional(),
});

const JobsQuerySchema = z.object({
  page: z.string().transform(val => parseInt(val) || 1),
  limit: z.string().transform(val => Math.min(parseInt(val) || 20, 100)),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
  sortBy: z.enum(['createdAt', 'startedAt', 'completedAt', 'resultCount']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
  tags: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = CreateJobSchema.parse(body);

    // Validate and sanitize filters
    const validatedFilters = FilterValidator.validate(validatedData.filters);
    const validation = FilterValidator.validateForScraping(validatedFilters);

    if (!validation.isValid) {
      return NextResponse.json({
        success: false,
        error: 'Filter validation failed',
        details: validation.errors,
        warnings: validation.warnings,
      }, { status: 400 });
    }

    // Get time estimate for the job
    const scraper = new Scraper();
    const estimate = await scraper.estimateScrapeTime({ filters: validatedFilters });

    // Create job in database
    const scrapeJob = await prisma.scrapeJob.create({
      data: {
        filters: validatedFilters,
        status: validatedData.scheduledFor ? 'PENDING' : 'PENDING',
        // Store additional metadata
      },
    });

    // Add to queue if not scheduled
    if (!validatedData.scheduledFor) {
      const jobOptions = {
        priority: validatedData.priority,
        jobId: scrapeJob.id,
        delay: 0,
        attempts: 3,
        backoff: {
          type: 'exponential' as const,
          delay: 5000,
        },
      };

      await scrapeQueue.add('scrape-listings', {
        id: scrapeJob.id,
        filters: validatedFilters,
        priority: validatedData.priority,
        config: validatedData.config,
        webhookUrl: validatedData.config?.webhookUrl,
      }, jobOptions);
    }

    return NextResponse.json({
      success: true,
      job: {
        id: scrapeJob.id,
        status: scrapeJob.status,
        filters: scrapeJob.filters,
        createdAt: scrapeJob.createdAt,
        estimate: {
          estimatedPages: estimate.estimatedPages,
          estimatedResults: estimate.estimatedResults,
          estimatedDuration: estimate.estimatedDuration,
        },
        validation: {
          warnings: validation.warnings,
        },
      },
      message: validatedData.scheduledFor
        ? 'Job scheduled successfully'
        : 'Job created and queued successfully',
    });

  } catch (error) {
    console.error('Error creating scrape job:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid request data',
        details: error.errors,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to create scrape job',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const queryParams = Object.fromEntries(searchParams.entries());
    const { page, limit, status, sortBy, sortOrder, search, tags } = JobsQuerySchema.parse(queryParams);

    // Build where clause
    const where: any = {};

    if (status) {
      where.status = status;
    }

    if (search) {
      // Search in job metadata or filters
      where.OR = [
        {
          filters: {
            path: ['location', 'states'],
            array_contains: search,
          },
        },
        {
          filters: {
            path: ['industry'],
            array_contains: search,
          },
        },
      ];
    }

    // Execute query
    const [jobs, totalCount] = await Promise.all([
      prisma.scrapeJob.findMany({
        where,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          filters: true,
          status: true,
          resultCount: true,
          error: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.scrapeJob.count({ where }),
    ]);

    // Get queue statistics for active jobs
    const activeJobIds = jobs
      .filter(job => job.status === 'PENDING' || job.status === 'PROCESSING')
      .map(job => job.id);

    const queueStats = await Promise.all(
      activeJobIds.map(async (jobId) => {
        const queueJob = await scrapeQueue.getJob(jobId);
        return {
          jobId,
          queuePosition: queueJob?.opts.delay || 0,
          progress: queueJob?.progress() || 0,
          attempts: queueJob?.attemptsMade || 0,
        };
      })
    );

    // Enhance jobs with queue information
    const enhancedJobs = jobs.map(job => {
      const queueInfo = queueStats.find(qs => qs.jobId === job.id);
      return {
        ...job,
        queue: queueInfo || null,
        duration: job.startedAt && job.completedAt
          ? job.completedAt.getTime() - job.startedAt.getTime()
          : null,
      };
    });

    const totalPages = Math.ceil(totalCount / limit);

    return NextResponse.json({
      success: true,
      data: {
        jobs: enhancedJobs,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
        summary: await getJobsSummary(),
      },
    });

  } catch (error) {
    console.error('Error fetching jobs:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid query parameters',
        details: error.errors,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to fetch jobs',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

async function getJobsSummary() {
  const [statusCounts, recentActivity] = await Promise.all([
    prisma.scrapeJob.groupBy({
      by: ['status'],
      _count: {
        status: true,
      },
    }),
    prisma.scrapeJob.aggregate({
      where: {
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
        },
      },
      _count: true,
      _sum: {
        resultCount: true,
      },
    }),
  ]);

  const statusSummary = statusCounts.reduce((acc, item) => {
    acc[item.status] = item._count.status;
    return acc;
  }, {} as Record<string, number>);

  return {
    statusCounts: statusSummary,
    last24Hours: {
      totalJobs: recentActivity._count,
      totalListings: recentActivity._sum.resultCount || 0,
    },
  };
}