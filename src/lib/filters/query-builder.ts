import { Prisma } from '@/generated/prisma';
import { ScrapeFilters } from '@/types';

export interface QueryOptions {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export class QueryBuilder {

  buildDatabaseQuery(filters: ScrapeFilters, options: QueryOptions = {}): {
    where: Prisma.BusinessListingWhereInput;
    orderBy: Prisma.BusinessListingOrderByWithRelationInput[];
    skip?: number;
    take?: number;
  } {
    const where: Prisma.BusinessListingWhereInput = {};
    const conditions: Prisma.BusinessListingWhereInput[] = [];

    // Location filters
    if (filters.location) {
      if (filters.location.states && filters.location.states.length > 0) {
        conditions.push({
          state: {
            in: filters.location.states,
          },
        });
      }

      if (filters.location.cities && filters.location.cities.length > 0) {
        conditions.push({
          city: {
            in: filters.location.cities,
          },
        });
      }
    }

    // Price range filters
    if (filters.price) {
      const priceFilters: any = {};

      if (filters.price.min !== undefined) {
        priceFilters.gte = filters.price.min;
      }

      if (filters.price.max !== undefined) {
        priceFilters.lte = filters.price.max;
      }

      if (Object.keys(priceFilters).length > 0) {
        const priceCondition: Prisma.BusinessListingWhereInput = {
          askingPrice: priceFilters
        };
        conditions.push(priceCondition);
      }
    }

    // Revenue range filters
    if (filters.revenue) {
      const revenueFilters: any = {};

      if (filters.revenue.min !== undefined) {
        revenueFilters.gte = filters.revenue.min;
      }

      if (filters.revenue.max !== undefined) {
        revenueFilters.lte = filters.revenue.max;
      }

      if (Object.keys(revenueFilters).length > 0) {
        const revenueCondition: Prisma.BusinessListingWhereInput = {
          revenue: revenueFilters
        };
        conditions.push(revenueCondition);
      }
    }

    // Cash flow range filters
    if (filters.cashFlow) {
      const cashFlowCondition: Prisma.BusinessListingWhereInput = {};

      if (filters.cashFlow.min !== undefined) {
        cashFlowCondition.cashFlow = {
          ...(cashFlowCondition.cashFlow || {}),
          gte: filters.cashFlow.min,
        };
      }

      if (filters.cashFlow.max !== undefined) {
        cashFlowCondition.cashFlow = {
          ...(cashFlowCondition.cashFlow || {}),
          lte: filters.cashFlow.max,
        };
      }

      if (Object.keys(cashFlowCondition).length > 0) {
        conditions.push(cashFlowCondition);
      }
    }

    // Industry filters
    if (filters.industry && filters.industry.length > 0) {
      conditions.push({
        industry: {
          in: filters.industry,
        },
      });
    }

    // Listing date filters
    if (filters.listingDate) {
      const dateCondition: Prisma.BusinessListingWhereInput = {};

      if (filters.listingDate.from) {
        dateCondition.listedDate = {
          ...(dateCondition.listedDate || {}),
          gte: filters.listingDate.from,
        };
      }

      if (filters.listingDate.to) {
        dateCondition.listedDate = {
          ...(dateCondition.listedDate || {}),
          lte: filters.listingDate.to,
        };
      }

      if (Object.keys(dateCondition).length > 0) {
        conditions.push(dateCondition);
      }
    }

    // Seller financing filter
    if (filters.sellerFinancing !== undefined) {
      conditions.push({
        sellerFinancing: filters.sellerFinancing,
      });
    }

    // Established year filters
    if (filters.established) {
      const establishedCondition: Prisma.BusinessListingWhereInput = {};

      if (filters.established.min !== undefined) {
        establishedCondition.established = {
          ...(establishedCondition.established || {}),
          gte: filters.established.min,
        };
      }

      if (filters.established.max !== undefined) {
        establishedCondition.established = {
          ...(establishedCondition.established || {}),
          lte: filters.established.max,
        };
      }

      if (Object.keys(establishedCondition).length > 0) {
        conditions.push(establishedCondition);
      }
    }

    // Combine all conditions
    if (conditions.length > 0) {
      where.AND = conditions;
    }

    // Build order by
    const orderBy = this.buildOrderBy(options.sortBy, options.sortOrder);

    // Pagination
    const pagination: { skip?: number; take?: number } = {};
    if (options.page && options.limit) {
      pagination.skip = (options.page - 1) * options.limit;
      pagination.take = options.limit;
    } else if (options.limit) {
      pagination.take = options.limit;
    }

    return {
      where,
      orderBy,
      ...pagination,
    };
  }

  buildSearchQuery(searchTerm?: string): Prisma.BusinessListingWhereInput {
    if (!searchTerm || searchTerm.trim().length === 0) {
      return {};
    }

    const terms = searchTerm.trim().split(/\s+/);
    const searchConditions: Prisma.BusinessListingWhereInput[] = [];

    for (const term of terms) {
      searchConditions.push({
        OR: [
          {
            title: {
              contains: term,
              mode: 'insensitive',
            },
          },
          {
            description: {
              contains: term,
              mode: 'insensitive',
            },
          },
          {
            industry: {
              contains: term,
              mode: 'insensitive',
            },
          },
          {
            location: {
              contains: term,
              mode: 'insensitive',
            },
          },
        ],
      });
    }

    return {
      AND: searchConditions,
    };
  }

  private buildOrderBy(sortBy?: string, sortOrder: 'asc' | 'desc' = 'desc'): Prisma.BusinessListingOrderByWithRelationInput[] {
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
      case 'newest':
        return [{ listedDate: 'desc' }];
      case 'oldest':
        return [{ listedDate: 'asc' }];
      case 'title':
        return [{ title: sortOrder }];
      case 'location':
        return [{ location: sortOrder }];
      default:
        return [{ listedDate: 'desc' }]; // Default to newest first
    }
  }

  buildAggregationQuery(filters: ScrapeFilters): {
    where: Prisma.BusinessListingWhereInput;
    select: Prisma.BusinessListingSelect;
  } {
    const { where } = this.buildDatabaseQuery(filters);

    return {
      where,
      select: {
        id: true,
        askingPrice: true,
        revenue: true,
        cashFlow: true,
        industry: true,
        state: true,
        established: true,
        employees: true,
      },
    };
  }

  buildCountQuery(filters: ScrapeFilters): Prisma.BusinessListingWhereInput {
    const { where } = this.buildDatabaseQuery(filters);
    return where;
  }

  combineFiltersWithSearch(filters: ScrapeFilters, searchTerm?: string): Prisma.BusinessListingWhereInput {
    const filterWhere = this.buildDatabaseQuery(filters).where;
    const searchWhere = this.buildSearchQuery(searchTerm);

    if (Object.keys(filterWhere).length === 0 && Object.keys(searchWhere).length === 0) {
      return {};
    }

    if (Object.keys(filterWhere).length === 0) {
      return searchWhere;
    }

    if (Object.keys(searchWhere).length === 0) {
      return filterWhere;
    }

    return {
      AND: [filterWhere, searchWhere],
    };
  }

  buildFacetQuery(filters: ScrapeFilters, facetField: string): {
    where: Prisma.BusinessListingWhereInput;
    groupBy: any;
  } {
    const { where } = this.buildDatabaseQuery(filters);

    // Remove the filter for the field we're faceting on to get all possible values
    const facetWhere = this.removeFacetFilter(where, facetField);

    let groupByField: keyof Prisma.BusinessListingGroupByArgs['by'];

    switch (facetField) {
      case 'industry':
        groupByField = 'industry';
        break;
      case 'state':
        groupByField = 'state';
        break;
      case 'city':
        groupByField = 'city';
        break;
      default:
        groupByField = 'industry';
    }

    return {
      where: facetWhere,
      groupBy: {
        by: [groupByField],
        _count: {
          [groupByField]: true,
        },
      },
    };
  }

  private removeFacetFilter(where: Prisma.BusinessListingWhereInput, facetField: string): Prisma.BusinessListingWhereInput {
    // Create a deep copy and remove the specific filter
    const facetWhere = JSON.parse(JSON.stringify(where));

    if (facetWhere.AND) {
      facetWhere.AND = facetWhere.AND.filter((condition: any) => {
        return !condition[facetField];
      });

      if (facetWhere.AND.length === 0) {
        delete facetWhere.AND;
      }
    }

    if (facetWhere[facetField]) {
      delete facetWhere[facetField];
    }

    return facetWhere;
  }
}

export const queryBuilder = new QueryBuilder();