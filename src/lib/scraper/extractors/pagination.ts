import { Page } from 'playwright';
import { SearchExtractor, SearchResults } from './search-extractor';
import { RateLimiter } from '../utils/rate-limiter';

export interface PaginationConfig {
  maxPages?: number;
  maxResults?: number;
  delayBetweenPages?: number;
  onPageCompleted?: (pageData: SearchResults) => Promise<void>;
  onProgress?: (current: number, total: number, results: number) => void;
}

export interface PaginationResult {
  totalResults: number;
  totalPages: number;
  pagesScraped: number;
  listings: any[];
  errors: string[];
  executionTime: number;
}

export class PaginationHandler {
  private searchExtractor: SearchExtractor;
  private rateLimiter: RateLimiter;

  constructor() {
    this.searchExtractor = new SearchExtractor();
    this.rateLimiter = new RateLimiter(10, 60000); // 10 requests per minute
  }

  async scrapeAllPages(
    page: Page,
    initialUrl: string,
    config: PaginationConfig = {}
  ): Promise<PaginationResult> {
    const startTime = Date.now();
    const result: PaginationResult = {
      totalResults: 0,
      totalPages: 0,
      pagesScraped: 0,
      listings: [],
      errors: [],
      executionTime: 0,
    };

    try {
      console.log('Starting pagination scraping from:', initialUrl);

      // Navigate to initial page
      await page.goto(initialUrl, { waitUntil: 'networkidle' });
      await this.rateLimiter.randomDelay();

      // Get first page data to determine total pages
      const firstPageHtml = await page.content();
      const firstPageResults = this.searchExtractor.extractSearchResults(firstPageHtml, initialUrl);

      result.totalResults = firstPageResults.totalResults;
      result.totalPages = firstPageResults.totalPages;
      result.listings.push(...firstPageResults.listings);
      result.pagesScraped = 1;

      console.log(`Found ${result.totalResults} total results across ${result.totalPages} pages`);

      // Call page completed callback
      if (config.onPageCompleted) {
        await config.onPageCompleted(firstPageResults);
      }

      // Update progress
      if (config.onProgress) {
        config.onProgress(1, result.totalPages, result.listings.length);
      }

      // Determine how many pages to scrape
      const maxPages = this.calculateMaxPages(config, result);
      console.log(`Will scrape up to ${maxPages} pages`);

      // Scrape remaining pages
      let currentUrl = firstPageResults.nextPageUrl;
      let currentPage = 2;

      while (
        currentUrl &&
        currentPage <= maxPages &&
        result.listings.length < (config.maxResults || Infinity)
      ) {
        try {
          console.log(`Scraping page ${currentPage}: ${currentUrl}`);

          // Rate limiting
          await this.rateLimiter.wait();
          await this.rateLimiter.randomDelay();

          // Navigate to next page
          await page.goto(currentUrl, { waitUntil: 'networkidle' });

          const pageHtml = await page.content();
          const pageResults = this.searchExtractor.extractSearchResults(pageHtml, currentUrl);

          // Add listings from this page
          result.listings.push(...pageResults.listings);
          result.pagesScraped++;

          console.log(`Page ${currentPage}: Found ${pageResults.listings.length} listings`);

          // Call page completed callback
          if (config.onPageCompleted) {
            await config.onPageCompleted(pageResults);
          }

          // Update progress
          if (config.onProgress) {
            config.onProgress(currentPage, result.totalPages, result.listings.length);
          }

          // Prepare for next iteration
          currentUrl = pageResults.nextPageUrl;
          currentPage++;

          // Check if we should stop due to max results
          if (config.maxResults && result.listings.length >= config.maxResults) {
            console.log(`Reached max results limit: ${config.maxResults}`);
            break;
          }

        } catch (error) {
          const errorMsg = `Error scraping page ${currentPage}: ${error instanceof Error ? error.message : 'Unknown error'}`;
          console.error(errorMsg);
          result.errors.push(errorMsg);

          // Try to continue with next page if we have a pattern
          if (currentUrl) {
            currentUrl = this.generateNextPageUrl(currentUrl, currentPage);
            currentPage++;
          } else {
            break;
          }
        }
      }

    } catch (error) {
      const errorMsg = `Fatal pagination error: ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error(errorMsg);
      result.errors.push(errorMsg);
    }

    result.executionTime = Date.now() - startTime;

    console.log(`Pagination complete: ${result.pagesScraped} pages, ${result.listings.length} listings, ${result.errors.length} errors`);

    return result;
  }

  async scrapePagesSequentially(
    page: Page,
    urls: string[],
    config: PaginationConfig = {}
  ): Promise<PaginationResult> {
    const startTime = Date.now();
    const result: PaginationResult = {
      totalResults: 0,
      totalPages: urls.length,
      pagesScraped: 0,
      listings: [],
      errors: [],
      executionTime: 0,
    };

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];

      try {
        console.log(`Scraping page ${i + 1}/${urls.length}: ${url}`);

        // Rate limiting
        await this.rateLimiter.wait();
        await this.rateLimiter.randomDelay();

        // Navigate to page
        await page.goto(url, { waitUntil: 'networkidle' });

        const pageHtml = await page.content();
        const pageResults = this.searchExtractor.extractSearchResults(pageHtml, url);

        // Add listings from this page
        result.listings.push(...pageResults.listings);
        result.pagesScraped++;

        if (i === 0) {
          result.totalResults = pageResults.totalResults;
        }

        console.log(`Page ${i + 1}: Found ${pageResults.listings.length} listings`);

        // Call page completed callback
        if (config.onPageCompleted) {
          await config.onPageCompleted(pageResults);
        }

        // Update progress
        if (config.onProgress) {
          config.onProgress(i + 1, urls.length, result.listings.length);
        }

        // Check if we should stop due to max results
        if (config.maxResults && result.listings.length >= config.maxResults) {
          console.log(`Reached max results limit: ${config.maxResults}`);
          break;
        }

      } catch (error) {
        const errorMsg = `Error scraping page ${i + 1} (${url}): ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(errorMsg);
        result.errors.push(errorMsg);
      }
    }

    result.executionTime = Date.now() - startTime;

    console.log(`Sequential scraping complete: ${result.pagesScraped} pages, ${result.listings.length} listings, ${result.errors.length} errors`);

    return result;
  }

  generatePageUrls(baseUrl: string, totalPages: number, startPage: number = 1): string[] {
    const urls: string[] = [];

    for (let page = startPage; page <= totalPages; page++) {
      try {
        const url = new URL(baseUrl);
        url.searchParams.set('page', page.toString());
        urls.push(url.toString());
      } catch (error) {
        console.error(`Error generating URL for page ${page}:`, error);
      }
    }

    return urls;
  }

  async estimateTimeToComplete(
    totalPages: number,
    averageDelayMs: number = 3000
  ): Promise<{
    estimatedMinutes: number;
    estimatedHours: number;
    estimatedDuration: string;
  }> {
    const totalTimeMs = totalPages * (averageDelayMs + 2000); // Add 2s for processing
    const estimatedMinutes = Math.ceil(totalTimeMs / (1000 * 60));
    const estimatedHours = Math.round((estimatedMinutes / 60) * 10) / 10;

    let estimatedDuration: string;
    if (estimatedMinutes < 60) {
      estimatedDuration = `${estimatedMinutes} minutes`;
    } else if (estimatedHours < 24) {
      const hours = Math.floor(estimatedHours);
      const mins = estimatedMinutes % 60;
      estimatedDuration = `${hours}h ${mins}m`;
    } else {
      const days = Math.floor(estimatedHours / 24);
      const hours = Math.floor(estimatedHours % 24);
      estimatedDuration = `${days}d ${hours}h`;
    }

    return {
      estimatedMinutes,
      estimatedHours,
      estimatedDuration,
    };
  }

  private calculateMaxPages(config: PaginationConfig, result: PaginationResult): number {
    let maxPages = result.totalPages;

    // Apply max pages limit
    if (config.maxPages && config.maxPages < maxPages) {
      maxPages = config.maxPages;
    }

    // Apply max results limit (estimate pages needed)
    if (config.maxResults && result.listings.length > 0) {
      const avgResultsPerPage = result.listings.length; // First page results
      const pagesNeededForMaxResults = Math.ceil(config.maxResults / avgResultsPerPage);
      if (pagesNeededForMaxResults < maxPages) {
        maxPages = pagesNeededForMaxResults;
      }
    }

    return maxPages;
  }

  private generateNextPageUrl(currentUrl: string, nextPageNumber: number): string {
    try {
      const url = new URL(currentUrl);
      url.searchParams.set('page', nextPageNumber.toString());
      return url.toString();
    } catch {
      return currentUrl;
    }
  }

  async waitForPageLoad(page: Page, timeout: number = 30000): Promise<boolean> {
    try {
      await page.waitForLoadState('networkidle', { timeout });
      return true;
    } catch (error) {
      console.warn('Page load timeout:', error);
      return false;
    }
  }

  async checkForCaptcha(page: Page): Promise<boolean> {
    const captchaSelectors = [
      '[data-testid="captcha"]',
      '.captcha',
      '#captcha',
      '.recaptcha',
      'iframe[src*="recaptcha"]',
    ];

    for (const selector of captchaSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          console.warn('Captcha detected on page');
          return true;
        }
      } catch {
        // Ignore selector errors
      }
    }

    return false;
  }

  async handleBlockedAccess(page: Page): Promise<boolean> {
    const blockSelectors = [
      '[data-testid="blocked"]',
      '.blocked',
      '.access-denied',
      'h1:has-text("Access Denied")',
      'h1:has-text("Blocked")',
    ];

    for (const selector of blockSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          console.warn('Access blocked detected');
          return true;
        }
      } catch {
        // Ignore selector errors
      }
    }

    // Check for common blocked status codes in page content
    const pageText = await page.textContent('body') || '';
    const blockedPatterns = [
      /access denied/i,
      /blocked/i,
      /403 forbidden/i,
      /rate limit/i,
      /too many requests/i,
    ];

    return blockedPatterns.some(pattern => pattern.test(pageText));
  }
}