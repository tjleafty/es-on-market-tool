import { jobQueue, JobData } from './database-queue';
import { Scraper } from '@/lib/scraper/core/scraper';
import { FilterValidator } from '@/lib/scraper/filters/filter-validator';
import { prisma } from '@/lib/database';
import { webhookManager } from '@/lib/webhooks/webhook-manager';

export class JobProcessor {
  private scraper: Scraper;

  constructor() {
    this.scraper = new Scraper();
    this.setupJobProcessing();
  }

  private setupJobProcessing(): void {
    // Listen for jobs to process from the queue
    jobQueue.on('processJob', this.handleJob.bind(this));
    console.log('🔧 Job processor initialized');
  }

  private async handleJob(job: JobData): Promise<void> {
    const startTime = Date.now();

    try {
      console.log(`🎯 Processing job: ${job.id}`);

      // Validate filters
      const validatedFilters = FilterValidator.validatePartial(job.filters);

      // Configure scraper
      const config = {
        filters: validatedFilters,
        maxListings: job.maxListings,
        enableProgressTracking: true,
        onProgress: (progress: any) => this.handleProgress(job.id, progress),
        onListingsBatch: (listings: any[]) => this.handleListingsBatch(job.id, listings, job.enableWebhooks),
      };

      // Update progress
      await jobQueue.updateJobProgress(job.id, 5, 'Starting scraper...');

      // Run the scraper
      const result = await this.scraper.scrape(config);

      const duration = Date.now() - startTime;

      // Complete the job
      await jobQueue.completeJob(job.id, {
        success: true,
        listingsFound: result.listingsScraped,
        duration,
        data: {
          pagesProcessed: result.pagesProcessed,
          errors: result.errors,
        },
      });

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      console.error(`❌ Job failed: ${job.id} - ${errorMessage}`);

      // Complete job with error
      await jobQueue.completeJob(job.id, {
        success: false,
        listingsFound: 0,
        duration,
        error: errorMessage,
      });
    }
  }

  private async handleProgress(jobId: string, progress: any): Promise<void> {
    // Update job progress
    const progressPercent = Math.min(Math.round((progress.processed / progress.total) * 100), 95);

    await jobQueue.updateJobProgress(
      jobId,
      progressPercent,
      `Processing page ${progress.currentPage}/${progress.totalPages} (${progress.processed}/${progress.total} listings)`
    );
  }

  private async handleListingsBatch(
    jobId: string,
    listings: any[],
    enableWebhooks: boolean
  ): Promise<void> {
    try {
      // Save listings to database
      if (listings.length > 0) {
        await prisma.businessListing.createMany({
          data: listings.map(listing => ({
            ...listing,
            scrapedAt: new Date(),
          })),
          skipDuplicates: true, // Skip if bizBuySellId already exists
        });

        console.log(`💾 Saved ${listings.length} listings for job ${jobId}`);
      }

      // Emit webhook event if enabled
      if (enableWebhooks && listings.length > 0) {
        await webhookManager.emitListingsBatch(
          listings.map(listing => ({
            id: listing.bizBuySellId,
            title: listing.title,
            price: listing.askingPrice,
            location: listing.location,
            industry: listing.industry,
          }))
        );
      }

    } catch (error) {
      console.error(`Failed to save listings batch for job ${jobId}:`, error);
    }
  }

  async getProcessingStats(): Promise<{
    isProcessing: boolean;
    currentJobs: number;
    queueStats: any;
  }> {
    const queueStats = await jobQueue.getQueueStats();

    return {
      isProcessing: queueStats.processing > 0,
      currentJobs: queueStats.currentJobs.length,
      queueStats,
    };
  }

  stop(): void {
    jobQueue.stop();
    console.log('🛑 Job processor stopped');
  }
}

// Global job processor instance
export const jobProcessor = new JobProcessor();