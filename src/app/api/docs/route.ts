import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { PERMISSIONS } from '@/lib/auth/api-auth';

interface APIEndpoint {
  method: string;
  path: string;
  summary: string;
  description: string;
  auth: 'required' | 'optional' | 'none';
  permissions?: string[];
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses: Response[];
  examples: Example[];
  rateLimit?: RateLimit;
}

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'body';
  type: string;
  required: boolean;
  description: string;
  example?: any;
  enum?: string[];
}

interface RequestBody {
  contentType: string;
  schema: any;
  example: any;
}

interface Response {
  status: number;
  description: string;
  schema?: any;
  example?: any;
}

interface Example {
  title: string;
  description: string;
  request: any;
  response: any;
}

interface RateLimit {
  basic: string;
  premium: string;
  enterprise: string;
}

const API_DOCUMENTATION: Record<string, APIEndpoint[]> = {
  jobs: [
    {
      method: 'GET',
      path: '/api/jobs',
      summary: 'List scraping jobs',
      description: 'Retrieve a paginated list of scraping jobs with optional filtering and sorting.',
      auth: 'required',
      permissions: [PERMISSIONS.JOBS_READ],
      parameters: [
        { name: 'page', in: 'query', type: 'number', required: false, description: 'Page number (1-based)', example: 1 },
        { name: 'limit', in: 'query', type: 'number', required: false, description: 'Items per page (max 100)', example: 20 },
        { name: 'status', in: 'query', type: 'string', required: false, description: 'Filter by job status', enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED'] },
        { name: 'sortBy', in: 'query', type: 'string', required: false, description: 'Sort field', enum: ['createdAt', 'updatedAt', 'duration', 'listingsFound'] },
        { name: 'sortOrder', in: 'query', type: 'string', required: false, description: 'Sort order', enum: ['asc', 'desc'] },
      ],
      responses: [
        {
          status: 200,
          description: 'Jobs retrieved successfully',
          example: {
            success: true,
            data: {
              jobs: [
                {
                  id: 'job_abc123',
                  status: 'COMPLETED',
                  filters: { state: 'CA' },
                  progress: 100,
                  listingsFound: 157,
                  duration: 285000,
                  createdAt: '2024-01-01T00:00:00Z',
                }
              ],
              pagination: { page: 1, limit: 20, total: 1, pages: 1 }
            }
          }
        },
        { status: 401, description: 'Authentication required' },
        { status: 403, description: 'Insufficient permissions' },
      ],
      examples: [
        {
          title: 'List completed jobs',
          description: 'Get all completed jobs sorted by creation date',
          request: { method: 'GET', url: '/api/jobs?status=COMPLETED&sortBy=createdAt&sortOrder=desc' },
          response: { status: 200, body: '...' }
        }
      ],
      rateLimit: { basic: '100/min', premium: '1000/min', enterprise: '10000/min' }
    },
    {
      method: 'POST',
      path: '/api/jobs',
      summary: 'Create scraping job',
      description: 'Start a new business listing scraping job with specified filters and configuration.',
      auth: 'required',
      permissions: [PERMISSIONS.JOBS_CREATE],
      requestBody: {
        contentType: 'application/json',
        schema: {
          type: 'object',
          properties: {
            filters: { type: 'object', description: 'Search filters' },
            maxListings: { type: 'number', minimum: 1, maximum: 50000 },
            enableWebhooks: { type: 'boolean', default: false },
            priority: { type: 'string', enum: ['low', 'normal', 'high'] },
          },
          required: ['filters']
        },
        example: {
          filters: { state: 'CA', industry: 'restaurant', priceRange: '0-500000' },
          maxListings: 1000,
          enableWebhooks: true,
          priority: 'normal'
        }
      },
      responses: [
        {
          status: 201,
          description: 'Job created successfully',
          example: {
            success: true,
            data: {
              id: 'job_abc123',
              status: 'PENDING',
              filters: { state: 'CA', industry: 'restaurant' },
              maxListings: 1000,
              createdAt: '2024-01-01T00:00:00Z',
              estimatedDuration: 300000
            }
          }
        },
        { status: 400, description: 'Invalid request body' },
        { status: 401, description: 'Authentication required' },
        { status: 403, description: 'Insufficient permissions' },
      ],
      examples: [
        {
          title: 'Create restaurant scraping job',
          description: 'Scrape restaurant listings in California',
          request: {
            method: 'POST',
            url: '/api/jobs',
            body: { filters: { state: 'CA', industry: 'restaurant' }, maxListings: 500 }
          },
          response: { status: 201, body: '...' }
        }
      ],
      rateLimit: { basic: '10/min', premium: '100/min', enterprise: '1000/min' }
    },
  ],
  listings: [
    {
      method: 'GET',
      path: '/api/listings/enhanced',
      summary: 'Search business listings',
      description: 'Advanced search and filtering of business listings with faceted results.',
      auth: 'required',
      permissions: [PERMISSIONS.LISTINGS_SEARCH],
      parameters: [
        { name: 'q', in: 'query', type: 'string', required: false, description: 'Full-text search query' },
        { name: 'state', in: 'query', type: 'string', required: false, description: 'Filter by state' },
        { name: 'industry', in: 'query', type: 'string', required: false, description: 'Filter by industry' },
        { name: 'priceMin', in: 'query', type: 'number', required: false, description: 'Minimum asking price' },
        { name: 'priceMax', in: 'query', type: 'number', required: false, description: 'Maximum asking price' },
        { name: 'includeFacets', in: 'query', type: 'boolean', required: false, description: 'Include faceted counts', example: true },
        { name: 'page', in: 'query', type: 'number', required: false, description: 'Page number', example: 1 },
        { name: 'limit', in: 'query', type: 'number', required: false, description: 'Items per page (max 1000)', example: 50 },
      ],
      responses: [
        {
          status: 200,
          description: 'Listings retrieved successfully',
          example: {
            success: true,
            data: {
              listings: [
                {
                  id: 'listing_1',
                  title: 'Established Pizza Restaurant',
                  askingPrice: 250000,
                  revenue: 500000,
                  location: 'Los Angeles, CA',
                  industry: 'Restaurant',
                  listedDate: '2024-01-01'
                }
              ],
              pagination: { page: 1, limit: 50, total: 1247, pages: 25 },
              facets: {
                states: [{ state: 'CA', count: 423 }, { state: 'TX', count: 387 }],
                industries: [{ industry: 'Restaurant', count: 156 }],
                priceRanges: [{ range: '0-100000', count: 89 }]
              }
            }
          }
        }
      ],
      examples: [
        {
          title: 'Search restaurants in California',
          description: 'Find restaurant businesses for sale in CA under $500k',
          request: { method: 'GET', url: '/api/listings/enhanced?industry=restaurant&state=CA&priceMax=500000' },
          response: { status: 200, body: '...' }
        }
      ],
      rateLimit: { basic: '100/min', premium: '1000/min', enterprise: '10000/min' }
    }
  ],
  export: [
    {
      method: 'POST',
      path: '/api/export',
      summary: 'Export business listings',
      description: 'Export filtered business listings in various formats (CSV, Excel, JSON, XML).',
      auth: 'required',
      permissions: [PERMISSIONS.LISTINGS_EXPORT],
      requestBody: {
        contentType: 'application/json',
        schema: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['csv', 'excel', 'json', 'xml'] },
            filters: { type: 'object' },
            template: { type: 'string', enum: ['basic', 'detailed', 'financial', 'contact'] },
            limit: { type: 'number', minimum: 1, maximum: 50000 },
            includeMetadata: { type: 'boolean', default: true },
          },
          required: ['format']
        },
        example: {
          format: 'excel',
          filters: { state: 'CA', industry: 'restaurant' },
          template: 'detailed',
          limit: 5000,
          includeMetadata: true
        }
      },
      responses: [
        {
          status: 200,
          description: 'File exported successfully',
          example: 'Binary file content with appropriate headers'
        },
        { status: 400, description: 'Invalid export request' },
        { status: 404, description: 'No data found matching criteria' },
      ],
      examples: [
        {
          title: 'Export restaurant data to Excel',
          description: 'Export detailed restaurant listings to Excel format',
          request: {
            method: 'POST',
            url: '/api/export',
            body: { format: 'excel', template: 'detailed', filters: { industry: 'restaurant' } }
          },
          response: { status: 200, body: 'Binary Excel file' }
        }
      ],
      rateLimit: { basic: '5/hour', premium: '50/hour', enterprise: '500/hour' }
    }
  ],
  monitoring: [
    {
      method: 'GET',
      path: '/api/monitoring/system',
      summary: 'System health check',
      description: 'Get comprehensive system health status including services, resources, and performance metrics.',
      auth: 'required',
      permissions: [PERMISSIONS.MONITORING_READ],
      parameters: [
        { name: 'period', in: 'query', type: 'string', required: false, description: 'Time period for metrics', enum: ['1h', '6h', '24h', '7d', '30d'] },
        { name: 'includeDetails', in: 'query', type: 'boolean', required: false, description: 'Include detailed metrics' },
      ],
      responses: [
        {
          status: 200,
          description: 'System health retrieved successfully',
          example: {
            success: true,
            data: {
              status: 'healthy',
              timestamp: 1704067200000,
              uptime: 86400,
              services: {
                database: { status: 'up', responseTime: 15 },
                websocket: { status: 'up', metadata: { connectedClients: 23 } },
                redis: { status: 'up' }
              },
              resources: {
                memory: { usage: 65.2, total: 8589934592 },
                cpu: { usage: 23.1, cores: 8 }
              }
            }
          }
        },
        { status: 503, description: 'System unhealthy' }
      ],
      examples: [
        {
          title: 'Basic health check',
          description: 'Check overall system health',
          request: { method: 'GET', url: '/api/monitoring/system' },
          response: { status: 200, body: '...' }
        }
      ],
      rateLimit: { basic: '60/min', premium: '600/min', enterprise: '6000/min' }
    }
  ],
  webhooks: [
    {
      method: 'POST',
      path: '/api/webhooks',
      summary: 'Create webhook endpoint',
      description: 'Register a new webhook endpoint to receive real-time event notifications.',
      auth: 'required',
      permissions: [PERMISSIONS.WEBSOCKET_SUBSCRIBE],
      requestBody: {
        contentType: 'application/json',
        schema: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'url' },
            events: { type: 'array', items: { type: 'string' }, minItems: 1 },
            metadata: { type: 'object' },
          },
          required: ['url', 'events']
        },
        example: {
          url: 'https://api.yourapp.com/webhooks/bizbuysell',
          events: ['job.completed', 'job.failed', 'listing.batch'],
          metadata: { description: 'Production webhook endpoint' }
        }
      },
      responses: [
        {
          status: 201,
          description: 'Webhook created successfully',
          example: {
            success: true,
            data: {
              id: 'ep_abc123',
              url: 'https://api.yourapp.com/webhooks/bizbuysell',
              events: ['job.completed', 'job.failed'],
              secret: 'whsec_abc123...', // Only returned once
              enabled: true,
              createdAt: '2024-01-01T00:00:00Z'
            }
          }
        }
      ],
      examples: [
        {
          title: 'Create job status webhook',
          description: 'Register webhook for job completion events',
          request: {
            method: 'POST',
            url: '/api/webhooks',
            body: { url: 'https://api.yourapp.com/hooks', events: ['job.completed', 'job.failed'] }
          },
          response: { status: 201, body: '...' }
        }
      ],
      rateLimit: { basic: '10/hour', premium: '100/hour', enterprise: '1000/hour' }
    }
  ],
  auth: [
    {
      method: 'POST',
      path: '/api/auth/keys',
      summary: 'Create API key',
      description: 'Generate a new API key with specified permissions and rate limits (admin only).',
      auth: 'required',
      permissions: [PERMISSIONS.ADMIN_KEYS],
      requestBody: {
        contentType: 'application/json',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            tier: { type: 'string', enum: ['basic', 'premium', 'enterprise'], default: 'basic' },
            permissions: { type: 'array', items: { type: 'string' } },
            expiresIn: { type: 'number', minimum: 1, maximum: 365, description: 'Days until expiration' },
            metadata: { type: 'object' }
          },
          required: ['name']
        },
        example: {
          name: 'Production API Key',
          tier: 'premium',
          permissions: ['jobs:read', 'jobs:create', 'listings:read', 'listings:export'],
          expiresIn: 365,
          metadata: { environment: 'production', team: 'backend' }
        }
      },
      responses: [
        {
          status: 201,
          description: 'API key created successfully',
          example: {
            success: true,
            data: {
              id: 'key_premium_1',
              name: 'Production API Key',
              key: 'sk_live_premium_abc123...', // Only returned once
              secret: 'sec_abc123...', // Only returned once
              tier: 'premium',
              permissions: ['jobs:read', 'jobs:create'],
              enabled: true,
              createdAt: '2024-01-01T00:00:00Z'
            }
          }
        }
      ],
      examples: [
        {
          title: 'Create production API key',
          description: 'Generate a premium API key for production use',
          request: {
            method: 'POST',
            url: '/api/auth/keys',
            body: { name: 'Production Key', tier: 'premium' }
          },
          response: { status: 201, body: '...' }
        }
      ],
      rateLimit: { basic: '5/hour', premium: '50/hour', enterprise: '500/hour' }
    }
  ],
};

const QuerySchema = z.object({
  category: z.string().optional(),
  format: z.enum(['json', 'openapi']).default('json'),
  version: z.string().optional(),
});

// GET /api/docs - API Documentation
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = QuerySchema.parse({
      category: searchParams.get('category'),
      format: searchParams.get('format') || 'json',
      version: searchParams.get('version'),
    });

    console.log(`📚 API documentation request: ${query.format} format`);

    if (query.format === 'openapi') {
      return NextResponse.json(generateOpenAPISpec(query.category));
    }

    const documentation = {
      info: {
        title: 'BizBuySell Scraper API',
        version: '1.0.0',
        description: 'Comprehensive API for scraping and managing business listings from BizBuySell',
        contact: {
          name: 'API Support',
          url: 'https://github.com/your-repo/issues',
        },
        license: {
          name: 'MIT',
          url: 'https://opensource.org/licenses/MIT',
        },
      },
      authentication: {
        type: 'API Key',
        description: 'Include your API key in the X-API-Key header',
        example: 'X-API-Key: sk_live_premium_abc123...',
        permissions: {
          description: 'API keys have different permission levels based on their tier',
          tiers: {
            basic: {
              description: 'Limited access to read operations',
              rateLimit: '100 requests/minute',
              permissions: ['jobs:read', 'listings:read', 'websocket:connect'],
            },
            premium: {
              description: 'Full access to most operations',
              rateLimit: '1000 requests/minute',
              permissions: ['jobs:*', 'listings:*', 'monitoring:read', 'websocket:*'],
            },
            enterprise: {
              description: 'Full access including admin operations',
              rateLimit: '10000 requests/minute',
              permissions: ['*'],
            },
          },
        },
      },
      rateLimiting: {
        description: 'Rate limits are enforced per API key and endpoint',
        headers: {
          'X-RateLimit-Limit': 'Maximum requests allowed per window',
          'X-RateLimit-Remaining': 'Requests remaining in current window',
          'X-RateLimit-Reset': 'Unix timestamp when the window resets',
          'Retry-After': 'Seconds to wait before retrying (when rate limited)',
        },
      },
      websockets: {
        description: 'Real-time updates via WebSocket connections',
        url: 'ws://localhost:8080',
        authentication: 'Send API key in connection query: ?apiKey=sk_...',
        subscriptions: [
          { topic: 'jobs', description: 'All job updates' },
          { topic: 'job:${jobId}', description: 'Specific job updates' },
          { topic: 'system', description: 'System status updates' },
          { topic: 'progress', description: 'All scraping progress updates' },
        ],
      },
      webhooks: {
        description: 'HTTP callbacks for real-time event notifications',
        signatureVerification: {
          algorithm: 'HMAC-SHA256',
          header: 'X-Webhook-Signature-256',
          format: 'sha256=<hex_digest>',
        },
        eventTypes: Object.keys(require('@/lib/webhooks/webhook-manager').WebhookEventTypes || {}),
        retryPolicy: {
          attempts: 5,
          delays: ['5s', '30s', '2m', '10m', '1h'],
          timeout: '30s',
        },
      },
      endpoints: query.category && API_DOCUMENTATION[query.category]
        ? { [query.category]: API_DOCUMENTATION[query.category] }
        : API_DOCUMENTATION,
    };

    return NextResponse.json({
      success: true,
      data: documentation,
      metadata: {
        category: query.category,
        format: query.format,
        generatedAt: new Date().toISOString(),
        totalEndpoints: Object.values(API_DOCUMENTATION).flat().length,
      },
    });

  } catch (error) {
    console.error('Failed to generate API documentation:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid documentation query',
        details: error.issues,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to generate API documentation',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

function generateOpenAPISpec(category?: string): any {
  const endpoints = category && API_DOCUMENTATION[category]
    ? API_DOCUMENTATION[category]
    : Object.values(API_DOCUMENTATION).flat();

  const paths: any = {};
  const components: any = {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      },
    },
  };

  endpoints.forEach(endpoint => {
    if (!paths[endpoint.path]) {
      paths[endpoint.path] = {};
    }

    paths[endpoint.path][endpoint.method.toLowerCase()] = {
      summary: endpoint.summary,
      description: endpoint.description,
      security: endpoint.auth === 'required' ? [{ ApiKeyAuth: [] }] : [],
      parameters: endpoint.parameters?.map(param => ({
        name: param.name,
        in: param.in,
        required: param.required,
        description: param.description,
        schema: {
          type: param.type,
          enum: param.enum,
          example: param.example,
        },
      })),
      requestBody: endpoint.requestBody ? {
        required: true,
        content: {
          [endpoint.requestBody.contentType]: {
            schema: endpoint.requestBody.schema,
            example: endpoint.requestBody.example,
          },
        },
      } : undefined,
      responses: Object.fromEntries(
        endpoint.responses.map(response => [
          response.status.toString(),
          {
            description: response.description,
            content: response.example ? {
              'application/json': {
                example: response.example,
              },
            } : undefined,
          },
        ])
      ),
    };
  });

  return {
    openapi: '3.0.0',
    info: {
      title: 'BizBuySell Scraper API',
      version: '1.0.0',
      description: 'Comprehensive API for scraping and managing business listings',
    },
    servers: [
      { url: 'http://localhost:3000', description: 'Development server' },
      { url: 'https://api.yourdomain.com', description: 'Production server' },
    ],
    paths,
    components,
  };
}