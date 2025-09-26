import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/database';
import { queryBuilder } from '@/lib/filters/query-builder';
import { FilterValidator } from '@/lib/scraper/filters/filter-validator';
import * as XLSX from 'xlsx';
import { parse } from 'json2csv';

const ExportRequestSchema = z.object({
  format: z.enum(['csv', 'excel', 'json', 'xml']),
  filters: z.record(z.string(), z.any()).default({}),
  search: z.string().optional(),
  fields: z.array(z.string()).optional(),
  limit: z.number().min(1).max(10000).default(1000), // Reduced for serverless
  sortBy: z.enum(['newest', 'oldest', 'price-low-high', 'price-high-low', 'revenue-high-low']).optional(),
  includeMetadata: z.boolean().default(true),
  template: z.enum(['basic', 'detailed', 'financial', 'contact']).default('basic'),
  customFields: z.array(z.object({
    name: z.string(),
    expression: z.string(),
  })).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const exportRequest = ExportRequestSchema.parse(body);

    console.log(`📊 Export request: ${exportRequest.format} format, ${exportRequest.limit} records`);

    // Validate filters if provided
    let validatedFilters = {};
    if (Object.keys(exportRequest.filters).length > 0) {
      validatedFilters = FilterValidator.validatePartial(exportRequest.filters);
    }

    // Build query
    const where = queryBuilder.combineFiltersWithSearch(validatedFilters, exportRequest.search);
    const orderBy = buildOrderBy(exportRequest.sortBy);

    // Get field configuration based on template
    const fieldConfig = getFieldConfiguration(exportRequest.template, exportRequest.fields);

    // Fetch data
    const listings = await prisma.businessListing.findMany({
      where,
      select: fieldConfig.select,
      orderBy,
      take: exportRequest.limit,
    });

    console.log(`📋 Retrieved ${listings.length} listings for export`);

    if (listings.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'No data found matching the criteria',
      }, { status: 404 });
    }

    // Process and transform data
    const processedData = await processDataForExport(listings, exportRequest);

    // Generate filename
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `business-listings-${timestamp}.${exportRequest.format === 'excel' ? 'xlsx' : exportRequest.format}`;

    // Export based on format
    switch (exportRequest.format) {
      case 'csv':
        return exportAsCSV(processedData, filename, exportRequest);

      case 'excel':
        return exportAsExcel(processedData, filename, exportRequest);

      case 'json':
        return exportAsJSON(processedData, filename, exportRequest);

      case 'xml':
        return exportAsXML(processedData, filename, exportRequest);

      default:
        return NextResponse.json({
          success: false,
          error: 'Unsupported export format',
        }, { status: 400 });
    }

  } catch (error) {
    console.error('Export error:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid export request',
        details: error.issues,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Export failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

function getFieldConfiguration(template: string, customFields?: string[]) {
  const configs = {
    basic: {
      select: {
        id: true,
        bizBuySellId: true,
        title: true,
        askingPrice: true,
        location: true,
        state: true,
        industry: true,
        listedDate: true,
        createdAt: true,
      },
      displayFields: [
        'ID', 'BizBuySell ID', 'Title', 'Asking Price', 'Location', 'State', 'Industry', 'Listed Date', 'Scraped Date'
      ],
    },
    detailed: {
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
        established: true,
        employees: true,
        sellerFinancing: true,
        features: true,
        reasonForSelling: true,
        createdAt: true,
        updatedAt: true,
      },
      displayFields: [
        'ID', 'BizBuySell ID', 'Title', 'Asking Price', 'Revenue', 'Cash Flow', 'Location', 'State', 'City',
        'Industry', 'Description', 'Listed Date', 'Established', 'Employees', 'Seller Financing',
        'Features', 'Reason for Selling', 'Scraped Date', 'Updated Date'
      ],
    },
    financial: {
      select: {
        id: true,
        bizBuySellId: true,
        title: true,
        askingPrice: true,
        revenue: true,
        cashFlow: true,
        established: true,
        employees: true,
        sellerFinancing: true,
        industry: true,
        state: true,
      },
      displayFields: [
        'ID', 'BizBuySell ID', 'Title', 'Asking Price', 'Revenue', 'Cash Flow', 'Established', 'Employees',
        'Seller Financing', 'Industry', 'State'
      ],
    },
    contact: {
      select: {
        id: true,
        bizBuySellId: true,
        title: true,
        contactName: true,
        contactEmail: true,
        contactPhone: true,
        brokerName: true,
        brokerCompany: true,
        location: true,
        industry: true,
        askingPrice: true,
      },
      displayFields: [
        'ID', 'BizBuySell ID', 'Title', 'Contact Name', 'Contact Email', 'Contact Phone',
        'Broker Name', 'Broker Company', 'Location', 'Industry', 'Asking Price'
      ],
    },
  };

  let config = configs[template as keyof typeof configs] || configs.basic;

  // Override with custom fields if provided
  if (customFields && customFields.length > 0) {
    const customSelect: any = {};
    customFields.forEach(field => {
      if (field in config.select) {
        customSelect[field] = true;
      }
    });

    if (Object.keys(customSelect).length > 0) {
      config = {
        select: customSelect,
        displayFields: customFields,
      };
    }
  }

  return config;
}

function buildOrderBy(sortBy?: string) {
  switch (sortBy) {
    case 'price-low-high':
      return [{ askingPrice: 'asc' as const }];
    case 'price-high-low':
      return [{ askingPrice: 'desc' as const }];
    case 'revenue-high-low':
      return [{ revenue: 'desc' as const }];
    case 'oldest':
      return [{ listedDate: 'asc' as const }];
    case 'newest':
    default:
      return [{ listedDate: 'desc' as const }];
  }
}

async function processDataForExport(listings: any[], request: any) {
  const processedData = listings.map(listing => {
    const processed = { ...listing };

    // Format dates
    if (processed.listedDate) {
      processed.listedDate = new Date(processed.listedDate).toLocaleDateString();
    }
    if (processed.createdAt) {
      processed.createdAt = new Date(processed.createdAt).toLocaleDateString();
    }
    if (processed.updatedAt) {
      processed.updatedAt = new Date(processed.updatedAt).toLocaleDateString();
    }

    // Format currency fields
    const currencyFields = ['askingPrice', 'revenue', 'cashFlow'];
    currencyFields.forEach(field => {
      if (processed[field] !== null && processed[field] !== undefined) {
        processed[field] = `$${processed[field].toLocaleString()}`;
      }
    });

    // Format arrays
    if (processed.features && Array.isArray(processed.features)) {
      processed.features = processed.features.join(', ');
    }

    // Format boolean fields
    if (processed.sellerFinancing !== null && processed.sellerFinancing !== undefined) {
      processed.sellerFinancing = processed.sellerFinancing ? 'Yes' : 'No';
    }

    // Add computed fields
    if (request.includeMetadata) {
      processed.computedFields = {};

      if (listing.askingPrice && listing.revenue) {
        processed.computedFields.priceToRevenue = (listing.askingPrice / listing.revenue).toFixed(2);
      }

      if (listing.askingPrice && listing.cashFlow) {
        processed.computedFields.priceToEbitda = (listing.askingPrice / listing.cashFlow).toFixed(2);
      }

      if (listing.listedDate) {
        const daysListed = Math.floor((Date.now() - new Date(listing.listedDate).getTime()) / (1000 * 60 * 60 * 24));
        processed.computedFields.daysListed = daysListed;
      }
    }

    // Apply custom fields if any
    if (request.customFields) {
      request.customFields.forEach((customField: any) => {
        try {
          // Simple expression evaluation (in production, use a safe expression evaluator)
          processed[customField.name] = evaluateExpression(customField.expression, listing);
        } catch (error) {
          processed[customField.name] = 'Error';
        }
      });
    }

    return processed;
  });

  return processedData;
}

function evaluateExpression(expression: string, data: any): any {
  // Simple expression evaluator - in production, use a proper expression parser
  try {
    // Replace field references with actual values
    let evalExpression = expression;
    Object.keys(data).forEach(key => {
      const regex = new RegExp(`\\b${key}\\b`, 'g');
      evalExpression = evalExpression.replace(regex, data[key] || 0);
    });

    // Basic safety check - only allow numbers and basic operators
    if (!/^[\d+\-*/.() ]+$/.test(evalExpression)) {
      throw new Error('Invalid expression');
    }

    return eval(evalExpression);
  } catch (error) {
    return 'Error';
  }
}

function exportAsCSV(data: any[], filename: string, request: any): NextResponse {
  try {
    const fields = Object.keys(data[0] || {}).filter(key => key !== 'computedFields');

    // Add computed fields if included
    if (request.includeMetadata && data[0]?.computedFields) {
      const computedFields = Object.keys(data[0].computedFields).map(key => `computed_${key}`);
      fields.push(...computedFields);
    }

    // Flatten computed fields
    const flattenedData = data.map(item => {
      const flattened = { ...item };
      if (item.computedFields) {
        Object.keys(item.computedFields).forEach(key => {
          flattened[`computed_${key}`] = item.computedFields[key];
        });
        delete flattened.computedFields;
      }
      return flattened;
    });

    const csv = parse(flattenedData, { fields });

    const headers = new Headers();
    headers.set('Content-Type', 'text/csv');
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    headers.set('X-Export-Count', data.length.toString());

    return new NextResponse(csv, { headers });

  } catch (error) {
    throw new Error(`CSV export failed: ${error}`);
  }
}

function exportAsExcel(data: any[], filename: string, request: any): NextResponse {
  try {
    // Create workbook
    const wb = XLSX.utils.book_new();

    // Prepare data for Excel
    const excelData = data.map(item => {
      const row: any = { ...item };

      // Flatten computed fields
      if (item.computedFields) {
        Object.keys(item.computedFields).forEach(key => {
          row[`Computed: ${key}`] = item.computedFields[key];
        });
        delete row.computedFields;
      }

      return row;
    });

    // Create main worksheet
    const ws = XLSX.utils.json_to_sheet(excelData);

    // Add column widths
    const colWidths = Object.keys(excelData[0] || {}).map(key => ({
      wch: Math.min(Math.max(key.length, 10), 50)
    }));
    ws['!cols'] = colWidths;

    XLSX.utils.book_append_sheet(wb, ws, 'Business Listings');

    // Add summary sheet if metadata included
    if (request.includeMetadata) {
      const summary = [
        { Metric: 'Total Records', Value: data.length },
        { Metric: 'Export Date', Value: new Date().toISOString() },
        { Metric: 'Export Format', Value: 'Excel' },
        { Metric: 'Template Used', Value: request.template },
      ];

      const summaryWs = XLSX.utils.json_to_sheet(summary);
      XLSX.utils.book_append_sheet(wb, summaryWs, 'Export Summary');
    }

    // Write to buffer
    const excelBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const headers = new Headers();
    headers.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    headers.set('X-Export-Count', data.length.toString());

    return new NextResponse(excelBuffer, { headers });

  } catch (error) {
    throw new Error(`Excel export failed: ${error}`);
  }
}

function exportAsJSON(data: any[], filename: string, request: any): NextResponse {
  try {
    const exportData = {
      exportInfo: {
        exportDate: new Date().toISOString(),
        format: 'JSON',
        template: request.template,
        recordCount: data.length,
        filters: request.filters,
      },
      data: data,
    };

    const jsonString = JSON.stringify(exportData, null, 2);

    const headers = new Headers();
    headers.set('Content-Type', 'application/json');
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    headers.set('X-Export-Count', data.length.toString());

    return new NextResponse(jsonString, { headers });

  } catch (error) {
    throw new Error(`JSON export failed: ${error}`);
  }
}

function exportAsXML(data: any[], filename: string, request: any): NextResponse {
  try {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<BusinessListings>\n';

    if (request.includeMetadata) {
      xml += '  <ExportInfo>\n';
      xml += `    <ExportDate>${new Date().toISOString()}</ExportDate>\n`;
      xml += `    <Format>XML</Format>\n`;
      xml += `    <Template>${request.template}</Template>\n`;
      xml += `    <RecordCount>${data.length}</RecordCount>\n`;
      xml += '  </ExportInfo>\n';
    }

    xml += '  <Listings>\n';

    data.forEach(listing => {
      xml += '    <Listing>\n';

      Object.keys(listing).forEach(key => {
        if (key === 'computedFields') {
          xml += '      <ComputedFields>\n';
          Object.keys(listing[key] || {}).forEach(computedKey => {
            const value = listing[key][computedKey];
            xml += `        <${computedKey}>${escapeXml(value)}</${computedKey}>\n`;
          });
          xml += '      </ComputedFields>\n';
        } else {
          const value = listing[key];
          if (value !== null && value !== undefined) {
            xml += `      <${key}>${escapeXml(value)}</${key}>\n`;
          }
        }
      });

      xml += '    </Listing>\n';
    });

    xml += '  </Listings>\n';
    xml += '</BusinessListings>';

    const headers = new Headers();
    headers.set('Content-Type', 'application/xml');
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    headers.set('X-Export-Count', data.length.toString());

    return new NextResponse(xml, { headers });

  } catch (error) {
    throw new Error(`XML export failed: ${error}`);
  }
}

function escapeXml(unsafe: any): string {
  if (unsafe === null || unsafe === undefined) return '';

  return String(unsafe).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}