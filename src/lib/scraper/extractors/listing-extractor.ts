import * as cheerio from 'cheerio';
import { BusinessListing } from '@/types';

export interface RawListingData {
  title?: string;
  askingPrice?: string;
  revenue?: string;
  cashFlow?: string;
  location?: string;
  industry?: string;
  description?: string;
  listedDate?: string;
  established?: string;
  employees?: string;
  features?: string[];
  images?: string[];
  contactInfo?: {
    name?: string;
    email?: string;
    phone?: string;
  };
  brokerInfo?: {
    name?: string;
    company?: string;
  };
  listingId?: string;
  url?: string;
}

export class ListingExtractor {

  extractFromDetailPage(html: string, url: string): RawListingData {
    const $ = cheerio.load(html);
    const data: RawListingData = { url };

    try {
      // Extract basic listing information
      data.title = this.extractTitle($);
      data.askingPrice = this.extractAskingPrice($);
      data.revenue = this.extractRevenue($);
      data.cashFlow = this.extractCashFlow($);
      data.location = this.extractLocation($);
      data.industry = this.extractIndustry($);
      data.description = this.extractDescription($);
      data.listedDate = this.extractListedDate($);
      data.established = this.extractEstablished($);
      data.employees = this.extractEmployees($);
      data.features = this.extractFeatures($);
      data.images = this.extractImages($);
      data.contactInfo = this.extractContactInfo($);
      data.brokerInfo = this.extractBrokerInfo($);
      data.listingId = this.extractListingId($, url);

    } catch (error) {
      console.warn('Error extracting listing data:', error);
    }

    return data;
  }

  extractFromSearchResult(element: cheerio.Cheerio<cheerio.Element>): RawListingData {
    const $ = cheerio.load(element);
    const data: RawListingData = {};

    try {
      // Extract basic info from search results
      data.title = this.extractTitleFromSearchResult($);
      data.askingPrice = this.extractPriceFromSearchResult($);
      data.location = this.extractLocationFromSearchResult($);
      data.industry = this.extractIndustryFromSearchResult($);
      data.url = this.extractUrlFromSearchResult($);
      data.listingId = this.extractListingIdFromUrl(data.url);

    } catch (error) {
      console.warn('Error extracting search result data:', error);
    }

    return data;
  }

  private extractTitle($: cheerio.CheerioAPI): string | undefined {
    // Common BizBuySell title selectors
    const selectors = [
      'h1.listing-title',
      'h1[data-testid="listing-title"]',
      '.listing-header h1',
      'h1.business-title',
      '.title h1',
      'h1',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        return this.cleanText(element.text());
      }
    }

    return undefined;
  }

  private extractAskingPrice($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '.asking-price .price-value',
      '[data-testid="asking-price"]',
      '.price-asking .value',
      '.listing-price',
      '.price .amount',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        return this.cleanPriceText(element.text());
      }
    }

    // Look for price in text patterns
    const pricePattern = /asking[:\s]*\$?([0-9,]+)/i;
    const pageText = $.text();
    const match = pageText.match(pricePattern);
    if (match) {
      return match[1].replace(/,/g, '');
    }

    return undefined;
  }

  private extractRevenue($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '[data-testid="revenue"]',
      '.revenue .value',
      '.gross-revenue',
      '.annual-revenue',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        return this.cleanPriceText(element.text());
      }
    }

    // Pattern matching for revenue
    const revenuePattern = /(?:gross\s+revenue|annual\s+revenue|revenue)[:\s]*\$?([0-9,]+)/i;
    const pageText = $.text();
    const match = pageText.match(revenuePattern);
    if (match) {
      return match[1].replace(/,/g, '');
    }

    return undefined;
  }

  private extractCashFlow($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '[data-testid="cash-flow"]',
      '.cash-flow .value',
      '.net-income',
      '.annual-cash-flow',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        return this.cleanPriceText(element.text());
      }
    }

    // Pattern matching for cash flow
    const cashFlowPattern = /(?:cash\s+flow|net\s+income)[:\s]*\$?([0-9,]+)/i;
    const pageText = $.text();
    const match = pageText.match(cashFlowPattern);
    if (match) {
      return match[1].replace(/,/g, '');
    }

    return undefined;
  }

  private extractLocation($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '.location',
      '[data-testid="location"]',
      '.listing-location',
      '.business-location',
      '.address .city-state',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        return this.cleanText(element.text());
      }
    }

    return undefined;
  }

  private extractIndustry($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '.industry',
      '[data-testid="industry"]',
      '.business-type',
      '.category',
      '.listing-category',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        return this.cleanText(element.text());
      }
    }

    return undefined;
  }

  private extractDescription($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '.listing-description',
      '[data-testid="description"]',
      '.business-description',
      '.description-content',
      '.listing-details p',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        return this.cleanText(element.text());
      }
    }

    return undefined;
  }

  private extractListedDate($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '.listed-date',
      '[data-testid="listed-date"]',
      '.date-listed',
      '.listing-date',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        return this.cleanText(element.text());
      }
    }

    // Pattern matching for date
    const datePattern = /listed[:\s]*([a-z]+\s+\d+,?\s+\d+)/i;
    const pageText = $.text();
    const match = pageText.match(datePattern);
    if (match) {
      return match[1];
    }

    return undefined;
  }

  private extractEstablished($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '.established',
      '[data-testid="established"]',
      '.year-established',
      '.business-established',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        const text = element.text();
        const yearMatch = text.match(/(\d{4})/);
        return yearMatch ? yearMatch[1] : undefined;
      }
    }

    // Pattern matching for established year
    const establishedPattern = /established[:\s]*(\d{4})/i;
    const pageText = $.text();
    const match = pageText.match(establishedPattern);
    if (match) {
      return match[1];
    }

    return undefined;
  }

  private extractEmployees($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '.employees',
      '[data-testid="employees"]',
      '.staff-count',
      '.employee-count',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        const text = element.text();
        const numberMatch = text.match(/(\d+)/);
        return numberMatch ? numberMatch[1] : undefined;
      }
    }

    // Pattern matching for employee count
    const employeePattern = /(\d+)\s+employees?/i;
    const pageText = $.text();
    const match = pageText.match(employeePattern);
    if (match) {
      return match[1];
    }

    return undefined;
  }

  private extractFeatures($: cheerio.CheerioAPI): string[] {
    const features: string[] = [];
    const selectors = [
      '.features li',
      '.business-features li',
      '.listing-features .feature',
      '.amenities li',
    ];

    for (const selector of selectors) {
      $(selector).each((_, element) => {
        const text = this.cleanText($(element).text());
        if (text) {
          features.push(text);
        }
      });
    }

    // Check for common features in text
    const featurePatterns = [
      /seller financing/i,
      /franchise/i,
      /real estate included/i,
      /absentee owned/i,
      /home based/i,
      /management stays/i,
    ];

    const pageText = $.text().toLowerCase();
    featurePatterns.forEach((pattern) => {
      if (pattern.test(pageText)) {
        const match = pageText.match(pattern);
        if (match && !features.some(f => f.toLowerCase().includes(match[0]))) {
          features.push(match[0]);
        }
      }
    });

    return features;
  }

  private extractImages($: cheerio.CheerioAPI): string[] {
    const images: string[] = [];
    const selectors = [
      '.listing-images img',
      '.business-photos img',
      '.gallery img',
      '.photo-gallery img',
    ];

    for (const selector of selectors) {
      $(selector).each((_, element) => {
        const src = $(element).attr('src');
        if (src && !src.startsWith('data:')) {
          // Convert relative URLs to absolute
          const imageUrl = src.startsWith('http') ? src : `https://www.bizbuysell.com${src}`;
          if (!images.includes(imageUrl)) {
            images.push(imageUrl);
          }
        }
      });
    }

    return images;
  }

  private extractContactInfo($: cheerio.CheerioAPI): RawListingData['contactInfo'] {
    const contact: RawListingData['contactInfo'] = {};

    // Extract contact name
    const nameSelectors = ['.contact-name', '.seller-name', '.contact-info .name'];
    for (const selector of nameSelectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        contact.name = this.cleanText(element.text());
        break;
      }
    }

    // Extract email
    const emailSelectors = ['a[href^="mailto:"]'];
    for (const selector of emailSelectors) {
      const element = $(selector).first();
      if (element.length) {
        const href = element.attr('href');
        if (href) {
          contact.email = href.replace('mailto:', '');
          break;
        }
      }
    }

    // Extract phone
    const phoneSelectors = ['.contact-phone', '.phone', 'a[href^="tel:"]'];
    for (const selector of phoneSelectors) {
      const element = $(selector).first();
      if (element.length) {
        const text = element.text().trim();
        const href = element.attr('href');
        contact.phone = href ? href.replace('tel:', '') : text;
        if (contact.phone) break;
      }
    }

    return Object.keys(contact).length > 0 ? contact : undefined;
  }

  private extractBrokerInfo($: cheerio.CheerioAPI): RawListingData['brokerInfo'] {
    const broker: RawListingData['brokerInfo'] = {};

    // Extract broker name
    const nameSelectors = ['.broker-name', '.agent-name', '.broker-contact .name'];
    for (const selector of nameSelectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        broker.name = this.cleanText(element.text());
        break;
      }
    }

    // Extract broker company
    const companySelectors = ['.broker-company', '.agency-name', '.brokerage'];
    for (const selector of companySelectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        broker.company = this.cleanText(element.text());
        break;
      }
    }

    return Object.keys(broker).length > 0 ? broker : undefined;
  }

  private extractListingId($: cheerio.CheerioAPI, url?: string): string | undefined {
    if (url) {
      return this.extractListingIdFromUrl(url);
    }

    // Try to extract from page elements
    const idSelectors = [
      '[data-listing-id]',
      '.listing-id',
      '#listing-id',
    ];

    for (const selector of idSelectors) {
      const element = $(selector).first();
      if (element.length) {
        const id = element.attr('data-listing-id') || element.text().trim();
        if (id) return id;
      }
    }

    return undefined;
  }

  private extractListingIdFromUrl(url?: string): string | undefined {
    if (!url) return undefined;

    // Extract ID from common BizBuySell URL patterns
    const patterns = [
      /\/business\/(\d+)-/,
      /\/listing\/(\d+)/,
      /\/(\d+)\/business/,
      /id=(\d+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return undefined;
  }

  // Search result extractors
  private extractTitleFromSearchResult($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '.listing-title a',
      '.business-title',
      'h3 a',
      '.result-title',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        return this.cleanText(element.text());
      }
    }

    return undefined;
  }

  private extractPriceFromSearchResult($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '.price',
      '.asking-price',
      '.listing-price',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        return this.cleanPriceText(element.text());
      }
    }

    return undefined;
  }

  private extractLocationFromSearchResult($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '.location',
      '.listing-location',
      '.city-state',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        return this.cleanText(element.text());
      }
    }

    return undefined;
  }

  private extractIndustryFromSearchResult($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '.industry',
      '.category',
      '.business-type',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length && element.text().trim()) {
        return this.cleanText(element.text());
      }
    }

    return undefined;
  }

  private extractUrlFromSearchResult($: cheerio.CheerioAPI): string | undefined {
    const selectors = [
      '.listing-title a',
      'h3 a',
      '.result-title a',
      'a[href*="/business/"]',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) {
        const href = element.attr('href');
        if (href) {
          return href.startsWith('http') ? href : `https://www.bizbuysell.com${href}`;
        }
      }
    }

    return undefined;
  }

  // Utility methods
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