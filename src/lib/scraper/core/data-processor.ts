import { z } from 'zod';
import { BusinessListing } from '@/types';
import { RawListingData } from '../extractors/listing-extractor';

export interface ProcessingResult {
  success: boolean;
  data?: BusinessListing;
  errors: string[];
  warnings: string[];
  originalData: RawListingData;
}

export interface ProcessingStats {
  totalProcessed: number;
  successful: number;
  failed: number;
  warnings: number;
  duplicates: number;
}

export class DataProcessor {
  private seenListingIds = new Set<string>();
  private stats: ProcessingStats = {
    totalProcessed: 0,
    successful: 0,
    failed: 0,
    warnings: 0,
    duplicates: 0,
  };

  processListing(rawData: RawListingData): ProcessingResult {
    this.stats.totalProcessed++;

    const result: ProcessingResult = {
      success: false,
      errors: [],
      warnings: [],
      originalData: rawData,
    };

    try {
      // Check for duplicate
      if (rawData.listingId && this.seenListingIds.has(rawData.listingId)) {
        this.stats.duplicates++;
        result.errors.push('Duplicate listing ID detected');
        return result;
      }

      // Validate and clean the data
      const cleanedData = this.cleanRawData(rawData);
      const validationResult = this.validateData(cleanedData);

      if (validationResult.isValid) {
        result.data = validationResult.data;
        result.success = true;
        this.stats.successful++;

        // Track this listing ID
        if (result.data.bizBuySellId) {
          this.seenListingIds.add(result.data.bizBuySellId);
        }
      } else {
        result.errors = validationResult.errors;
        this.stats.failed++;
      }

      result.warnings = validationResult.warnings;
      if (result.warnings.length > 0) {
        this.stats.warnings++;
      }

    } catch (error) {
      result.errors.push(`Processing error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      this.stats.failed++;
    }

    return result;
  }

  private cleanRawData(raw: RawListingData): Partial<BusinessListing> {
    const cleaned: Partial<BusinessListing> = {};

    // Clean and validate required fields
    if (raw.title?.trim()) {
      cleaned.title = this.cleanTitle(raw.title);
    }

    if (raw.listingId) {
      cleaned.bizBuySellId = this.cleanListingId(raw.listingId);
    } else if (raw.url) {
      // Try to extract ID from URL
      const idFromUrl = this.extractIdFromUrl(raw.url);
      if (idFromUrl) {
        cleaned.bizBuySellId = idFromUrl;
      }
    }

    // Clean financial data
    if (raw.askingPrice) {
      cleaned.askingPrice = this.parsePrice(raw.askingPrice);
    }

    if (raw.revenue) {
      cleaned.revenue = this.parsePrice(raw.revenue);
    }

    if (raw.cashFlow) {
      cleaned.cashFlow = this.parsePrice(raw.cashFlow);
    }

    // Clean location data
    if (raw.location?.trim()) {
      const locationData = this.parseLocation(raw.location);
      cleaned.location = locationData.full;
      cleaned.state = locationData.state;
      cleaned.city = locationData.city;
    }

    // Clean industry
    if (raw.industry?.trim()) {
      cleaned.industry = this.cleanIndustry(raw.industry);
    }

    // Clean description
    if (raw.description?.trim()) {
      cleaned.description = this.cleanDescription(raw.description);
    }

    // Clean date
    if (raw.listedDate) {
      cleaned.listedDate = this.parseDate(raw.listedDate);
    }

    // Clean numeric fields
    if (raw.established) {
      cleaned.established = this.parseYear(raw.established);
    }

    if (raw.employees) {
      cleaned.employees = this.parseNumber(raw.employees);
    }

    // Clean features
    if (raw.features && raw.features.length > 0) {
      cleaned.features = this.cleanFeatures(raw.features);
    }

    // Clean images
    if (raw.images && raw.images.length > 0) {
      cleaned.imageUrls = this.cleanImageUrls(raw.images);
    }

    // Extract seller financing from features or text
    cleaned.sellerFinancing = this.extractSellerFinancing(raw);

    // Set URL if available
    if (raw.url) {
      cleaned.listingUrl = raw.url;
    }

    return cleaned;
  }

  private validateData(data: Partial<BusinessListing>): {
    isValid: boolean;
    data?: BusinessListing;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required field validation
    if (!data.title) {
      errors.push('Title is required');
    }

    if (!data.bizBuySellId) {
      errors.push('Listing ID is required');
    }

    if (!data.location) {
      errors.push('Location is required');
    }

    if (!data.industry) {
      warnings.push('Industry not specified');
    }

    if (!data.description) {
      warnings.push('Description not available');
    }

    // Business logic validation
    if (data.askingPrice && data.askingPrice < 0) {
      errors.push('Asking price cannot be negative');
    }

    if (data.revenue && data.revenue < 0) {
      warnings.push('Revenue is negative');
    }

    if (data.askingPrice && data.revenue && data.askingPrice > data.revenue * 20) {
      warnings.push('Asking price seems unusually high compared to revenue');
    }

    if (data.cashFlow && data.revenue && data.cashFlow > data.revenue) {
      warnings.push('Cash flow higher than revenue (unusual)');
    }

    if (data.established && (data.established < 1800 || data.established > new Date().getFullYear())) {
      warnings.push(`Established year ${data.established} seems unrealistic`);
    }

    if (data.employees && data.employees > 10000) {
      warnings.push(`Employee count ${data.employees} seems unusually high`);
    }

    // Return validation result
    if (errors.length === 0) {
      // Set defaults for missing fields
      const businessListing: BusinessListing = {
        title: data.title!,
        bizBuySellId: data.bizBuySellId!,
        location: data.location!,
        state: data.state || this.extractStateFromLocation(data.location!),
        industry: data.industry || 'other',
        description: data.description || '',
        listedDate: data.listedDate || new Date(),
        askingPrice: data.askingPrice,
        revenue: data.revenue,
        cashFlow: data.cashFlow,
        city: data.city,
        sellerFinancing: data.sellerFinancing || false,
        employees: data.employees,
        established: data.established,
        features: data.features || [],
        imageUrls: data.imageUrls || [],
        contactName: undefined,
        contactEmail: undefined,
        contactPhone: undefined,
        brokerName: undefined,
        brokerCompany: undefined,
        listingUrl: data.listingUrl,
        reasonForSelling: undefined,
      };

      return {
        isValid: true,
        data: businessListing,
        errors: [],
        warnings,
      };
    }

    return {
      isValid: false,
      errors,
      warnings,
    };
  }

  private cleanTitle(title: string): string {
    return title
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/^[^\w]+|[^\w]+$/g, '') // Remove leading/trailing non-word chars
      .substring(0, 200); // Limit length
  }

  private cleanListingId(id: string): string {
    return id.replace(/[^\w-]/g, '').toUpperCase();
  }

  private extractIdFromUrl(url: string): string | undefined {
    const patterns = [
      /\/business\/(\d+)-/,
      /\/listing\/(\d+)/,
      /\/(\d+)\/business/,
      /id=(\d+)/,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        return `BBS${match[1]}`;
      }
    }

    return undefined;
  }

  private parsePrice(priceStr: string): number | undefined {
    const cleaned = priceStr.replace(/[^\d.]/g, '');
    const price = parseFloat(cleaned);
    return isNaN(price) ? undefined : price;
  }

  private parseLocation(location: string): {
    full: string;
    city?: string;
    state?: string;
  } {
    const cleaned = location.trim();
    const parts = cleaned.split(',').map(p => p.trim());

    let city: string | undefined;
    let state: string | undefined;

    if (parts.length >= 2) {
      city = parts[0];
      const statePart = parts[parts.length - 1];

      // Extract state (look for 2-letter state codes)
      const stateMatch = statePart.match(/\b([A-Z]{2})\b/);
      if (stateMatch) {
        state = stateMatch[1];
      }
    }

    return {
      full: cleaned,
      city,
      state,
    };
  }

  private cleanIndustry(industry: string): string {
    const cleaned = industry
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');

    // Map common variations to standard industry codes
    const industryMap: Record<string, string> = {
      'restaurant': 'restaurants',
      'restaurants': 'restaurants',
      'food-service': 'restaurants',
      'automotive': 'automotive',
      'auto': 'automotive',
      'retail': 'retail',
      'healthcare': 'healthcare-medical',
      'medical': 'healthcare-medical',
      'technology': 'internet-technology',
      'tech': 'internet-technology',
      'it': 'internet-technology',
      'construction': 'construction',
      'manufacturing': 'manufacturing',
      'real-estate': 'real-estate',
      'realty': 'real-estate',
      'business-services': 'business-services',
      'services': 'business-services',
    };

    return industryMap[cleaned] || cleaned;
  }

  private cleanDescription(description: string): string {
    return description
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\n+/g, ' ')
      .substring(0, 2000); // Limit length
  }

  private parseDate(dateStr: string): Date {
    // Try different date formats
    const formats = [
      /(\w+)\s+(\d+),?\s+(\d{4})/, // "January 15, 2024"
      /(\d{1,2})\/(\d{1,2})\/(\d{4})/, // "01/15/2024"
      /(\d{4})-(\d{1,2})-(\d{1,2})/, // "2024-01-15"
    ];

    for (const format of formats) {
      const match = dateStr.match(format);
      if (match) {
        const date = new Date(dateStr);
        if (!isNaN(date.getTime())) {
          return date;
        }
      }
    }

    // Fallback to current date
    return new Date();
  }

  private parseYear(yearStr: string): number | undefined {
    const year = parseInt(yearStr.replace(/[^\d]/g, ''));
    return (year >= 1800 && year <= new Date().getFullYear()) ? year : undefined;
  }

  private parseNumber(numStr: string): number | undefined {
    const num = parseInt(numStr.replace(/[^\d]/g, ''));
    return isNaN(num) ? undefined : num;
  }

  private cleanFeatures(features: string[]): string[] {
    const cleaned = features
      .map(f => f.trim().toLowerCase())
      .filter(f => f.length > 0)
      .filter(f => f.length < 100); // Remove overly long features

    // Standardize common features
    const featureMap: Record<string, string> = {
      'seller financing': 'seller-financing',
      'owner financing': 'seller-financing',
      'real estate included': 'real-estate-included',
      'franchise': 'franchise',
      'absentee owned': 'absentee-owned',
      'management stays': 'management-stays',
      'home based': 'home-based',
    };

    return cleaned.map(feature => featureMap[feature] || feature);
  }

  private cleanImageUrls(images: string[]): string[] {
    return images
      .filter(url => url && url.startsWith('http'))
      .filter(url => /\.(jpg|jpeg|png|gif|webp)$/i.test(url))
      .slice(0, 20); // Limit number of images
  }

  private extractSellerFinancing(raw: RawListingData): boolean {
    const sources = [
      raw.features?.join(' ') || '',
      raw.description || '',
      raw.title || '',
    ].join(' ').toLowerCase();

    return /seller\s+financing|owner\s+financing/.test(sources);
  }

  private extractStateFromLocation(location: string): string {
    const stateMatch = location.match(/\b([A-Z]{2})\b/);
    return stateMatch ? stateMatch[1] : 'unknown';
  }

  getStats(): ProcessingStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      totalProcessed: 0,
      successful: 0,
      failed: 0,
      warnings: 0,
      duplicates: 0,
    };
    this.seenListingIds.clear();
  }

  async processBatch(rawListings: RawListingData[]): Promise<{
    successful: BusinessListing[];
    failed: ProcessingResult[];
    stats: ProcessingStats;
  }> {
    const successful: BusinessListing[] = [];
    const failed: ProcessingResult[] = [];

    for (const rawListing of rawListings) {
      const result = this.processListing(rawListing);

      if (result.success && result.data) {
        successful.push(result.data);
      } else {
        failed.push(result);
      }
    }

    return {
      successful,
      failed,
      stats: this.getStats(),
    };
  }
}