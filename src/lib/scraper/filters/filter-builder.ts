import { ScrapeFilters } from '@/types';

export class FilterBuilder {
  private baseUrl = 'https://www.bizbuysell.com/businesses-for-sale/';

  buildSearchUrl(filters: ScrapeFilters): string {
    const params = new URLSearchParams();

    if (filters.location?.states && filters.location.states.length > 0) {
      filters.location.states.forEach(state => {
        params.append('state', state);
      });
    }

    if (filters.location?.cities && filters.location.cities.length > 0) {
      filters.location.cities.forEach(city => {
        params.append('city', city);
      });
    }

    if (filters.price?.min) {
      params.set('price_min', filters.price.min.toString());
    }

    if (filters.price?.max) {
      params.set('price_max', filters.price.max.toString());
    }

    if (filters.revenue?.min) {
      params.set('revenue_min', filters.revenue.min.toString());
    }

    if (filters.revenue?.max) {
      params.set('revenue_max', filters.revenue.max.toString());
    }

    if (filters.cashFlow?.min) {
      params.set('cash_flow_min', filters.cashFlow.min.toString());
    }

    if (filters.cashFlow?.max) {
      params.set('cash_flow_max', filters.cashFlow.max.toString());
    }

    if (filters.industry && filters.industry.length > 0) {
      filters.industry.forEach(industry => {
        params.append('industry', industry);
      });
    }

    if (filters.sellerFinancing !== undefined) {
      params.set('seller_financing', filters.sellerFinancing.toString());
    }

    if (filters.established?.min) {
      params.set('established_min', filters.established.min.toString());
    }

    if (filters.established?.max) {
      params.set('established_max', filters.established.max.toString());
    }

    const queryString = params.toString();
    return queryString ? `${this.baseUrl}?${queryString}` : this.baseUrl;
  }

  buildPaginationUrl(baseUrl: string, page: number): string {
    const url = new URL(baseUrl);
    url.searchParams.set('page', page.toString());
    return url.toString();
  }

  extractFiltersFromUrl(url: string): ScrapeFilters {
    const urlObj = new URL(url);
    const params = urlObj.searchParams;

    const filters: ScrapeFilters = {};

    const states = params.getAll('state');
    const cities = params.getAll('city');

    if (states.length > 0 || cities.length > 0) {
      filters.location = {};
      if (states.length > 0) filters.location.states = states;
      if (cities.length > 0) filters.location.cities = cities;
    }

    const priceMin = params.get('price_min');
    const priceMax = params.get('price_max');
    if (priceMin || priceMax) {
      filters.price = {};
      if (priceMin) filters.price.min = parseInt(priceMin);
      if (priceMax) filters.price.max = parseInt(priceMax);
    }

    const revenueMin = params.get('revenue_min');
    const revenueMax = params.get('revenue_max');
    if (revenueMin || revenueMax) {
      filters.revenue = {};
      if (revenueMin) filters.revenue.min = parseInt(revenueMin);
      if (revenueMax) filters.revenue.max = parseInt(revenueMax);
    }

    const cashFlowMin = params.get('cash_flow_min');
    const cashFlowMax = params.get('cash_flow_max');
    if (cashFlowMin || cashFlowMax) {
      filters.cashFlow = {};
      if (cashFlowMin) filters.cashFlow.min = parseInt(cashFlowMin);
      if (cashFlowMax) filters.cashFlow.max = parseInt(cashFlowMax);
    }

    const industries = params.getAll('industry');
    if (industries.length > 0) {
      filters.industry = industries;
    }

    const sellerFinancing = params.get('seller_financing');
    if (sellerFinancing) {
      filters.sellerFinancing = sellerFinancing === 'true';
    }

    const establishedMin = params.get('established_min');
    const establishedMax = params.get('established_max');
    if (establishedMin || establishedMax) {
      filters.established = {};
      if (establishedMin) filters.established.min = parseInt(establishedMin);
      if (establishedMax) filters.established.max = parseInt(establishedMax);
    }

    return filters;
  }
}