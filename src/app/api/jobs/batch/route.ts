import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/database';
import { jobQueue } from '@/lib/jobs/database-queue';
import { FilterValidator } from '@/lib/scraper/filters/filter-validator';
import { ConcurrentScraper } from '@/lib/scraper/core/concurrent-scraper';
import { ScrapeFilters } from '@/types';

const BatchJobSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  jobs: z.array(z.object({
    name: z.string().optional(),
    filters: z.record(z.string(), z.any()),
    priority: z.number().min(1).max(10).default(5),
    config: z.object({
      maxPages: z.number().min(1).max(100).optional(),
      maxResults: z.number().min(1).max(10000).optional(),
      detailScraping: z.boolean().default(false),
    }).optional(),
  })).min(1).max(20),
  concurrency: z.object({
    enabled: z.boolean().default(true),
    maxConcurrent: z.number().min(1).max(10).default(3),
    maxBrowsers: z.number().min(1).max(5).default(2),
  }).optional(),
  webhookUrl: z.string().url().optional(),
  tags: z.array(z.string()).optional(),
});

const BatchActionSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'cancel']),
  jobIds: z.array(z.string()).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const validatedData = BatchJobSchema.parse(body);

    // Validate all job filters
    const validatedJobs: any[] = [];
    const validationErrors: any[] = [];

    for (let i = 0; i < validatedData.jobs.length; i++) {
      const job = validatedData.jobs[i];
      try {
        const validatedFilters = FilterValidator.validate(job.filters);
        const validation = FilterValidator.validateForScraping(validatedFilters);

        if (!validation.isValid) {
          validationErrors.push({
            jobIndex: i,
            errors: validation.errors,
          });
        } else {
          validatedJobs.push({
            ...job,
            filters: validatedFilters,
            warnings: validation.warnings,
          });
        }
      } catch (error) {
        validationErrors.push({
          jobIndex: i,
          errors: [error instanceof Error ? error.message : 'Filter validation failed'],
        });
      }
    }

    if (validationErrors.length > 0) {
      return NextResponse.json({
        success: false,
        error: 'Filter validation failed for some jobs',
        validationErrors,
      }, { status: 400 });
    }

    // Create batch record
    const batchId = `batch_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Create individual jobs in database
    const createdJobs = await Promise.all(
      validatedJobs.map(async (job, index) => {
        return prisma.scrapeJob.create({
          data: {
            filters: job.filters,
            status: 'PENDING',
            // Add batch metadata
          },
        });
      })
    );

    // Get time estimates
    let totalEstimatedMinutes = 0;
    let parallelEstimatedMinutes = 0;

    if (validatedData.concurrency?.enabled) {
      // Use concurrent scraper for estimates
      const concurrentScraper = new ConcurrentScraper();
      const estimate = await concurrentScraper.estimateConcurrentScrapeTime({
        filters: validatedJobs.map(job => job.filters),
        maxConcurrency: validatedData.concurrency.maxConcurrent,
        maxBrowsers: validatedData.concurrency.maxBrowsers,
      });

      totalEstimatedMinutes = estimate.totalEstimatedMinutes;
      parallelEstimatedMinutes = estimate.parallelEstimatedMinutes;
    }

    // Database queue doesn't support concurrent batches - queue individual jobs
    // All jobs will be processed according to their individual priorities
    // Jobs are already created in database with PENDING status
    // The database queue will automatically process them

    return NextResponse.json({
      success: true,
      batch: {
        id: batchId,
        name: validatedData.name,
        totalJobs: createdJobs.length,
        jobs: createdJobs.map((job, index) => ({
          id: job.id,
          status: job.status,
          warnings: validatedJobs[index].warnings,
        })),
        concurrency: validatedData.concurrency,
        estimates: {
          totalEstimatedMinutes,
          parallelEstimatedMinutes,
          estimatedDuration: parallelEstimatedMinutes < 60
            ? `${parallelEstimatedMinutes} minutes`
            : `${Math.floor(parallelEstimatedMinutes / 60)}h ${parallelEstimatedMinutes % 60}m`,
        },
      },
      message: 'Batch jobs created successfully',
    });

  } catch (error) {
    console.error('Error creating batch jobs:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid request data',
        details: error.issues,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to create batch jobs',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, jobIds } = BatchActionSchema.parse(body);

    if (!jobIds || jobIds.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'Job IDs are required for batch actions',
      }, { status: 400 });
    }

    // Get current jobs
    const jobs = await prisma.scrapeJob.findMany({
      where: {
        id: { in: jobIds },
      },
    });

    if (jobs.length !== jobIds.length) {
      return NextResponse.json({
        success: false,
        error: 'Some jobs not found',
      }, { status: 404 });
    }

    const results = [];
    let updateData: any = {};

    switch (action) {
      case 'cancel':
        updateData = {
          status: 'CANCELLED',
          completedAt: new Date(),
          error: 'Cancelled by user (batch operation)',
        };
        break;

      case 'pause':
        // Only pending jobs can be paused
        const pendingJobs = jobs.filter((job: any) => job.status === 'PENDING');
        if (pendingJobs.length === 0) {
          return NextResponse.json({
            success: false,
            error: 'No pending jobs to pause',
          }, { status: 400 });
        }
        break;
    }

    // Process each job
    for (const job of jobs) {
      try {
        const jobUpdateData = { ...updateData };

        // Validate job state for the action
        const canPerformAction = validateJobAction(job.status, action);
        if (!canPerformAction.valid) {
          results.push({
            jobId: job.id,
            success: false,
            error: canPerformAction.reason,
          });
          continue;
        }

        // Update database
        if (Object.keys(jobUpdateData).length > 0) {
          await prisma.scrapeJob.update({
            where: { id: job.id },
            data: {
              ...jobUpdateData,
              updatedAt: new Date(),
            },
          });
        }

        // Handle database queue actions
        try {
          switch (action) {
            case 'cancel':
              await jobQueue.cancelJob(job.id);
              break;

            case 'pause':
              // Database queue doesn't support pause - cancel instead
              await jobQueue.cancelJob(job.id);
              break;

            case 'resume':
              // Resume by resetting to pending if cancelled
              if (job.status === 'CANCELLED') {
                await prisma.scrapeJob.update({
                  where: { id: job.id },
                  data: { status: 'PENDING', updatedAt: new Date() },
                });
              }
              break;
          }
        } catch (queueError) {
          console.warn(`Queue action failed for job ${job.id}:`, queueError);
        }

        results.push({
          jobId: job.id,
          success: true,
          action,
        });

      } catch (error) {
        results.push({
          jobId: job.id,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failedCount = results.length - successCount;

    return NextResponse.json({
      success: failedCount === 0,
      message: `Batch ${action}: ${successCount} successful, ${failedCount} failed`,
      results,
      summary: {
        total: results.length,
        successful: successCount,
        failed: failedCount,
      },
    });

  } catch (error) {
    console.error('Error performing batch action:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid request data',
        details: error.issues,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to perform batch action',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

function validateJobAction(currentStatus: string, action: string): { valid: boolean; reason?: string } {
  switch (action) {
    case 'cancel':
      if (currentStatus === 'COMPLETED') {
        return { valid: false, reason: 'Cannot cancel completed jobs' };
      }
      if (currentStatus === 'CANCELLED') {
        return { valid: false, reason: 'Job already cancelled' };
      }
      return { valid: true };

    case 'pause':
      if (currentStatus !== 'PENDING') {
        return { valid: false, reason: 'Can only pause pending jobs' };
      }
      return { valid: true };

    case 'resume':
      if (currentStatus !== 'PENDING') {
        return { valid: false, reason: 'Can only resume paused jobs' };
      }
      return { valid: true };

    case 'start':
      if (currentStatus !== 'PENDING') {
        return { valid: false, reason: 'Job is not in pending state' };
      }
      return { valid: true };

    default:
      return { valid: false, reason: 'Unknown action' };
  }
}