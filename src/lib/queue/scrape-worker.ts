import { scrapeQueue, ScrapeJobData, ScrapeJobResult } from './scrape-queue';
import { prisma } from '../database';
import { Scraper } from '../scraper/core/scraper';
import { ScrapingMonitor } from '../scraper/core/monitor';
import { FilterValidator } from '../scraper/filters/filter-validator';

export class ScrapeWorker {
  private isProcessing = false;
  private monitor: ScrapingMonitor;

  constructor() {
    this.monitor = new ScrapingMonitor({
      errorThreshold: 5,
      memoryThresholdMB: 2048,
    });
  }

  async start(): Promise<void> {
    if (this.isProcessing) {
      console.log('Worker is already processing jobs');
      return;
    }

    this.isProcessing = true;
    console.log('🚀 Starting scrape worker...');

    // Start monitoring session
    await this.monitor.startSession();

    // Process jobs
    scrapeQueue.process('scrape-listings', async (job) => {
      return this.processScrapeJob(job.data);
    });

    // Event listeners
    scrapeQueue.on('completed', (job, result) => {
      console.log(`✅ Job ${job.id} completed: ${result.listingsScraped} listings scraped`);
      this.updateJobStatus(job.data.id, 'COMPLETED', result);
    });

    scrapeQueue.on('failed', (job, error) => {
      console.error(`❌ Job ${job.id} failed:`, error.message);
      this.updateJobStatus(job.data.id, 'FAILED', null, error.message);
    });

    scrapeQueue.on('progress', (job, progress) => {
      console.log(`📊 Job ${job.id} progress: ${progress}%`);
    });

    console.log('✅ Scrape worker started successfully');
  }

  async stop(): Promise<void> {
    if (!this.isProcessing) {
      return;
    }

    console.log('🛑 Stopping scrape worker...');
    this.isProcessing = false;

    await scrapeQueue.close();
    await this.monitor.endSession();

    console.log('✅ Scrape worker stopped');
  }

  private async processScrapeJob(jobData: ScrapeJobData): Promise<ScrapeJobResult> {
    const startTime = Date.now();

    try {
      console.log(`🔍 Processing scrape job: ${jobData.id}`);

      // Update job status to processing
      await this.updateJobStatus(jobData.id, 'PROCESSING');

      // Validate filters
      const validatedFilters = FilterValidator.validate(jobData.filters);
      const validation = FilterValidator.validateForScraping(validatedFilters);

      if (!validation.isValid) {
        throw new Error(`Filter validation failed: ${validation.errors.join(', ')}`);
      }

      // Log warnings
      if (validation.warnings.length > 0) {
        this.monitor.log('warn', 'Filter validation warnings', 'validation', {
          warnings: validation.warnings,
          jobId: jobData.id,
        });
      }

      // Create scraper instance
      const scraper = new Scraper();

      // Configure scraping
      const scrapeConfig = {
        filters: validatedFilters,
        maxPages: 50, // Configurable limit
        maxResults: 1000, // Configurable limit
        detailScraping: false, // Can be configured per job
        onProgress: (progress) => {
          // Update job progress
          const progressPercent = progress.totalPages > 0
            ? Math.round((progress.currentPage / progress.totalPages) * 100)
            : 0;

          scrapeQueue.getJob(jobData.id).then(job => {
            if (job) {
              job.progress(progressPercent);
            }
          });

          // Log progress
          this.monitor.log('debug', 'Scrape progress update', 'scraping', progress, jobData.id);
        },
        onListingProcessed: (listing) => {
          this.monitor.log('debug', 'Listing processed', 'processing', {
            title: listing.title,
            price: listing.askingPrice,
          }, jobData.id);
        },
        onError: (error, context) => {
          this.monitor.log('error', `Scraping error in ${context}`, 'scraping', {
            error: error.message,
          }, jobData.id);
        },
      };

      // Execute scraping
      const result = await scraper.scrape(scrapeConfig);

      if (!result.success) {
        throw new Error(`Scraping failed: ${result.stats.errors.join(', ')}`);
      }

      // Save listings to database
      const savedListings = await this.saveListingsToDatabase(result.listings, jobData.id);

      // Prepare job result
      const jobResult: ScrapeJobResult = {
        listingsFound: result.stats.listingsFound,
        listingsScraped: savedListings,
        errors: result.stats.errors,
      };

      const executionTime = Date.now() - startTime;
      this.monitor.log('info', 'Scrape job completed successfully', 'job', {
        jobId: jobData.id,
        listingsFound: result.stats.listingsFound,
        listingsSaved: savedListings,
        executionTime,
      }, jobData.id);

      return jobResult;

    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.monitor.log('error', 'Scrape job failed', 'job', {
        jobId: jobData.id,
        error: errorMessage,
        executionTime,
      }, jobData.id);

      throw error;
    }
  }

  private async saveListingsToDatabase(listings: any[], jobId: string): Promise<number> {
    let savedCount = 0;

    for (const listing of listings) {
      try {
        await prisma.businessListing.upsert({
          where: { bizBuySellId: listing.bizBuySellId },
          create: listing,
          update: {
            // Update specific fields while preserving others
            title: listing.title,
            askingPrice: listing.askingPrice,
            revenue: listing.revenue,
            cashFlow: listing.cashFlow,
            description: listing.description,
            imageUrls: listing.imageUrls,
            updatedAt: new Date(),
          },
        });

        savedCount++;

      } catch (error) {
        this.monitor.log('warn', 'Failed to save listing', 'database', {
          listingId: listing.bizBuySellId,
          error: error instanceof Error ? error.message : 'Unknown error',
        }, jobId);
      }
    }

    this.monitor.log('info', 'Saved listings to database', 'database', {
      totalListings: listings.length,
      savedListings: savedCount,
      skipped: listings.length - savedCount,
    }, jobId);

    return savedCount;
  }

  private async updateJobStatus(
    jobId: string,
    status: 'PROCESSING' | 'COMPLETED' | 'FAILED',
    result?: ScrapeJobResult | null,
    error?: string
  ): Promise<void> {
    try {
      const updateData: any = {
        status,
        updatedAt: new Date(),
      };

      if (status === 'PROCESSING') {
        updateData.startedAt = new Date();
      } else if (status === 'COMPLETED' || status === 'FAILED') {
        updateData.completedAt = new Date();
      }

      if (result) {
        updateData.resultCount = result.listingsScraped;
      }

      if (error) {
        updateData.error = error;
      }

      await prisma.scrapeJob.update({
        where: { id: jobId },
        data: updateData,
      });

    } catch (dbError) {
      console.error(`Failed to update job status for ${jobId}:`, dbError);
    }
  }

  getWorkerStats() {
    return {
      isProcessing: this.isProcessing,
      waiting: scrapeQueue.waiting(),
      active: scrapeQueue.active(),
      completed: scrapeQueue.completed(),
      failed: scrapeQueue.failed(),
      metrics: this.monitor.getMetrics(),
      health: this.monitor.getHealthStatus(),
    };
  }
}

// Create and export worker instance
export const scrapeWorker = new ScrapeWorker();

// Auto-start worker if this file is run directly
if (require.main === module) {
  scrapeWorker
    .start()
    .then(() => {
      console.log('✅ Worker started successfully');

      // Graceful shutdown
      process.on('SIGTERM', () => {
        console.log('📡 Received SIGTERM, shutting down gracefully...');
        scrapeWorker.stop().then(() => {
          process.exit(0);
        });
      });

      process.on('SIGINT', () => {
        console.log('📡 Received SIGINT, shutting down gracefully...');
        scrapeWorker.stop().then(() => {
          process.exit(0);
        });
      });
    })
    .catch((error) => {
      console.error('❌ Failed to start worker:', error);
      process.exit(1);
    });
}