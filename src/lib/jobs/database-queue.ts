import { prisma } from '@/lib/database';
import { EventEmitter } from 'events';
import { sseManager } from '@/lib/realtime/sse-manager';
import { webhookManager } from '@/lib/webhooks/webhook-manager';

export interface JobData {
  id: string;
  filters: any;
  priority: 'LOW' | 'NORMAL' | 'HIGH';
  maxListings: number;
  enableWebhooks: boolean;
  createdAt: Date;
}

export interface JobResult {
  success: boolean;
  listingsFound: number;
  duration: number;
  error?: string;
  data?: any;
}

export class DatabaseJobQueue extends EventEmitter {
  private processing = false;
  private pollingInterval?: NodeJS.Timeout;
  private maxConcurrentJobs: number;
  private currentJobs = new Set<string>();

  constructor(maxConcurrentJobs: number = 3) {
    super();
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.startPolling();
  }

  async addJob(
    filters: any,
    options: {
      priority?: 'LOW' | 'NORMAL' | 'HIGH';
      maxListings?: number;
      enableWebhooks?: boolean;
    } = {}
  ): Promise<string> {
    try {
      const job = await prisma.scrapeJob.create({
        data: {
          filters,
          priority: options.priority || 'NORMAL',
          maxListings: options.maxListings || 1000,
          enableWebhooks: options.enableWebhooks || false,
          status: 'PENDING',
        },
      });

      console.log(`📋 Job added to queue: ${job.id} (priority: ${job.priority})`);

      // Emit webhook event if enabled
      if (job.enableWebhooks) {
        await webhookManager.emitJobCreated(job.id, {
          filters: job.filters,
          priority: job.priority,
          maxListings: job.maxListings,
          status: job.status,
          createdAt: job.createdAt.toISOString(),
        });
      }

      // Send real-time update
      sseManager.sendJobUpdate(job.id, {
        status: job.status,
        progress: 0,
        message: 'Job created and queued for processing',
      });

      // Trigger immediate processing check
      this.processQueue();

      return job.id;
    } catch (error) {
      console.error('Failed to add job to queue:', error);
      throw error;
    }
  }

  async getJob(id: string): Promise<JobData | null> {
    try {
      const job = await prisma.scrapeJob.findUnique({
        where: { id },
      });

      return job ? {
        id: job.id,
        filters: job.filters,
        priority: job.priority,
        maxListings: job.maxListings,
        enableWebhooks: job.enableWebhooks,
        createdAt: job.createdAt,
      } : null;
    } catch (error) {
      console.error('Failed to get job:', error);
      return null;
    }
  }

  async updateJobProgress(id: string, progress: number, message?: string): Promise<void> {
    try {
      await prisma.scrapeJob.update({
        where: { id },
        data: {
          progress,
          updatedAt: new Date(),
        },
      });

      // Send real-time update
      sseManager.sendScrapingProgress(id, {
        progress,
        message: message || `Progress: ${progress}%`,
      });

      console.log(`📊 Job progress updated: ${id} -> ${progress}%`);
    } catch (error) {
      console.error('Failed to update job progress:', error);
    }
  }

  async completeJob(id: string, result: JobResult): Promise<void> {
    try {
      const job = await prisma.scrapeJob.update({
        where: { id },
        data: {
          status: result.success ? 'COMPLETED' : 'FAILED',
          progress: result.success ? 100 : 0,
          listingsFound: result.listingsFound,
          duration: result.duration,
          error: result.error,
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      this.currentJobs.delete(id);

      console.log(`✅ Job ${result.success ? 'completed' : 'failed'}: ${id} (${result.listingsFound} listings, ${result.duration}ms)`);

      // Send real-time update
      sseManager.sendJobUpdate(id, {
        status: job.status,
        progress: job.progress,
        listingsFound: result.listingsFound,
        duration: result.duration,
        error: result.error,
        completedAt: job.completedAt?.toISOString(),
      });

      // Emit webhook event if enabled
      if (job.enableWebhooks) {
        if (result.success) {
          await webhookManager.emitJobCompleted(id, {
            listingsFound: result.listingsFound,
            duration: result.duration,
            completedAt: job.completedAt?.toISOString(),
          });
        } else {
          await webhookManager.emitJobFailed(id, result.error || 'Unknown error');
        }
      }

      this.emit('jobCompleted', { id, result });

      // Process next jobs in queue
      this.processQueue();
    } catch (error) {
      console.error('Failed to complete job:', error);
    }
  }

  async cancelJob(id: string): Promise<boolean> {
    try {
      const job = await prisma.scrapeJob.findUnique({
        where: { id },
      });

      if (!job || job.status === 'COMPLETED' || job.status === 'FAILED') {
        return false;
      }

      await prisma.scrapeJob.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          updatedAt: new Date(),
        },
      });

      this.currentJobs.delete(id);

      console.log(`❌ Job cancelled: ${id}`);

      // Send real-time update
      sseManager.sendJobUpdate(id, {
        status: 'CANCELLED',
        message: 'Job was cancelled',
      });

      this.emit('jobCancelled', { id });
      return true;
    } catch (error) {
      console.error('Failed to cancel job:', error);
      return false;
    }
  }

  async getQueueStats(): Promise<{
    pending: number;
    processing: number;
    completed: number;
    failed: number;
    cancelled: number;
    currentJobs: string[];
  }> {
    try {
      const stats = await prisma.scrapeJob.groupBy({
        by: ['status'],
        _count: {
          id: true,
        },
      });

      const statsByStatus = stats.reduce((acc, stat) => {
        acc[stat.status.toLowerCase()] = stat._count.id;
        return acc;
      }, {} as Record<string, number>);

      return {
        pending: statsByStatus.pending || 0,
        processing: statsByStatus.processing || 0,
        completed: statsByStatus.completed || 0,
        failed: statsByStatus.failed || 0,
        cancelled: statsByStatus.cancelled || 0,
        currentJobs: Array.from(this.currentJobs),
      };
    } catch (error) {
      console.error('Failed to get queue stats:', error);
      return {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        currentJobs: [],
      };
    }
  }

  private startPolling(): void {
    const interval = parseInt(process.env.JOB_POLLING_INTERVAL || '5000');
    this.pollingInterval = setInterval(() => {
      this.processQueue();
    }, interval);

    console.log(`🔄 Database job queue polling started (${interval}ms interval)`);
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.currentJobs.size >= this.maxConcurrentJobs) {
      return;
    }

    this.processing = true;

    try {
      // Get next job by priority and creation time
      const nextJob = await prisma.scrapeJob.findFirst({
        where: {
          status: 'PENDING',
        },
        orderBy: [
          { priority: 'desc' }, // HIGH, NORMAL, LOW
          { createdAt: 'asc' },  // FIFO within same priority
        ],
      });

      if (!nextJob) {
        this.processing = false;
        return;
      }

      // Mark job as processing
      await prisma.scrapeJob.update({
        where: { id: nextJob.id },
        data: {
          status: 'PROCESSING',
          startedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      this.currentJobs.add(nextJob.id);

      console.log(`🚀 Starting job processing: ${nextJob.id}`);

      // Send real-time update
      sseManager.sendJobUpdate(nextJob.id, {
        status: 'PROCESSING',
        progress: 0,
        message: 'Job processing started',
        startedAt: new Date().toISOString(),
      });

      // Emit webhook event if enabled
      if (nextJob.enableWebhooks) {
        await webhookManager.emitEvent({
          type: 'job.started',
          data: {
            jobId: nextJob.id,
            status: 'PROCESSING',
            startedAt: new Date().toISOString(),
          },
          timestamp: Date.now(),
          source: 'job-queue',
        });
      }

      // Emit event for job processor to handle
      this.emit('processJob', {
        id: nextJob.id,
        filters: nextJob.filters,
        priority: nextJob.priority,
        maxListings: nextJob.maxListings,
        enableWebhooks: nextJob.enableWebhooks,
        createdAt: nextJob.createdAt,
      });

    } catch (error) {
      console.error('Error processing queue:', error);
    } finally {
      this.processing = false;
    }
  }

  async cleanup(): Promise<void> {
    try {
      // Mark stalled jobs as failed (jobs processing for more than 10 minutes)
      const stalledThreshold = new Date(Date.now() - 10 * 60 * 1000);

      const stalledJobs = await prisma.scrapeJob.updateMany({
        where: {
          status: 'PROCESSING',
          startedAt: {
            lt: stalledThreshold,
          },
        },
        data: {
          status: 'FAILED',
          error: 'Job timed out (stalled for more than 10 minutes)',
          updatedAt: new Date(),
        },
      });

      if (stalledJobs.count > 0) {
        console.log(`🧹 Cleaned up ${stalledJobs.count} stalled jobs`);
      }
    } catch (error) {
      console.error('Failed to cleanup stalled jobs:', error);
    }
  }

  stop(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
    }
    console.log('🛑 Database job queue stopped');
  }
}

// Global database job queue instance
export const jobQueue = new DatabaseJobQueue(
  parseInt(process.env.MAX_CONCURRENT_JOBS || '3')
);

// Cleanup stalled jobs every 5 minutes
setInterval(() => {
  jobQueue.cleanup();
}, 5 * 60 * 1000);