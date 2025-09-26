import { z } from 'zod';
import { ScrapeFilters } from '@/types';
import { US_STATES, BUSINESS_INDUSTRIES, MAJOR_METROPOLITAN_AREAS } from '../../filters/constants';

// Get valid values from constants
const validStates = US_STATES.map(state => state.value);
const validIndustries = BUSINESS_INDUSTRIES.map(industry => industry.value);
const validCities = MAJOR_METROPOLITAN_AREAS.map(city => city.value);

const LocationSchema = z.object({
  states: z.array(z.enum(validStates as [string, ...string[]])).optional(),
  cities: z.array(z.enum(validCities as [string, ...string[]])).optional(),
}).refine(
  (data) => {
    // At least one location filter should be provided if location is specified
    return !data || data.states?.length || data.cities?.length;
  },
  { message: 'At least one state or city must be specified' }
);

const PriceRangeSchema = z.object({
  min: z.number().min(0).max(100000000).optional(),
  max: z.number().min(0).max(100000000).optional(),
}).refine(
  (data) => !data.min || !data.max || data.min <= data.max,
  { message: 'Minimum price must be less than or equal to maximum price' }
);

const RevenueRangeSchema = z.object({
  min: z.number().min(0).max(100000000).optional(),
  max: z.number().min(0).max(100000000).optional(),
}).refine(
  (data) => !data.min || !data.max || data.min <= data.max,
  { message: 'Minimum revenue must be less than or equal to maximum revenue' }
);

const CashFlowRangeSchema = z.object({
  min: z.number().min(-10000000).max(50000000).optional(),
  max: z.number().min(-10000000).max(50000000).optional(),
}).refine(
  (data) => !data.min || !data.max || data.min <= data.max,
  { message: 'Minimum cash flow must be less than or equal to maximum cash flow' }
);

const DateRangeSchema = z.object({
  from: z.date().optional(),
  to: z.date().optional(),
}).refine(
  (data) => !data.from || !data.to || data.from <= data.to,
  { message: 'From date must be before or equal to to date' }
);

const EstablishedRangeSchema = z.object({
  min: z.number().min(1800).max(new Date().getFullYear()).optional(),
  max: z.number().min(1800).max(new Date().getFullYear()).optional(),
}).refine(
  (data) => !data.min || !data.max || data.min <= data.max,
  { message: 'Minimum established year must be less than or equal to maximum established year' }
);

export const ScrapeFiltersSchema = z.object({
  location: LocationSchema.optional(),
  price: PriceRangeSchema.optional(),
  revenue: RevenueRangeSchema.optional(),
  cashFlow: CashFlowRangeSchema.optional(),
  industry: z.array(z.enum(validIndustries as [string, ...string[]])).max(10).optional(),
  listingDate: DateRangeSchema.optional(),
  sellerFinancing: z.boolean().optional(),
  established: EstablishedRangeSchema.optional(),
}).refine(
  (data) => {
    // At least one filter should be provided
    const hasFilter = Object.values(data).some(value =>
      value !== undefined && value !== null &&
      (typeof value !== 'object' || Object.keys(value).length > 0)
    );
    return hasFilter;
  },
  { message: 'At least one filter must be provided' }
);

export class FilterValidator {
  static validate(filters: unknown): ScrapeFilters {
    try {
      const parsed = ScrapeFiltersSchema.parse(filters);
      return this.applyBusinessLogicValidation(parsed);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages = error.errors.map(err => `${err.path.join('.')}: ${err.message}`);
        throw new Error(`Invalid filters: ${errorMessages.join(', ')}`);
      }
      throw new Error(`Invalid filters: ${error}`);
    }
  }

  static validatePartial(filters: unknown): Partial<ScrapeFilters> {
    try {
      const partialSchema = ScrapeFiltersSchema.partial();
      const parsed = partialSchema.parse(filters);
      return this.applyBusinessLogicValidation(parsed);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages = error.errors.map(err => `${err.path.join('.')}: ${err.message}`);
        throw new Error(`Invalid filters: ${errorMessages.join(', ')}`);
      }
      throw new Error(`Invalid filters: ${error}`);
    }
  }

  static validateForScraping(filters: ScrapeFilters): {
    isValid: boolean;
    warnings: string[];
    errors: string[];
  } {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Check for overly broad filters that might result in too many results
    if (!filters.location && !filters.price && !filters.industry) {
      warnings.push('No location, price, or industry filters specified. This may result in a very large dataset.');
    }

    // Check price ranges
    if (filters.price) {
      if (!filters.price.max && !filters.price.min) {
        warnings.push('Price filter specified but no range provided.');
      }
      if (filters.price.max && filters.price.max > 50000000) {
        warnings.push('Very high price filter may have limited results.');
      }
    }

    // Check location specificity
    if (filters.location?.states && filters.location.states.length > 10) {
      warnings.push('Many states selected. Consider narrowing down your search.');
    }

    // Check industry count
    if (filters.industry && filters.industry.length > 5) {
      warnings.push('Many industries selected. Consider focusing on specific sectors.');
    }

    // Check date ranges
    if (filters.listingDate) {
      const daysDiff = filters.listingDate.to && filters.listingDate.from
        ? Math.abs(filters.listingDate.to.getTime() - filters.listingDate.from.getTime()) / (1000 * 60 * 60 * 24)
        : null;

      if (daysDiff && daysDiff > 365) {
        warnings.push('Date range spans more than a year. Consider narrowing the timeframe.');
      }
    }

    return {
      isValid: errors.length === 0,
      warnings,
      errors,
    };
  }

  private static applyBusinessLogicValidation(filters: Partial<ScrapeFilters>): any {
    // Business logic validations

    // Validate city-state relationships
    if (filters.location?.cities && filters.location?.states) {
      const validCitiesForStates = MAJOR_METROPOLITAN_AREAS
        .filter(city => filters.location?.states?.includes(city.state))
        .map(city => city.value);

      const invalidCities = filters.location.cities.filter(
        city => !validCitiesForStates.includes(city)
      );

      if (invalidCities.length > 0) {
        throw new Error(`Cities ${invalidCities.join(', ')} are not valid for the selected states`);
      }
    }

    // Validate price vs revenue logic
    if (filters.price?.min && filters.revenue?.max && filters.price.min > filters.revenue.max * 10) {
      console.warn('Warning: Asking price minimum is much higher than revenue maximum. This may limit results.');
    }

    // Validate cash flow vs revenue logic
    if (filters.cashFlow?.min && filters.revenue?.max && filters.cashFlow.min > filters.revenue.max * 0.5) {
      console.warn('Warning: Cash flow minimum is unusually high compared to revenue maximum.');
    }

    return filters;
  }

  static getValidationSchema() {
    return {
      states: validStates,
      cities: validCities,
      industries: validIndustries,
      priceRange: { min: 0, max: 100000000 },
      revenueRange: { min: 0, max: 100000000 },
      cashFlowRange: { min: -10000000, max: 50000000 },
      establishedRange: { min: 1800, max: new Date().getFullYear() },
    };
  }

  static sanitizeFilters(filters: ScrapeFilters): ScrapeFilters {
    const sanitized: ScrapeFilters = {};

    if (filters.location) {
      sanitized.location = {};
      if (filters.location.states?.length) {
        sanitized.location.states = filters.location.states
          .filter(state => state.trim().length > 0)
          .map(state => state.trim());
      }
      if (filters.location.cities?.length) {
        sanitized.location.cities = filters.location.cities
          .filter(city => city.trim().length > 0)
          .map(city => city.trim());
      }
    }

    if (filters.price) {
      sanitized.price = {};
      if (filters.price.min !== undefined && filters.price.min >= 0) {
        sanitized.price.min = Math.max(0, filters.price.min);
      }
      if (filters.price.max !== undefined && filters.price.max >= 0) {
        sanitized.price.max = Math.max(0, filters.price.max);
      }

      if (sanitized.price.min && sanitized.price.max && sanitized.price.min > sanitized.price.max) {
        [sanitized.price.min, sanitized.price.max] = [sanitized.price.max, sanitized.price.min];
      }
    }

    if (filters.revenue) {
      sanitized.revenue = this.sanitizeRange(filters.revenue);
    }

    if (filters.cashFlow) {
      sanitized.cashFlow = this.sanitizeRange(filters.cashFlow);
    }

    if (filters.industry?.length) {
      sanitized.industry = filters.industry
        .filter(industry => industry.trim().length > 0)
        .map(industry => industry.trim());
    }

    if (filters.sellerFinancing !== undefined) {
      sanitized.sellerFinancing = Boolean(filters.sellerFinancing);
    }

    if (filters.established) {
      sanitized.established = this.sanitizeRange(filters.established, 1800, new Date().getFullYear());
    }

    return sanitized;
  }

  private static sanitizeRange(range: { min?: number; max?: number }, minValue: number = 0, maxValue?: number): { min?: number; max?: number } {
    const sanitized: { min?: number; max?: number } = {};

    if (range.min !== undefined && range.min >= minValue) {
      sanitized.min = Math.max(minValue, range.min);
      if (maxValue !== undefined) {
        sanitized.min = Math.min(maxValue, sanitized.min);
      }
    }

    if (range.max !== undefined && range.max >= minValue) {
      sanitized.max = Math.max(minValue, range.max);
      if (maxValue !== undefined) {
        sanitized.max = Math.min(maxValue, sanitized.max);
      }
    }

    if (sanitized.min && sanitized.max && sanitized.min > sanitized.max) {
      [sanitized.min, sanitized.max] = [sanitized.max, sanitized.min];
    }

    return sanitized;
  }
}