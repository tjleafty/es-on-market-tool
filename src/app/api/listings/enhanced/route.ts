import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/database';
import { queryBuilder } from '@/lib/filters/query-builder';
import { FilterValidator } from '@/lib/scraper/filters/filter-validator';
import { filterManager } from '@/lib/filters/filter-manager';

const AdvancedSearchSchema = z.object({
  // Basic search parameters
  filters: z.record(z.any()).default({}),
  search: z.string().optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),

  // Sorting options
  sortBy: z.enum([
    'newest', 'oldest', 'price-low-high', 'price-high-low',
    'revenue-high-low', 'revenue-low-high', 'cash-flow-high-low',
    'cash-flow-low-high', 'title', 'location', 'relevance'
  ]).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),

  // Advanced options
  includeFacets: z.boolean().default(false),
  includeImages: z.boolean().default(false),
  includeContact: z.boolean().default(false),
  includeBroker: z.boolean().default(false),
  includeFeatures: z.boolean().default(true),
  includeAnalytics: z.boolean().default(false),

  // Range filters
  dateRange: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }).optional(),

  priceRange: z.object({
    min: z.number().min(0).optional(),
    max: z.number().min(0).optional(),
  }).optional(),

  revenueRange: z.object({
    min: z.number().min(0).optional(),
    max: z.number().min(0).optional(),
  }).optional(),

  cashFlowRange: z.object({
    min: z.number().optional(),
    max: z.number().optional(),
  }).optional(),

  employeeRange: z.object({
    min: z.number().min(0).optional(),
    max: z.number().min(0).optional(),
  }).optional(),

  establishedRange: z.object({
    min: z.number().min(1800).optional(),
    max: z.number().max(new Date().getFullYear()).optional(),
  }).optional(),

  // Specific filters
  industries: z.array(z.string()).optional(),
  states: z.array(z.string()).optional(),
  cities: z.array(z.string()).optional(),
  features: z.array(z.string()).optional(),
  hasImages: z.boolean().optional(),
  hasContactInfo: z.boolean().optional(),
  sellerFinancing: z.boolean().optional(),

  // Output format
  format: z.enum(['json', 'csv', 'excel']).default('json'),

  // Aggregation options
  groupBy: z.enum(['industry', 'state', 'city', 'priceRange', 'revenueRange']).optional(),
  includeStats: z.boolean().default(false),
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Parse complex query parameters
    const queryParams = parseSearchParams(searchParams);
    const validatedParams = AdvancedSearchSchema.parse(queryParams);

    const startTime = Date.now();

    // Build comprehensive where clause
    const where = await buildAdvancedWhere(validatedParams);

    // Build select clause based on inclusion options
    const select = buildSelectClause(validatedParams);

    // Build order by clause
    const orderBy = buildOrderByClause(validatedParams.sortBy, validatedParams.sortOrder);

    // Execute main query with proper pagination
    const [listings, totalCount, aggregatedStats] = await Promise.all([
      prisma.businessListing.findMany({
        where,
        select,
        orderBy,
        skip: (validatedParams.page - 1) * validatedParams.limit,
        take: validatedParams.limit,
      }),
      prisma.businessListing.count({ where }),
      validatedParams.includeStats ? getAggregatedStats(where) : null,
    ]);

    // Get facets if requested
    let facets = {};
    if (validatedParams.includeFacets) {
      facets = await getFacetedData(where);
    }

    // Get analytics if requested
    let analytics = {};
    if (validatedParams.includeAnalytics) {
      analytics = await getAnalyticsData(where, validatedParams);
    }

    const executionTime = Date.now() - startTime;

    // Log search for analytics
    await filterManager.logSearch(
      validatedParams.filters,
      totalCount,
      executionTime,
      {
        userAgent: request.headers.get('user-agent') || undefined,
        ipAddress: request.headers.get('x-forwarded-for') || undefined,
      }
    );

    const totalPages = Math.ceil(totalCount / validatedParams.limit);

    // Return different formats
    if (validatedParams.format === 'csv' || validatedParams.format === 'excel') {
      return await returnFormattedData(listings, validatedParams.format, request);
    }

    return NextResponse.json({
      success: true,
      data: {
        listings: await enrichListingsData(listings, validatedParams),
        pagination: {
          page: validatedParams.page,
          limit: validatedParams.limit,
          total: totalCount,
          totalPages,
          hasNextPage: validatedParams.page < totalPages,
          hasPrevPage: validatedParams.page > 1,
        },
        facets,
        analytics,
        stats: aggregatedStats,
        meta: {
          executionTime,
          searchParams: validatedParams,
          filtersApplied: Object.keys(where).length,
        },
      },
    });

  } catch (error) {
    console.error('Error in advanced listings search:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid search parameters',
        details: error.errors,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Advanced search failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

function parseSearchParams(searchParams: URLSearchParams): any {
  const params: any = {};

  // Handle array parameters
  const arrayParams = ['industries', 'states', 'cities', 'features'];
  arrayParams.forEach(param => {
    const value = searchParams.get(param);
    if (value) {
      params[param] = value.split(',').map(v => v.trim()).filter(v => v.length > 0);
    }
  });

  // Handle range parameters
  const rangeParams = ['dateRange', 'priceRange', 'revenueRange', 'cashFlowRange', 'employeeRange', 'establishedRange'];
  rangeParams.forEach(param => {
    const minKey = `${param}.min`;
    const maxKey = `${param}.max`;
    const min = searchParams.get(minKey);
    const max = searchParams.get(maxKey);

    if (min || max) {
      params[param] = {};
      if (min) params[param].min = param === 'dateRange' ? min : parseFloat(min);
      if (max) params[param].max = param === 'dateRange' ? max : parseFloat(max);
    }
  });

  // Handle other parameters
  searchParams.forEach((value, key) => {
    if (!key.includes('.') && !arrayParams.includes(key) && !params[key]) {
      // Parse boolean values
      if (value === 'true' || value === 'false') {
        params[key] = value === 'true';
      }
      // Parse number values
      else if (['page', 'limit'].includes(key)) {
        params[key] = parseInt(value);
      }
      // Keep as string
      else {
        params[key] = value;
      }
    }
  });

  return params;
}

async function buildAdvancedWhere(params: any): Promise<any> {
  const conditions: any[] = [];

  // Basic filters
  if (Object.keys(params.filters).length > 0) {
    const validatedFilters = FilterValidator.validatePartial(params.filters);
    const basicWhere = queryBuilder.buildDatabaseQuery(validatedFilters).where;
    if (Object.keys(basicWhere).length > 0) {
      conditions.push(basicWhere);
    }
  }

  // Search query
  if (params.search) {
    const searchWhere = queryBuilder.buildSearchQuery(params.search);
    if (Object.keys(searchWhere).length > 0) {
      conditions.push(searchWhere);
    }
  }

  // Range filters
  if (params.priceRange) {
    const priceCondition: any = { askingPrice: {} };
    if (params.priceRange.min) priceCondition.askingPrice.gte = params.priceRange.min;
    if (params.priceRange.max) priceCondition.askingPrice.lte = params.priceRange.max;
    conditions.push(priceCondition);
  }

  if (params.revenueRange) {
    const revenueCondition: any = { revenue: {} };
    if (params.revenueRange.min) revenueCondition.revenue.gte = params.revenueRange.min;
    if (params.revenueRange.max) revenueCondition.revenue.lte = params.revenueRange.max;
    conditions.push(revenueCondition);
  }

  if (params.cashFlowRange) {
    const cashFlowCondition: any = { cashFlow: {} };
    if (params.cashFlowRange.min) cashFlowCondition.cashFlow.gte = params.cashFlowRange.min;
    if (params.cashFlowRange.max) cashFlowCondition.cashFlow.lte = params.cashFlowRange.max;
    conditions.push(cashFlowCondition);
  }

  if (params.employeeRange) {
    const employeeCondition: any = { employees: {} };
    if (params.employeeRange.min) employeeCondition.employees.gte = params.employeeRange.min;
    if (params.employeeRange.max) employeeCondition.employees.lte = params.employeeRange.max;
    conditions.push(employeeCondition);
  }

  if (params.establishedRange) {
    const establishedCondition: any = { established: {} };
    if (params.establishedRange.min) establishedCondition.established.gte = params.establishedRange.min;
    if (params.establishedRange.max) establishedCondition.established.lte = params.establishedRange.max;
    conditions.push(establishedCondition);
  }

  if (params.dateRange) {
    const dateCondition: any = { listedDate: {} };
    if (params.dateRange.from) dateCondition.listedDate.gte = new Date(params.dateRange.from);
    if (params.dateRange.to) dateCondition.listedDate.lte = new Date(params.dateRange.to);
    conditions.push(dateCondition);
  }

  // Specific filters
  if (params.industries?.length) {
    conditions.push({ industry: { in: params.industries } });
  }

  if (params.states?.length) {
    conditions.push({ state: { in: params.states } });
  }

  if (params.cities?.length) {
    conditions.push({ city: { in: params.cities } });
  }

  if (params.features?.length) {
    conditions.push({
      features: {
        hasEvery: params.features,
      },
    });
  }

  // Boolean filters
  if (params.hasImages === true) {
    conditions.push({
      imageUrls: {
        not: {
          equals: [],
        },
      },
    });
  }

  if (params.hasContactInfo === true) {
    conditions.push({
      OR: [
        { contactEmail: { not: null } },
        { contactPhone: { not: null } },
        { contactName: { not: null } },
      ],
    });
  }

  if (params.sellerFinancing !== undefined) {
    conditions.push({ sellerFinancing: params.sellerFinancing });
  }

  return conditions.length > 0 ? { AND: conditions } : {};
}

function buildSelectClause(params: any): any {
  const baseSelect = {
    id: true,
    bizBuySellId: true,
    title: true,
    askingPrice: true,
    revenue: true,
    cashFlow: true,
    location: true,
    state: true,
    city: true,
    industry: true,
    description: true,
    listedDate: true,
    established: true,
    employees: true,
    sellerFinancing: true,
    createdAt: true,
    updatedAt: true,
  };

  if (params.includeImages) {
    baseSelect.imageUrls = true;
  }

  if (params.includeContact) {
    baseSelect.contactName = true;
    baseSelect.contactEmail = true;
    baseSelect.contactPhone = true;
  }

  if (params.includeBroker) {
    baseSelect.brokerName = true;
    baseSelect.brokerCompany = true;
  }

  if (params.includeFeatures) {
    baseSelect.features = true;
  }

  baseSelect.listingUrl = true;
  baseSelect.reasonForSelling = true;

  return baseSelect;
}

function buildOrderByClause(sortBy?: string, sortOrder?: string): any {
  const order = sortOrder || 'desc';

  switch (sortBy) {
    case 'price-low-high':
      return [{ askingPrice: 'asc' }];
    case 'price-high-low':
      return [{ askingPrice: 'desc' }];
    case 'revenue-high-low':
      return [{ revenue: 'desc' }];
    case 'revenue-low-high':
      return [{ revenue: 'asc' }];
    case 'cash-flow-high-low':
      return [{ cashFlow: 'desc' }];
    case 'cash-flow-low-high':
      return [{ cashFlow: 'asc' }];
    case 'oldest':
      return [{ listedDate: 'asc' }];
    case 'title':
      return [{ title: order }];
    case 'location':
      return [{ location: order }];
    case 'relevance':
      // Would implement relevance scoring here
      return [{ listedDate: 'desc' }];
    case 'newest':
    default:
      return [{ listedDate: 'desc' }];
  }
}

async function getFacetedData(where: any): Promise<any> {
  const [industryFacets, stateFacets, cityFacets, featureFacets] = await Promise.all([
    prisma.businessListing.groupBy({
      where,
      by: ['industry'],
      _count: { industry: true },
      orderBy: { _count: { industry: 'desc' } },
      take: 20,
    }),
    prisma.businessListing.groupBy({
      where,
      by: ['state'],
      _count: { state: true },
      orderBy: { _count: { state: 'desc' } },
      take: 50,
    }),
    prisma.businessListing.groupBy({
      where,
      by: ['city'],
      _count: { city: true },
      orderBy: { _count: { city: 'desc' } },
      take: 30,
    }),
    // Feature facets would require a more complex query
    [],
  ]);

  return {
    industries: industryFacets.map(f => ({
      value: f.industry,
      count: f._count.industry,
    })),
    states: stateFacets.map(f => ({
      value: f.state,
      count: f._count.state,
    })),
    cities: cityFacets.map(f => ({
      value: f.city || 'Unknown',
      count: f._count.city,
    })),
    features: featureFacets,
  };
}

async function getAggregatedStats(where: any): Promise<any> {
  const stats = await prisma.businessListing.aggregate({
    where,
    _avg: {
      askingPrice: true,
      revenue: true,
      cashFlow: true,
      employees: true,
      established: true,
    },
    _min: {
      askingPrice: true,
      revenue: true,
      cashFlow: true,
      listedDate: true,
    },
    _max: {
      askingPrice: true,
      revenue: true,
      cashFlow: true,
      listedDate: true,
    },
    _count: true,
  });

  return {
    total: stats._count,
    averages: {
      askingPrice: Math.round(stats._avg.askingPrice || 0),
      revenue: Math.round(stats._avg.revenue || 0),
      cashFlow: Math.round(stats._avg.cashFlow || 0),
      employees: Math.round(stats._avg.employees || 0),
      established: Math.round(stats._avg.established || 0),
    },
    ranges: {
      askingPrice: {
        min: stats._min.askingPrice || 0,
        max: stats._max.askingPrice || 0,
      },
      revenue: {
        min: stats._min.revenue || 0,
        max: stats._max.revenue || 0,
      },
      cashFlow: {
        min: stats._min.cashFlow || 0,
        max: stats._max.cashFlow || 0,
      },
      listedDate: {
        earliest: stats._min.listedDate,
        latest: stats._max.listedDate,
      },
    },
  };
}

async function getAnalyticsData(where: any, params: any): Promise<any> {
  // This would include more sophisticated analytics
  return {
    priceDistribution: await getPriceDistribution(where),
    industryDistribution: await getIndustryDistribution(where),
    geographicDistribution: await getGeographicDistribution(where),
    trends: await getTrendsData(where),
  };
}

async function getPriceDistribution(where: any): Promise<any> {
  // Implement price range distribution
  return [];
}

async function getIndustryDistribution(where: any): Promise<any> {
  return prisma.businessListing.groupBy({
    where,
    by: ['industry'],
    _count: { industry: true },
    _avg: { askingPrice: true, revenue: true },
    orderBy: { _count: { industry: 'desc' } },
    take: 10,
  });
}

async function getGeographicDistribution(where: any): Promise<any> {
  return prisma.businessListing.groupBy({
    where,
    by: ['state'],
    _count: { state: true },
    _avg: { askingPrice: true },
    orderBy: { _count: { state: 'desc' } },
    take: 15,
  });
}

async function getTrendsData(where: any): Promise<any> {
  // Implement trending analysis over time
  return {
    listingTrends: [],
    priceTrends: [],
  };
}

async function enrichListingsData(listings: any[], params: any): Promise<any[]> {
  // Add computed fields and enrichments
  return listings.map(listing => ({
    ...listing,
    computed: {
      priceToRevenueRatio: listing.askingPrice && listing.revenue
        ? (listing.askingPrice / listing.revenue).toFixed(2)
        : null,
      cashFlowMultiple: listing.askingPrice && listing.cashFlow
        ? (listing.askingPrice / listing.cashFlow).toFixed(2)
        : null,
      hasFinancials: !!(listing.revenue || listing.cashFlow),
      daysListed: Math.floor((Date.now() - new Date(listing.listedDate).getTime()) / (1000 * 60 * 60 * 24)),
    },
  }));
}

async function returnFormattedData(listings: any[], format: string, request: NextRequest): Promise<NextResponse> {
  // Implement CSV/Excel export functionality
  const headers = new Headers();

  if (format === 'csv') {
    headers.set('Content-Type', 'text/csv');
    headers.set('Content-Disposition', 'attachment; filename="listings.csv"');

    const csvData = convertToCSV(listings);
    return new NextResponse(csvData, { headers });
  }

  // For Excel format, you'd use a library like xlsx
  return NextResponse.json({
    success: false,
    error: 'Export format not yet implemented',
  }, { status: 501 });
}

function convertToCSV(listings: any[]): string {
  if (listings.length === 0) return '';

  const headers = Object.keys(listings[0]).filter(key => key !== 'computed');
  const csvHeaders = headers.join(',');

  const csvRows = listings.map(listing =>
    headers.map(header => {
      const value = listing[header];
      if (value === null || value === undefined) return '';
      if (Array.isArray(value)) return `"${value.join(';')}"`;
      if (typeof value === 'string' && value.includes(',')) return `"${value}"`;
      return value;
    }).join(',')
  );

  return [csvHeaders, ...csvRows].join('\n');
}