import { BrowserManager } from './browser-manager';
import { FilterBuilder } from '../filters/filter-builder';
import { SearchExtractor } from '../extractors/search-extractor';
import { ListingExtractor } from '../extractors/listing-extractor';
import { PaginationHandler, PaginationConfig } from '../extractors/pagination';
import { DataProcessor, ProcessingResult } from './data-processor';
import { RetryHandler, RetryConfig } from './retry-handler';
import { RateLimiter } from '../utils/rate-limiter';
import { ScrapeFilters, BusinessListing } from '@/types';
import { Page } from 'playwright';

export interface ScrapeConfig {
  filters: ScrapeFilters;
  maxPages?: number;
  maxResults?: number;
  concurrency?: number;
  detailScraping?: boolean;
  retryConfig?: RetryConfig;
  onProgress?: (progress: ScrapeProgress) => void;
  onListingProcessed?: (listing: BusinessListing) => void;
  onError?: (error: Error, context?: string) => void;
}

export interface ScrapeProgress {
  phase: 'starting' | 'searching' | 'processing' | 'details' | 'completed' | 'failed';
  currentPage: number;
  totalPages: number;
  listingsFound: number;
  listingsProcessed: number;
  listingsSuccessful: number;
  listingsFailed: number;
  errors: string[];
  estimatedTimeRemaining?: number;
  startTime: number;
}

export interface ScrapeResult {
  success: boolean;
  listings: BusinessListing[];
  stats: {
    totalPages: number;
    pagesScraped: number;
    listingsFound: number;
    listingsProcessed: number;
    listingsSuccessful: number;
    listingsFailed: number;
    duplicatesSkipped: number;
    errors: string[];
    executionTime: number;
  };
  filters: ScrapeFilters;
}

export class Scraper {
  private browserManager: BrowserManager;
  private filterBuilder: FilterBuilder;
  private searchExtractor: SearchExtractor;
  private listingExtractor: ListingExtractor;
  private paginationHandler: PaginationHandler;
  private dataProcessor: DataProcessor;
  private retryHandler: RetryHandler;
  private rateLimiter: RateLimiter;

  constructor() {
    this.browserManager = new BrowserManager();
    this.filterBuilder = new FilterBuilder();
    this.searchExtractor = new SearchExtractor();
    this.listingExtractor = new ListingExtractor();
    this.paginationHandler = new PaginationHandler();
    this.dataProcessor = new DataProcessor();
    this.retryHandler = new RetryHandler();
    this.rateLimiter = new RateLimiter();
  }

  async scrape(config: ScrapeConfig): Promise<ScrapeResult> {
    const startTime = Date.now();
    const progress: ScrapeProgress = {
      phase: 'starting',
      currentPage: 0,
      totalPages: 0,
      listingsFound: 0,
      listingsProcessed: 0,
      listingsSuccessful: 0,
      listingsFailed: 0,
      errors: [],
      startTime,
    };

    const result: ScrapeResult = {
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
        errors: [],
        executionTime: 0,
      },
      filters: config.filters,
    };

    let page: Page | undefined;

    try {
      console.log('🚀 Starting scraping job with filters:', config.filters);

      // Update progress
      progress.phase = 'starting';
      config.onProgress?.(progress);

      // Initialize browser
      const browser = await this.browserManager.createBrowser();
      const context = await this.browserManager.createContext(browser);
      page = await this.browserManager.createPage(context);

      // Build search URL
      const searchUrl = this.filterBuilder.buildSearchUrl(config.filters);
      console.log('🔍 Search URL:', searchUrl);

      // Configure pagination
      const paginationConfig: PaginationConfig = {
        maxPages: config.maxPages,
        maxResults: config.maxResults,
        onPageCompleted: async (pageData) => {
          progress.currentPage++;
          progress.listingsFound = result.stats.listingsFound + pageData.listings.length;

          // Process listings from this page
          await this.processPageListings(pageData.listings, config, result, progress);

          config.onProgress?.(progress);
        },
        onProgress: (current, total, foundListings) => {
          progress.currentPage = current;
          progress.totalPages = total;
          progress.listingsFound = foundListings;
          config.onProgress?.(progress);
        },
      };

      // Execute pagination scraping
      progress.phase = 'searching';
      config.onProgress?.(progress);

      const paginationResult = await this.retryHandler.executeWithRetry(
        () => this.paginationHandler.scrapeAllPages(page!, searchUrl, paginationConfig),
        config.retryConfig
      );

      if (!paginationResult.success) {
        throw paginationResult.error || new Error('Pagination failed');
      }

      const pageData = paginationResult.data!;

      // Update final stats
      result.stats.totalPages = pageData.totalPages;
      result.stats.pagesScraped = pageData.pagesScraped;
      result.stats.listingsFound = pageData.listings.length;
      result.stats.errors = pageData.errors;

      // Process any remaining listings
      progress.phase = 'processing';
      config.onProgress?.(progress);

      const processingStats = this.dataProcessor.getStats();
      result.stats.listingsProcessed = processingStats.totalProcessed;
      result.stats.listingsSuccessful = processingStats.successful;
      result.stats.listingsFailed = processingStats.failed;
      result.stats.duplicatesSkipped = processingStats.duplicates;

      // Scrape detail pages if requested
      if (config.detailScraping && result.listings.length > 0) {
        progress.phase = 'details';
        config.onProgress?.(progress);

        await this.scrapeDetailPages(result.listings, page, config, progress);
      }

      result.success = true;
      progress.phase = 'completed';

      console.log(`✅ Scraping completed successfully:`);
      console.log(`   📊 ${result.stats.pagesScraped} pages scraped`);
      console.log(`   📋 ${result.stats.listingsFound} listings found`);
      console.log(`   ✅ ${result.stats.listingsSuccessful} successfully processed`);
      console.log(`   ❌ ${result.stats.listingsFailed} failed processing`);
      console.log(`   ⏱️  ${((Date.now() - startTime) / 1000).toFixed(2)}s execution time`);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('❌ Scraping failed:', errorMsg);

      progress.phase = 'failed';
      progress.errors.push(errorMsg);
      result.stats.errors.push(errorMsg);

      config.onError?.(error instanceof Error ? error : new Error(errorMsg), 'main_scraper');
    } finally {
      // Cleanup
      if (page) {
        try {
          await page.close();
        } catch (error) {
          console.warn('Error closing page:', error);
        }
      }

      await this.browserManager.cleanup();

      result.stats.executionTime = Date.now() - startTime;
      config.onProgress?.(progress);
    }

    return result;
  }

  private async processPageListings(
    rawListings: any[],
    config: ScrapeConfig,
    result: ScrapeResult,
    progress: ScrapeProgress
  ): Promise<void> {
    for (const rawListing of rawListings) {
      try {
        const processingResult = this.dataProcessor.processListing(rawListing);

        progress.listingsProcessed++;

        if (processingResult.success && processingResult.data) {
          result.listings.push(processingResult.data);
          progress.listingsSuccessful++;

          // Notify about successful listing
          config.onListingProcessed?.(processingResult.data);

          console.log(`✅ Processed: ${processingResult.data.title}`);
        } else {
          progress.listingsFailed++;
          const errors = processingResult.errors.join(', ');
          console.warn(`❌ Failed to process listing: ${errors}`);

          // Add errors to result
          result.stats.errors.push(...processingResult.errors);
        }

        // Rate limiting between listings
        await this.rateLimiter.randomDelay(100, 300);

      } catch (error) {
        progress.listingsFailed++;
        const errorMsg = `Error processing listing: ${error instanceof Error ? error.message : 'Unknown'}`;
        console.error(errorMsg);
        result.stats.errors.push(errorMsg);
      }
    }
  }

  private async scrapeDetailPages(
    listings: BusinessListing[],
    page: Page,
    config: ScrapeConfig,
    progress: ScrapeProgress
  ): Promise<void> {
    console.log(`🔍 Scraping details for ${listings.length} listings...`);

    let processed = 0;
    for (const listing of listings) {
      if (!listing.listingUrl) {
        continue;
      }

      try {
        await this.rateLimiter.wait();
        await this.rateLimiter.randomDelay();

        // Navigate to detail page
        const navigationResult = await this.retryHandler.retryPageNavigation(
          page,
          listing.listingUrl,
          config.retryConfig
        );

        if (!navigationResult.success) {
          console.warn(`Failed to navigate to detail page: ${listing.listingUrl}`);
          continue;
        }

        // Extract additional details
        const pageContent = await page.content();
        const detailData = this.listingExtractor.extractFromDetailPage(pageContent, listing.listingUrl);

        // Merge additional data into listing
        this.mergeDetailData(listing, detailData);

        processed++;
        console.log(`📋 Enhanced ${processed}/${listings.length}: ${listing.title}`);

        // Update progress
        progress.listingsProcessed = processed;
        config.onProgress?.(progress);

      } catch (error) {
        const errorMsg = `Error scraping detail page for ${listing.title}: ${error instanceof Error ? error.message : 'Unknown'}`;
        console.warn(errorMsg);
        config.onError?.(error instanceof Error ? error : new Error(errorMsg), 'detail_scraping');
      }
    }

    console.log(`✅ Enhanced ${processed} listings with detail data`);
  }

  private mergeDetailData(listing: BusinessListing, detailData: any): void {
    // Merge additional data without overwriting existing data
    if (detailData.description && !listing.description) {
      listing.description = detailData.description;
    }

    if (detailData.revenue && !listing.revenue) {
      listing.revenue = parseFloat(detailData.revenue) || undefined;
    }

    if (detailData.cashFlow && !listing.cashFlow) {
      listing.cashFlow = parseFloat(detailData.cashFlow) || undefined;
    }

    if (detailData.employees && !listing.employees) {
      listing.employees = parseInt(detailData.employees) || undefined;
    }

    if (detailData.established && !listing.established) {
      listing.established = parseInt(detailData.established) || undefined;
    }

    if (detailData.images && detailData.images.length > 0) {
      listing.imageUrls = [...(listing.imageUrls || []), ...detailData.images];
    }

    if (detailData.features && detailData.features.length > 0) {
      listing.features = [...(listing.features || []), ...detailData.features];
    }

    // Contact information
    if (detailData.contactInfo) {
      listing.contactName = detailData.contactInfo.name || listing.contactName;
      listing.contactEmail = detailData.contactInfo.email || listing.contactEmail;
      listing.contactPhone = detailData.contactInfo.phone || listing.contactPhone;
    }

    // Broker information
    if (detailData.brokerInfo) {
      listing.brokerName = detailData.brokerInfo.name || listing.brokerName;
      listing.brokerCompany = detailData.brokerInfo.company || listing.brokerCompany;
    }
  }

  async validateConnection(): Promise<boolean> {
    try {
      const browser = await this.browserManager.createBrowser();
      const context = await this.browserManager.createContext(browser);
      const page = await this.browserManager.createPage(context);

      await page.goto('https://www.bizbuysell.com', { waitUntil: 'networkidle' });
      const title = await page.title();

      await this.browserManager.cleanup();

      return title.toLowerCase().includes('bizbuysell');
    } catch (error) {
      console.error('Connection validation failed:', error);
      return false;
    }
  }

  async estimateScrapeTime(config: ScrapeConfig): Promise<{
    estimatedPages: number;
    estimatedResults: number;
    estimatedTimeMinutes: number;
    estimatedDuration: string;
  }> {
    // Quick search to get total results
    try {
      const browser = await this.browserManager.createBrowser();
      const context = await this.browserManager.createContext(browser);
      const page = await this.browserManager.createPage(context);

      const searchUrl = this.filterBuilder.buildSearchUrl(config.filters);
      await page.goto(searchUrl, { waitUntil: 'networkidle' });

      const pageContent = await page.content();
      const totalResults = this.searchExtractor.extractTotalResultsCount(pageContent);

      await this.browserManager.cleanup();

      // Calculate estimates
      const resultsPerPage = 20; // BizBuySell standard
      const estimatedPages = Math.ceil(totalResults / resultsPerPage);
      const maxPages = Math.min(estimatedPages, config.maxPages || estimatedPages);
      const maxResults = Math.min(totalResults, config.maxResults || totalResults);

      // Time estimates (conservative)
      const timePerPage = 4; // seconds
      const detailTimePerListing = config.detailScraping ? 2 : 0; // seconds
      const totalTimeSeconds = (maxPages * timePerPage) + (maxResults * detailTimePerListing);
      const estimatedTimeMinutes = Math.ceil(totalTimeSeconds / 60);

      let estimatedDuration: string;
      if (estimatedTimeMinutes < 60) {
        estimatedDuration = `${estimatedTimeMinutes} minutes`;
      } else {
        const hours = Math.floor(estimatedTimeMinutes / 60);
        const mins = estimatedTimeMinutes % 60;
        estimatedDuration = `${hours}h ${mins}m`;
      }

      return {
        estimatedPages: maxPages,
        estimatedResults: maxResults,
        estimatedTimeMinutes,
        estimatedDuration,
      };

    } catch (error) {
      console.error('Failed to estimate scrape time:', error);
      return {
        estimatedPages: 1,
        estimatedResults: 20,
        estimatedTimeMinutes: 5,
        estimatedDuration: '5 minutes',
      };
    }
  }
}