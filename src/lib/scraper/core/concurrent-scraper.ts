import PQueue from 'p-queue';
import { BrowserManager } from './browser-manager';
import { Scraper, ScrapeConfig, ScrapeResult } from './scraper';
import { RateLimiter } from '../utils/rate-limiter';
import { RetryHandler } from './retry-handler';
import { ScrapeFilters, BusinessListing } from '@/types';
import { Page, Browser, BrowserContext } from 'playwright';

export interface ConcurrentScrapeConfig {
  filters: ScrapeFilters[];
  maxConcurrency?: number;
  maxBrowsers?: number;
  globalRateLimit?: {
    requests: number;
    windowMs: number;
  };
  onJobComplete?: (result: ScrapeResult, index: number) => void;
  onProgress?: (progress: ConcurrentProgress) => void;
  onError?: (error: Error, jobIndex: number) => void;
}

export interface ConcurrentProgress {
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  runningJobs: number;
  queuedJobs: number;
  totalListings: number;
  estimatedTimeRemaining?: number;
  startTime: number;
  jobProgress: JobProgress[];
}

export interface JobProgress {
  index: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  filters: ScrapeFilters;
  currentPage: number;
  totalPages: number;
  listingsFound: number;
  error?: string;
}

export interface ConcurrentResult {
  success: boolean;
  results: ScrapeResult[];
  failed: Array<{ index: number; error: string; filters: ScrapeFilters }>;
  stats: {
    totalJobs: number;
    successfulJobs: number;
    failedJobs: number;
    totalListings: number;
    totalExecutionTime: number;
    averageJobTime: number;
  };
}

interface BrowserPool {
  browser: Browser;
  contexts: BrowserContext[];
  pages: Page[];
  inUse: number;
  maxPages: number;
}

export class ConcurrentScraper {
  private browserManager: BrowserManager;
  private globalRateLimiter: RateLimiter;
  private retryHandler: RetryHandler;
  private browserPools: BrowserPool[] = [];

  constructor() {
    this.browserManager = new BrowserManager();
    this.globalRateLimiter = new RateLimiter(10, 60000); // Default: 10 requests per minute
    this.retryHandler = new RetryHandler();
  }

  async scrapeConcurrently(config: ConcurrentScrapeConfig): Promise<ConcurrentResult> {
    const startTime = Date.now();
    const results: ScrapeResult[] = [];
    const failed: Array<{ index: number; error: string; filters: ScrapeFilters }> = [];

    const progress: ConcurrentProgress = {
      totalJobs: config.filters.length,
      completedJobs: 0,
      failedJobs: 0,
      runningJobs: 0,
      queuedJobs: config.filters.length,
      totalListings: 0,
      startTime,
      jobProgress: config.filters.map((filters, index) => ({
        index,
        status: 'queued',
        filters,
        currentPage: 0,
        totalPages: 0,
        listingsFound: 0,
      })),
    };

    try {
      console.log(`🚀 Starting concurrent scraping with ${config.filters.length} jobs`);

      // Set up global rate limiter
      if (config.globalRateLimit) {
        this.globalRateLimiter = new RateLimiter(
          config.globalRateLimit.requests,
          config.globalRateLimit.windowMs
        );
      }

      // Initialize browser pools
      await this.initializeBrowserPools(config.maxBrowsers || 3, config.maxConcurrency || 3);

      // Create queue with concurrency control
      const queue = new PQueue({
        concurrency: Math.min(config.maxConcurrency || 3, this.browserPools.length * 3),
        intervalCap: config.globalRateLimit?.requests || 10,
        interval: config.globalRateLimit?.windowMs || 60000,
      });

      // Progress monitoring
      const progressInterval = setInterval(() => {
        progress.runningJobs = queue.pending;
        progress.queuedJobs = queue.size;
        config.onProgress?.(progress);
      }, 2000);

      // Add scraping jobs to queue
      const promises = config.filters.map((filters, index) =>
        queue.add(() => this.executeScrapeJob(filters, index, config, progress))
      );

      // Wait for all jobs to complete
      const jobResults = await Promise.allSettled(promises);

      clearInterval(progressInterval);

      // Process results
      jobResults.forEach((jobResult, index) => {
        if (jobResult.status === 'fulfilled') {
          const result = jobResult.value;
          if (result.success) {
            results.push(result);
            progress.totalListings += result.listings.length;
          } else {
            failed.push({
              index,
              error: result.stats.errors.join(', ') || 'Unknown error',
              filters: config.filters[index],
            });
          }
        } else {
          failed.push({
            index,
            error: jobResult.reason?.message || 'Job rejected',
            filters: config.filters[index],
          });
        }

        // Update job progress
        const jobProgress = progress.jobProgress[index];
        jobProgress.status = jobResult.status === 'fulfilled' ? 'completed' : 'failed';
        if (jobResult.status === 'rejected') {
          jobProgress.error = jobResult.reason?.message || 'Unknown error';
        }
      });

      progress.completedJobs = results.length;
      progress.failedJobs = failed.length;
      progress.runningJobs = 0;
      progress.queuedJobs = 0;

      console.log(`✅ Concurrent scraping completed:`);
      console.log(`   📊 ${results.length} successful jobs`);
      console.log(`   ❌ ${failed.length} failed jobs`);
      console.log(`   📋 ${progress.totalListings} total listings`);

    } catch (error) {
      console.error('❌ Concurrent scraping failed:', error);
      throw error;
    } finally {
      // Cleanup browser pools
      await this.cleanupBrowserPools();
      config.onProgress?.(progress);
    }

    const totalExecutionTime = Date.now() - startTime;
    const averageJobTime = results.length > 0
      ? results.reduce((sum, r) => sum + r.stats.executionTime, 0) / results.length
      : 0;

    return {
      success: failed.length === 0,
      results,
      failed,
      stats: {
        totalJobs: config.filters.length,
        successfulJobs: results.length,
        failedJobs: failed.length,
        totalListings: progress.totalListings,
        totalExecutionTime,
        averageJobTime,
      },
    };
  }

  private async executeScrapeJob(
    filters: ScrapeFilters,
    index: number,
    config: ConcurrentScrapeConfig,
    progress: ConcurrentProgress
  ): Promise<ScrapeResult> {
    const jobProgress = progress.jobProgress[index];
    jobProgress.status = 'running';

    try {
      console.log(`🔍 Starting job ${index + 1}: ${JSON.stringify(filters).substring(0, 100)}...`);

      // Wait for global rate limit
      await this.globalRateLimiter.wait();

      // Get available page from browser pool
      const { page, releasePageFn } = await this.acquirePage();

      try {
        // Create individual scraper instance
        const scraper = new Scraper();

        // Configure individual job
        const jobConfig: ScrapeConfig = {
          filters,
          onProgress: (scrapeProgress) => {
            jobProgress.currentPage = scrapeProgress.currentPage;
            jobProgress.totalPages = scrapeProgress.totalPages;
            jobProgress.listingsFound = scrapeProgress.listingsFound;
          },
          onError: (error, context) => {
            console.warn(`Job ${index + 1} error in ${context}:`, error.message);
            config.onError?.(error, index);
          },
        };

        // Execute scraping
        const result = await scraper.scrape(jobConfig);

        if (result.success) {
          console.log(`✅ Job ${index + 1} completed: ${result.listings.length} listings`);
          config.onJobComplete?.(result, index);
        } else {
          console.warn(`❌ Job ${index + 1} failed: ${result.stats.errors.join(', ')}`);
        }

        return result;

      } finally {
        // Always release the page back to the pool
        releasePageFn();
      }

    } catch (error) {
      console.error(`❌ Job ${index + 1} failed:`, error);
      jobProgress.status = 'failed';
      jobProgress.error = error instanceof Error ? error.message : 'Unknown error';

      // Return failed result
      return {
        success: false,
        listings: [],
        stats: {
          totalPages: 0,
          pagesScraped: 0,
          listingsFound: 0,
          listingsProcessed: 0,
          listingsSuccessful: 0,
          listingsFailed: 0,
          duplicatesSkipped: 0,
          errors: [error instanceof Error ? error.message : 'Unknown error'],
          executionTime: 0,
        },
        filters,
      };
    }
  }

  private async initializeBrowserPools(maxBrowsers: number, maxPages: number): Promise<void> {
    console.log(`🌐 Initializing ${maxBrowsers} browser pools with ${maxPages} pages each`);

    for (let i = 0; i < maxBrowsers; i++) {
      try {
        const browser = await this.browserManager.createBrowser();
        const contexts: BrowserContext[] = [];
        const pages: Page[] = [];

        // Pre-create contexts and pages
        for (let j = 0; j < maxPages; j++) {
          const context = await this.browserManager.createContext(browser);
          const page = await this.browserManager.createPage(context);

          contexts.push(context);
          pages.push(page);
        }

        this.browserPools.push({
          browser,
          contexts,
          pages,
          inUse: 0,
          maxPages,
        });

        console.log(`✅ Browser pool ${i + 1} initialized with ${pages.length} pages`);

      } catch (error) {
        console.error(`❌ Failed to initialize browser pool ${i + 1}:`, error);
      }
    }

    if (this.browserPools.length === 0) {
      throw new Error('Failed to initialize any browser pools');
    }

    console.log(`🌐 ${this.browserPools.length} browser pools ready`);
  }

  private async acquirePage(): Promise<{
    page: Page;
    releasePageFn: () => void;
  }> {
    // Find a browser pool with available pages
    for (const pool of this.browserPools) {
      if (pool.inUse < pool.pages.length) {
        const pageIndex = pool.inUse;
        const page = pool.pages[pageIndex];
        pool.inUse++;

        const releasePageFn = () => {
          pool.inUse = Math.max(0, pool.inUse - 1);
        };

        return { page, releasePageFn };
      }
    }

    // If no pages available, wait and retry
    await new Promise(resolve => setTimeout(resolve, 1000));
    return this.acquirePage();
  }

  private async cleanupBrowserPools(): Promise<void> {
    console.log('🧹 Cleaning up browser pools...');

    const cleanupPromises = this.browserPools.map(async (pool, index) => {
      try {
        // Close all pages
        await Promise.all(pool.pages.map(page =>
          page.close().catch(error =>
            console.warn(`Warning: Failed to close page in pool ${index + 1}:`, error)
          )
        ));

        // Close all contexts
        await Promise.all(pool.contexts.map(context =>
          context.close().catch(error =>
            console.warn(`Warning: Failed to close context in pool ${index + 1}:`, error)
          )
        ));

        // Close browser
        await pool.browser.close().catch(error =>
          console.warn(`Warning: Failed to close browser in pool ${index + 1}:`, error)
        );

        console.log(`✅ Browser pool ${index + 1} cleaned up`);

      } catch (error) {
        console.error(`❌ Error cleaning up browser pool ${index + 1}:`, error);
      }
    });

    await Promise.all(cleanupPromises);
    this.browserPools = [];

    console.log('✅ All browser pools cleaned up');
  }

  async estimateConcurrentScrapeTime(config: ConcurrentScrapeConfig): Promise<{
    totalEstimatedMinutes: number;
    parallelEstimatedMinutes: number;
    estimatedDuration: string;
    jobEstimates: Array<{
      filters: ScrapeFilters;
      estimatedMinutes: number;
      estimatedResults: number;
    }>;
  }> {
    // Quick estimates for each job
    const jobEstimates = await Promise.all(
      config.filters.map(async (filters) => {
        const scraper = new Scraper();
        const estimate = await scraper.estimateScrapeTime({ filters });
        return {
          filters,
          estimatedMinutes: estimate.estimatedTimeMinutes,
          estimatedResults: estimate.estimatedResults,
        };
      })
    );

    const totalEstimatedMinutes = jobEstimates.reduce((sum, job) => sum + job.estimatedMinutes, 0);
    const maxConcurrency = config.maxConcurrency || 3;
    const parallelEstimatedMinutes = Math.ceil(totalEstimatedMinutes / maxConcurrency);

    let estimatedDuration: string;
    if (parallelEstimatedMinutes < 60) {
      estimatedDuration = `${parallelEstimatedMinutes} minutes`;
    } else {
      const hours = Math.floor(parallelEstimatedMinutes / 60);
      const mins = parallelEstimatedMinutes % 60;
      estimatedDuration = `${hours}h ${mins}m`;
    }

    return {
      totalEstimatedMinutes,
      parallelEstimatedMinutes,
      estimatedDuration,
      jobEstimates,
    };
  }

  getOptimalConcurrency(jobCount: number): {
    recommendedConcurrency: number;
    recommendedBrowsers: number;
    reasoning: string;
  } {
    let recommendedConcurrency: number;
    let recommendedBrowsers: number;
    let reasoning: string;

    if (jobCount <= 2) {
      recommendedConcurrency = 1;
      recommendedBrowsers = 1;
      reasoning = 'Low job count - single browser sufficient';
    } else if (jobCount <= 5) {
      recommendedConcurrency = 2;
      recommendedBrowsers = 1;
      reasoning = 'Medium job count - moderate concurrency';
    } else if (jobCount <= 10) {
      recommendedConcurrency = 3;
      recommendedBrowsers = 2;
      reasoning = 'High job count - increased parallelism';
    } else {
      recommendedConcurrency = 4;
      recommendedBrowsers = 2;
      reasoning = 'Very high job count - maximum safe concurrency';
    }

    return {
      recommendedConcurrency,
      recommendedBrowsers,
      reasoning,
    };
  }
}