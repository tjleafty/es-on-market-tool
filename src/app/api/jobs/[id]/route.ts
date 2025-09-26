import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/database';
import { scrapeQueue } from '@/lib/queue/scrape-queue';

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UpdateJobSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'retry']),
  priority: z.number().min(1).max(10).optional(),
  webhookUrl: z.string().url().optional(),
});

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json({
        success: false,
        error: 'Job ID is required',
      }, { status: 400 });
    }

    // Get job from database
    const scrapeJob = await prisma.scrapeJob.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            // Would count related records if we had them
          },
        },
      },
    });

    if (!scrapeJob) {
      return NextResponse.json({
        success: false,
        error: 'Job not found',
      }, { status: 404 });
    }

    // Get queue job information
    let queueInfo = null;
    try {
      const queueJob = await scrapeQueue.getJob(id);
      if (queueJob) {
        queueInfo = {
          id: queueJob.id,
          progress: queueJob.progress(),
          attempts: queueJob.attemptsMade,
          maxAttempts: queueJob.opts.attempts,
          delay: queueJob.opts.delay,
          priority: queueJob.opts.priority,
          processedOn: queueJob.processedOn,
          finishedOn: queueJob.finishedOn,
          failedReason: queueJob.failedReason,
          stacktrace: queueJob.stacktrace,
        };
      }
    } catch (queueError) {
      console.warn('Failed to get queue job info:', queueError);
    }

    // Calculate duration if applicable
    const duration = scrapeJob.startedAt && scrapeJob.completedAt
      ? scrapeJob.completedAt.getTime() - scrapeJob.startedAt.getTime()
      : null;

    // Get related listings count (if job is completed)
    let relatedListingsCount = 0;
    if (scrapeJob.status === 'COMPLETED' && scrapeJob.resultCount) {
      // In a real implementation, you might want to query listings created by this job
      relatedListingsCount = scrapeJob.resultCount;
    }

    return NextResponse.json({
      success: true,
      job: {
        ...scrapeJob,
        duration,
        queue: queueInfo,
        relatedListings: relatedListingsCount,
        timeline: generateJobTimeline(scrapeJob, queueInfo),
      },
    });

  } catch (error) {
    console.error('Error fetching job:', error);

    return NextResponse.json({
      success: false,
      error: 'Failed to fetch job',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { action, priority, webhookUrl } = UpdateJobSchema.parse(body);

    if (!id) {
      return NextResponse.json({
        success: false,
        error: 'Job ID is required',
      }, { status: 400 });
    }

    // Get current job
    const currentJob = await prisma.scrapeJob.findUnique({
      where: { id },
    });

    if (!currentJob) {
      return NextResponse.json({
        success: false,
        error: 'Job not found',
      }, { status: 404 });
    }

    let updateData: any = {};
    let queueAction: string | null = null;

    switch (action) {
      case 'cancel':
        updateData = {
          status: 'CANCELLED',
          completedAt: new Date(),
          error: 'Cancelled by user',
        };
        queueAction = 'remove';
        break;

      case 'pause':
        if (currentJob.status === 'PENDING') {
          updateData = { status: 'PENDING' }; // Keep as pending but remove from queue
          queueAction = 'pause';
        } else {
          return NextResponse.json({
            success: false,
            error: 'Can only pause pending jobs',
          }, { status: 400 });
        }
        break;

      case 'resume':
        if (currentJob.status === 'PENDING') {
          queueAction = 'resume';
        } else {
          return NextResponse.json({
            success: false,
            error: 'Can only resume paused jobs',
          }, { status: 400 });
        }
        break;

      case 'retry':
        if (currentJob.status === 'FAILED' || currentJob.status === 'CANCELLED') {
          updateData = {
            status: 'PENDING',
            error: null,
            startedAt: null,
            completedAt: null,
          };
          queueAction = 'retry';
        } else {
          return NextResponse.json({
            success: false,
            error: 'Can only retry failed or cancelled jobs',
          }, { status: 400 });
        }
        break;
    }

    // Update database
    if (Object.keys(updateData).length > 0) {
      await prisma.scrapeJob.update({
        where: { id },
        data: {
          ...updateData,
          updatedAt: new Date(),
        },
      });
    }

    // Handle queue actions
    if (queueAction) {
      try {
        const queueJob = await scrapeQueue.getJob(id);

        switch (queueAction) {
          case 'remove':
            if (queueJob) {
              await queueJob.remove();
            }
            break;

          case 'pause':
            if (queueJob) {
              await queueJob.pause();
            }
            break;

          case 'resume':
            if (queueJob) {
              await queueJob.resume();
            }
            break;

          case 'retry':
            // Re-add job to queue
            await scrapeQueue.add('scrape-listings', {
              id: currentJob.id,
              filters: currentJob.filters,
              priority: priority || 5,
            }, {
              priority: priority || 5,
              jobId: currentJob.id,
            });
            break;
        }
      } catch (queueError) {
        console.warn('Queue action failed:', queueError);
        // Don't fail the entire request if queue action fails
      }
    }

    return NextResponse.json({
      success: true,
      message: `Job ${action} successful`,
      action,
      jobId: id,
    });

  } catch (error) {
    console.error('Error updating job:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid request data',
        details: error.errors,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to update job',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json({
        success: false,
        error: 'Job ID is required',
      }, { status: 400 });
    }

    // Get current job
    const currentJob = await prisma.scrapeJob.findUnique({
      where: { id },
    });

    if (!currentJob) {
      return NextResponse.json({
        success: false,
        error: 'Job not found',
      }, { status: 404 });
    }

    // Can only delete completed, failed, or cancelled jobs
    if (['PROCESSING', 'PENDING'].includes(currentJob.status)) {
      return NextResponse.json({
        success: false,
        error: 'Cannot delete active jobs. Cancel the job first.',
      }, { status: 400 });
    }

    // Remove from queue if exists
    try {
      const queueJob = await scrapeQueue.getJob(id);
      if (queueJob) {
        await queueJob.remove();
      }
    } catch (queueError) {
      console.warn('Failed to remove job from queue:', queueError);
    }

    // Delete from database
    await prisma.scrapeJob.delete({
      where: { id },
    });

    return NextResponse.json({
      success: true,
      message: 'Job deleted successfully',
    });

  } catch (error) {
    console.error('Error deleting job:', error);

    return NextResponse.json({
      success: false,
      error: 'Failed to delete job',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

function generateJobTimeline(scrapeJob: any, queueInfo: any) {
  const timeline = [];

  timeline.push({
    event: 'created',
    timestamp: scrapeJob.createdAt,
    description: 'Job created and added to queue',
  });

  if (scrapeJob.startedAt) {
    timeline.push({
      event: 'started',
      timestamp: scrapeJob.startedAt,
      description: 'Job processing started',
    });
  }

  if (queueInfo?.attempts > 1) {
    timeline.push({
      event: 'retry',
      timestamp: null, // Would need to track retry timestamps
      description: `Job retried (attempt ${queueInfo.attempts}/${queueInfo.maxAttempts})`,
    });
  }

  if (scrapeJob.completedAt) {
    const isSuccess = scrapeJob.status === 'COMPLETED';
    timeline.push({
      event: isSuccess ? 'completed' : 'failed',
      timestamp: scrapeJob.completedAt,
      description: isSuccess
        ? `Job completed successfully (${scrapeJob.resultCount || 0} listings)`
        : `Job failed: ${scrapeJob.error || 'Unknown error'}`,
    });
  }

  return timeline.sort((a, b) => {
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  });
}