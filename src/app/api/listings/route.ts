import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/database';
import { queryBuilder } from '@/lib/filters/query-builder';
import { FilterValidator } from '@/lib/scraper/filters/filter-validator';
import { filterManager } from '@/lib/filters/filter-manager';

const ListingsRequestSchema = z.object({
  filters: z.record(z.string(), z.any()).default({}),
  search: z.string().optional(),
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(20),
  sortBy: z.enum(['newest', 'oldest', 'price-low-high', 'price-high-low', 'revenue-high-low', 'cash-flow-high-low', 'title', 'location']).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  includeFacets: z.boolean().default(false),
  includeImages: z.boolean().default(false),
  includeContact: z.boolean().default(false),
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
  format: z.enum(['json', 'csv']).default('json'),
});

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Parse query parameters
    const queryParams = {
      filters: searchParams.get('filters') ? JSON.parse(searchParams.get('filters')!) : {},
      search: searchParams.get('search') || undefined,
      page: parseInt(searchParams.get('page') || '1'),
      limit: parseInt(searchParams.get('limit') || '20'),
      sortBy: searchParams.get('sortBy') || undefined,
      sortOrder: (searchParams.get('sortOrder') as 'asc' | 'desc') || 'desc',
      includeFacets: searchParams.get('includeFacets') === 'true',
    };

    const { filters, search, page, limit, sortBy, sortOrder, includeFacets } =
      ListingsRequestSchema.parse(queryParams);

    const startTime = Date.now();

    // Validate and sanitize filters if they exist
    let validatedFilters = {};
    if (Object.keys(filters).length > 0) {
      validatedFilters = FilterValidator.validatePartial(filters);
    }

    // Build database query
    const where = queryBuilder.combineFiltersWithSearch(validatedFilters, search);
    const queryOptions = { page, limit, sortBy, sortOrder };
    const { orderBy, skip, take } = queryBuilder.buildDatabaseQuery(validatedFilters, queryOptions);

    // Execute main query
    const [listings, totalCount] = await Promise.all([
      prisma.businessListing.findMany({
        where,
        orderBy,
        skip,
        take,
        select: {
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
          sellerFinancing: true,
          employees: true,
          established: true,
          features: true,
          imageUrls: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.businessListing.count({ where }),
    ]);

    const executionTime = Date.now() - startTime;

    // Get facets if requested
    let facets = {};
    if (includeFacets) {
      const [industryFacets, stateFacets] = await Promise.all([
        prisma.businessListing.groupBy({
          where,
          by: ['industry'],
          _count: {
            industry: true,
          },
          orderBy: {
            _count: {
              industry: 'desc',
            },
          },
          take: 20,
        }),
        prisma.businessListing.groupBy({
          where,
          by: ['state'],
          _count: {
            state: true,
          },
          orderBy: {
            _count: {
              state: 'desc',
            },
          },
          take: 50,
        }),
      ]);

      facets = {
        industries: industryFacets.map((f: any) => ({
          value: f.industry,
          count: f._count.industry,
        })),
        states: stateFacets.map((f: any) => ({
          value: f.state,
          count: f._count.state,
        })),
      };
    }

    // Log the search for analytics
    if (Object.keys(validatedFilters).length > 0 || search) {
      await filterManager.logSearch(
        validatedFilters,
        totalCount,
        executionTime,
        {
          userAgent: request.headers.get('user-agent') || undefined,
          ipAddress: request.headers.get('x-forwarded-for') || undefined,
        }
      );
    }

    const totalPages = Math.ceil(totalCount / limit);
    const hasNextPage = page < totalPages;
    const hasPrevPage = page > 1;

    return NextResponse.json({
      success: true,
      data: {
        listings,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages,
          hasNextPage,
          hasPrevPage,
        },
        facets,
        meta: {
          executionTime,
          filtersApplied: Object.keys(validatedFilters).length,
          searchTerm: search,
        },
      },
    });

  } catch (error) {
    console.error('Error fetching listings:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid request parameters',
        details: error.issues,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to fetch listings',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}