import * as cheerio from 'cheerio';
import { ListingExtractor, RawListingData } from './listing-extractor';

export interface SearchResults {
  listings: RawListingData[];
  totalResults: number;
  currentPage: number;
  totalPages: number;
  hasNextPage: boolean;
  nextPageUrl?: string;
  resultsPerPage: number;
}

export class SearchExtractor {
  private listingExtractor: ListingExtractor;

  constructor() {
    this.listingExtractor = new ListingExtractor();
  }

  extractSearchResults(html: string, currentUrl: string): SearchResults {
    const $ = cheerio.load(html);

    const results: SearchResults = {
      listings: [],
      totalResults: 0,
      currentPage: 1,
      totalPages: 1,
      hasNextPage: false,
      resultsPerPage: 0,
    };

    try {
      // Extract individual listings
      results.listings = this.extractListings($);
      results.resultsPerPage = results.listings.length;

      // Extract pagination info
      const paginationInfo = this.extractPaginationInfo($);
      Object.assign(results, paginationInfo);

      // Extract next page URL
      results.nextPageUrl = this.extractNextPageUrl($, currentUrl);
      results.hasNextPage = !!results.nextPageUrl && results.currentPage < results.totalPages;

    } catch (error) {
      console.error('Error extracting search results:', error);
    }

    return results;
  }

  private extractListings($: cheerio.CheerioAPI): RawListingData[] {
    const listings: RawListingData[] = [];

    // Common selectors for listing containers on BizBuySell
    const listingSelectors = [
      '.listing-item',
      '.search-result',
      '.business-listing',
      '.listing-card',
      '.result-item',
      '[data-testid="listing-item"]',
    ];

    for (const selector of listingSelectors) {
      const elements = $(selector);
      if (elements.length > 0) {
        elements.each((_, element) => {
          const listing = this.listingExtractor.extractFromSearchResult($(element));
          if (listing.title || listing.url) {
            listings.push(listing);
          }
        });
        break; // Found listings with one selector, no need to try others
      }
    }

    // Fallback: try to find listings in common patterns
    if (listings.length === 0) {
      listings.push(...this.extractListingsFallback($));
    }

    return listings;
  }

  private extractListingsFallback($: cheerio.CheerioAPI): RawListingData[] {
    const listings: RawListingData[] = [];

    // Look for links to business pages
    $('a[href*="/business/"], a[href*="/listing/"]').each((_, element) => {
      const $element = $(element);
      const url = $element.attr('href');

      if (url && this.isValidListingUrl(url)) {
        const listing: RawListingData = {
          url: url.startsWith('http') ? url : `https://www.bizbuysell.com${url}`,
          title: this.cleanText($element.text()) || undefined,
        };

        // Try to extract additional info from parent container
        const container = $element.closest('div, article, section').first();
        if (container.length) {
          const containerData = this.extractDataFromContainer(container);
          Object.assign(listing, containerData);
        }

        if (listing.title || listing.url) {
          listings.push(listing);
        }
      }
    });

    return listings;
  }

  private extractDataFromContainer(container: cheerio.Cheerio<cheerio.Element>): Partial<RawListingData> {
    const $ = cheerio.load(container);
    const data: Partial<RawListingData> = {};

    // Extract price information
    const priceText = container.find('.price, .asking-price, [class*="price"]').first().text();
    if (priceText && /\$[\d,]+/.test(priceText)) {
      data.askingPrice = this.cleanPriceText(priceText);
    }

    // Extract location information
    const locationText = container.find('.location, [class*="location"], .city-state').first().text();
    if (locationText && locationText.trim()) {
      data.location = this.cleanText(locationText);
    }

    // Extract industry/category information
    const industryText = container.find('.category, .industry, [class*="category"]').first().text();
    if (industryText && industryText.trim()) {
      data.industry = this.cleanText(industryText);
    }

    return data;
  }

  private extractPaginationInfo($: cheerio.CheerioAPI): Partial<SearchResults> {
    const info: Partial<SearchResults> = {
      totalResults: 0,
      currentPage: 1,
      totalPages: 1,
    };

    // Extract total results count
    const resultCountSelectors = [
      '.results-count',
      '.search-results-count',
      '[data-testid="results-count"]',
      '.total-results',
    ];

    for (const selector of resultCountSelectors) {
      const element = $(selector).first();
      if (element.length) {
        const text = element.text();
        const match = text.match(/(\d+(?:,\d+)*)/);
        if (match) {
          info.totalResults = parseInt(match[1].replace(/,/g, ''));
          break;
        }
      }
    }

    // Fallback: try to extract from page text
    if (info.totalResults === 0) {
      const pageText = $.text();
      const patterns = [
        /(\d+(?:,\d+)*)\s+(?:businesses?|results?|listings?)/i,
        /showing\s+\d+\s*-\s*\d+\s+of\s+(\d+(?:,\d+)*)/i,
        /(\d+(?:,\d+)*)\s+total/i,
      ];

      for (const pattern of patterns) {
        const match = pageText.match(pattern);
        if (match) {
          info.totalResults = parseInt(match[1].replace(/,/g, ''));
          break;
        }
      }
    }

    // Extract current page and total pages
    const paginationSelectors = [
      '.pagination',
      '.page-navigation',
      '[data-testid="pagination"]',
    ];

    for (const selector of paginationSelectors) {
      const pagination = $(selector).first();
      if (pagination.length) {
        // Current page
        const currentPageEl = pagination.find('.current, .active, [aria-current="page"]').first();
        if (currentPageEl.length) {
          const currentPageText = currentPageEl.text().trim();
          const currentPageNum = parseInt(currentPageText);
          if (!isNaN(currentPageNum)) {
            info.currentPage = currentPageNum;
          }
        }

        // Total pages - look for last page number
        const pageNumbers: number[] = [];
        pagination.find('a, span').each((_, element) => {
          const text = $(element).text().trim();
          const pageNum = parseInt(text);
          if (!isNaN(pageNum)) {
            pageNumbers.push(pageNum);
          }
        });

        if (pageNumbers.length > 0) {
          info.totalPages = Math.max(...pageNumbers);
        }
        break;
      }
    }

    // Calculate total pages from results and results per page
    if (info.totalPages === 1 && info.totalResults && info.totalResults > 20) {
      const estimatedResultsPerPage = 20; // Common default
      info.totalPages = Math.ceil(info.totalResults / estimatedResultsPerPage);
    }

    return info;
  }

  private extractNextPageUrl($: cheerio.CheerioAPI, currentUrl: string): string | undefined {
    // Look for next page link
    const nextPageSelectors = [
      '.pagination .next:not(.disabled) a',
      '.pagination a[rel="next"]',
      '.page-navigation .next a',
      'a[aria-label="Next page"]',
      'a:contains("Next")',
      'a:contains(">")',
    ];

    for (const selector of nextPageSelectors) {
      const element = $(selector).first();
      if (element.length) {
        const href = element.attr('href');
        if (href && !element.hasClass('disabled')) {
          return href.startsWith('http') ? href : `https://www.bizbuysell.com${href}`;
        }
      }
    }

    // Fallback: construct next page URL from current URL
    try {
      const url = new URL(currentUrl);
      const currentPage = parseInt(url.searchParams.get('page') || '1');
      url.searchParams.set('page', (currentPage + 1).toString());
      return url.toString();
    } catch {
      return undefined;
    }
  }

  extractTotalResultsCount(html: string): number {
    const $ = cheerio.load(html);

    const selectors = [
      '.results-count',
      '.search-results-count',
      '[data-testid="results-count"]',
      '.total-results',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) {
        const text = element.text();
        const match = text.match(/(\d+(?:,\d+)*)/);
        if (match) {
          return parseInt(match[1].replace(/,/g, ''));
        }
      }
    }

    // Fallback pattern matching
    const pageText = $.text();
    const patterns = [
      /(\d+(?:,\d+)*)\s+(?:businesses?|results?|listings?)/i,
      /showing\s+\d+\s*-\s*\d+\s+of\s+(\d+(?:,\d+)*)/i,
    ];

    for (const pattern of patterns) {
      const match = pageText.match(pattern);
      if (match) {
        return parseInt(match[1].replace(/,/g, ''));
      }
    }

    return 0;
  }

  private isValidListingUrl(url: string): boolean {
    const validPatterns = [
      /\/business\/\d+/,
      /\/listing\/\d+/,
      /\/\d+\/business/,
    ];

    return validPatterns.some(pattern => pattern.test(url));
  }

  private cleanText(text: string): string {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\n+/g, ' ')
      .trim();
  }

  private cleanPriceText(text: string): string {
    return text
      .replace(/[^\d,]/g, '')
      .replace(/,/g, '');
  }
}