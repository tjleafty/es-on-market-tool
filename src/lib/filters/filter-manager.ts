import { prisma } from '../database';
import { ScrapeFilters, FilterOption } from '@/types';
import {
  US_STATES,
  BUSINESS_INDUSTRIES,
  PRICE_RANGES,
  REVENUE_RANGES,
  CASH_FLOW_RANGES,
  EMPLOYEE_RANGES,
  ESTABLISHED_RANGES,
  LISTING_FEATURES,
  MAJOR_METROPOLITAN_AREAS,
} from './constants';

export class FilterManager {

  async getFilterOptions(category?: string): Promise<Record<string, FilterOption[]>> {
    const whereClause = category ? { category, isActive: true } : { isActive: true };

    const options = await prisma.filterOption.findMany({
      where: whereClause,
      orderBy: [
        { sortOrder: 'asc' },
        { label: 'asc' },
      ],
    });

    if (category) {
      return { [category]: options.map(this.mapToFilterOption) };
    }

    // Group by category
    const grouped = options.reduce((acc, option) => {
      if (!acc[option.category]) {
        acc[option.category] = [];
      }
      acc[option.category].push(this.mapToFilterOption(option));
      return acc;
    }, {} as Record<string, FilterOption[]>);

    return grouped;
  }

  async getFilterOptionsByCategory(category: string): Promise<FilterOption[]> {
    const options = await prisma.filterOption.findMany({
      where: { category, isActive: true },
      orderBy: [
        { sortOrder: 'asc' },
        { label: 'asc' },
      ],
    });

    return options.map(this.mapToFilterOption);
  }

  async getCitiesByState(state: string): Promise<FilterOption[]> {
    const options = await prisma.filterOption.findMany({
      where: {
        category: 'city',
        isActive: true,
        metadata: {
          path: ['state'],
          equals: state,
        },
      },
      orderBy: { label: 'asc' },
    });

    return options.map(this.mapToFilterOption);
  }

  async getIndustryOptions(): Promise<FilterOption[]> {
    return this.getFilterOptionsByCategory('industry');
  }

  async getStateOptions(): Promise<FilterOption[]> {
    return this.getFilterOptionsByCategory('state');
  }

  async getPriceRanges(): Promise<FilterOption[]> {
    return this.getFilterOptionsByCategory('price_range');
  }

  async getRevenueRanges(): Promise<FilterOption[]> {
    return this.getFilterOptionsByCategory('revenue_range');
  }

  async getCashFlowRanges(): Promise<FilterOption[]> {
    return this.getFilterOptionsByCategory('cash_flow_range');
  }

  async getEmployeeRanges(): Promise<FilterOption[]> {
    return this.getFilterOptionsByCategory('employee_range');
  }

  async getEstablishedRanges(): Promise<FilterOption[]> {
    return this.getFilterOptionsByCategory('established_range');
  }

  async getListingFeatures(): Promise<FilterOption[]> {
    return this.getFilterOptionsByCategory('feature');
  }

  async createFilterSet(name: string, filters: ScrapeFilters, description?: string, isPublic?: boolean): Promise<string> {
    const filterSet = await prisma.filterSet.create({
      data: {
        name,
        description,
        filters: filters as any,
        isPublic: isPublic || false,
      },
    });

    return filterSet.id;
  }

  async getFilterSets(isPublic?: boolean): Promise<Array<{
    id: string;
    name: string;
    description?: string;
    filters: ScrapeFilters;
    usageCount: number;
    createdAt: Date;
  }>> {
    const whereClause = isPublic !== undefined ? { isPublic } : {};

    const filterSets = await prisma.filterSet.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
    });

    return filterSets.map(set => ({
      id: set.id,
      name: set.name,
      description: set.description || undefined,
      filters: set.filters as ScrapeFilters,
      usageCount: set.usageCount,
      createdAt: set.createdAt,
    }));
  }

  async incrementFilterSetUsage(id: string): Promise<void> {
    await prisma.filterSet.update({
      where: { id },
      data: {
        usageCount: {
          increment: 1,
        },
      },
    });
  }

  async logSearch(filters: ScrapeFilters, resultCount: number, executionTime: number, metadata?: {
    userAgent?: string;
    ipAddress?: string;
  }): Promise<void> {
    await prisma.searchHistory.create({
      data: {
        filters: filters as any,
        resultCount,
        executionTime,
        userAgent: metadata?.userAgent,
        ipAddress: metadata?.ipAddress,
      },
    });
  }

  async getSearchAnalytics(days: number = 30): Promise<{
    totalSearches: number;
    averageResults: number;
    averageExecutionTime: number;
    popularFilters: Array<{
      filterType: string;
      usage: number;
    }>;
  }> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const searches = await prisma.searchHistory.findMany({
      where: {
        createdAt: {
          gte: startDate,
        },
      },
    });

    const totalSearches = searches.length;
    const averageResults = totalSearches > 0
      ? searches.reduce((sum, search) => sum + search.resultCount, 0) / totalSearches
      : 0;
    const averageExecutionTime = totalSearches > 0
      ? searches.reduce((sum, search) => sum + search.executionTime, 0) / totalSearches
      : 0;

    // Analyze popular filters
    const filterUsage: Record<string, number> = {};

    searches.forEach(search => {
      const filters = search.filters as any;
      Object.keys(filters).forEach(key => {
        if (filters[key] !== undefined && filters[key] !== null) {
          filterUsage[key] = (filterUsage[key] || 0) + 1;
        }
      });
    });

    const popularFilters = Object.entries(filterUsage)
      .map(([filterType, usage]) => ({ filterType, usage }))
      .sort((a, b) => b.usage - a.usage)
      .slice(0, 10);

    return {
      totalSearches,
      averageResults,
      averageExecutionTime,
      popularFilters,
    };
  }

  private mapToFilterOption(dbOption: any): FilterOption {
    return {
      value: dbOption.value,
      label: dbOption.label,
      count: dbOption.metadata?.count,
    };
  }

  async refreshFilterCounts(): Promise<void> {
    // This would be called periodically to update filter option counts based on actual data
    const industries = await prisma.businessListing.groupBy({
      by: ['industry'],
      _count: {
        industry: true,
      },
    });

    for (const industry of industries) {
      await prisma.filterOption.updateMany({
        where: {
          category: 'industry',
          value: industry.industry,
        },
        data: {
          metadata: {
            count: industry._count.industry,
          },
        },
      });
    }

    // Similar updates for states, price ranges, etc.
    const states = await prisma.businessListing.groupBy({
      by: ['state'],
      _count: {
        state: true,
      },
    });

    for (const state of states) {
      await prisma.filterOption.updateMany({
        where: {
          category: 'state',
          value: state.state,
        },
        data: {
          metadata: {
            count: state._count.state,
          },
        },
      });
    }
  }
}

export const filterManager = new FilterManager();