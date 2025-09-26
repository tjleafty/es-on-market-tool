import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/database';
import { jobQueue } from '@/lib/jobs/database-queue';
import { FilterValidator } from '@/lib/scraper/filters/filter-validator';
import { withAuth } from '@/lib/auth/middleware';
import { PERMISSIONS } from '@/lib/auth/api-auth';

const CreateJobSchema = z.object({
  filters: z.record(z.string(), z.any()),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).default('NORMAL'),
  maxListings: z.number().min(1).max(10000).default(1000),
  enableWebhooks: z.boolean().default(false),
});

const JobsQuerySchema = z.object({
  page: z.string().transform(val => parseInt(val) || 1),
  limit: z.string().transform(val => Math.min(parseInt(val) || 20, 100)),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
  sortBy: z.enum(['createdAt', 'startedAt', 'completedAt', 'listingsFound']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
});

// POST /api/jobs - Create new scraping job
export const POST = withAuth(async (request: NextRequest, authContext) => {
  if (!authContext) {
    return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 });
  }

  if (!authContext.permissions.has(PERMISSIONS.JOBS_CREATE)) {
    return NextResponse.json({ success: false, error: 'Insufficient permissions' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const validatedData = CreateJobSchema.parse(body);

    console.log(`🚀 Creating new scrape job with filters:`, validatedData.filters);

    // Validate filters
    const validatedFilters = FilterValidator.validatePartial(validatedData.filters);

    // Add job to queue (this will create the database record)
    const jobId = await jobQueue.addJob(validatedFilters, {
      priority: validatedData.priority,
      maxListings: validatedData.maxListings,
      enableWebhooks: validatedData.enableWebhooks,
    });

    // Get the created job
    const job = await prisma.scrapeJob.findUnique({
      where: { id: jobId },
    });

    return NextResponse.json({
      success: true,
      data: {
        id: job!.id,
        status: job!.status,
        filters: job!.filters,
        priority: job!.priority,
        maxListings: job!.maxListings,
        progress: job!.progress,
        createdAt: job!.createdAt,
      },
      message: 'Job created and queued successfully',
    }, { status: 201 });

  } catch (error) {
    console.error('Error creating scrape job:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid request data',
        details: error.issues,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to create scrape job',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}, {
  required: true,
  permissions: [PERMISSIONS.JOBS_CREATE],
});

// GET /api/jobs - List scraping jobs
export const GET = withAuth(async (request: NextRequest, authContext) => {
  if (!authContext) {
    return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 });
  }

  if (!authContext.permissions.has(PERMISSIONS.JOBS_READ)) {
    return NextResponse.json({ success: false, error: 'Insufficient permissions' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const queryParams = Object.fromEntries(searchParams.entries());
    const { page, limit, status, sortBy, sortOrder, search } = JobsQuerySchema.parse(queryParams);

    // Build where clause
    const where: any = {};

    if (status) {
      where.status = status;
    }

    if (search) {
      // Simple search in filters JSON
      where.OR = [
        {
          filters: {
            string_contains: search,
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
          progress: true,
          listingsFound: true,
          duration: true,
          priority: true,
          maxListings: true,
          enableWebhooks: true,
          error: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.scrapeJob.count({ where }),
    ]);

    const totalPages = Math.ceil(totalCount / limit);

    return NextResponse.json({
      success: true,
      data: {
        jobs,
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
        details: error.issues,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to fetch jobs',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}, {
  required: true,
  permissions: [PERMISSIONS.JOBS_READ],
});

async function getJobsSummary() {
  try {
    const [statusCounts, recentActivity, queueStats] = await Promise.all([
      prisma.scrapeJob.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
      prisma.scrapeJob.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
          },
        },
      }),
      jobQueue.getQueueStats(),
    ]);

    const statusSummary = statusCounts.reduce((acc: Record<string, number>, item: any) => {
      acc[item.status.toLowerCase()] = item._count.id;
      return acc;
    }, {} as Record<string, number>);

    return {
      statusCounts: statusSummary,
      recentActivity,
      queue: queueStats,
      totalJobs: statusCounts.reduce((sum: number, item: any) => sum + item._count.id, 0),
    };
  } catch (error) {
    console.error('Error getting jobs summary:', error);
    return {
      statusCounts: {},
      recentActivity: 0,
      queue: { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0, currentJobs: [] },
      totalJobs: 0,
    };
  }
}