export interface BusinessListing {
  id?: string;
  bizBuySellId: string;
  title: string;
  askingPrice?: number;
  revenue?: number;
  cashFlow?: number;
  location: string;
  state: string;
  industry: string;
  description: string;
  listedDate: Date;
  sellerFinancing?: boolean;
  reasonForSelling?: string;
  employees?: number;
  established?: number;
  imageUrls: string[];
}

export interface ScrapeFilters {
  location?: {
    states?: string[];
    cities?: string[];
  };
  price?: {
    min?: number;
    max?: number;
  };
  revenue?: {
    min?: number;
    max?: number;
  };
  cashFlow?: {
    min?: number;
    max?: number;
  };
  industry?: string[];
  listingDate?: {
    from?: Date;
    to?: Date;
  };
  sellerFinancing?: boolean;
  established?: {
    min?: number;
    max?: number;
  };
}

export interface ScrapeJobStatus {
  id: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  progress?: {
    current: number;
    total: number;
    percentage: number;
  };
  results?: {
    listingsFound: number;
    listingsScraped: number;
  };
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface ScrapingConfig {
  maxConcurrentBrowsers: number;
  requestTimeout: number;
  delayMin: number;
  delayMax: number;
  retryAttempts: number;
  proxyEnabled: boolean;
  proxyServers?: string[];
}

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}