import { NextRequest, NextResponse } from 'next/server';
import { FilterValidator } from '@/lib/scraper/filters/filter-validator';
import { z } from 'zod';

const ValidationRequestSchema = z.object({
  filters: z.record(z.string(), z.any()),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { filters } = ValidationRequestSchema.parse(body);

    // First, try to validate the basic structure
    try {
      const validatedFilters = FilterValidator.validate(filters);

      // Then check for scraping-specific warnings
      const scrapingValidation = FilterValidator.validateForScraping(validatedFilters);

      return NextResponse.json({
        success: true,
        valid: true,
        filters: validatedFilters,
        validation: scrapingValidation,
      });

    } catch (validationError) {
      return NextResponse.json({
        success: true,
        valid: false,
        errors: [validationError instanceof Error ? validationError.message : 'Unknown validation error'],
      });
    }

  } catch (error) {
    console.error('Error in filter validation endpoint:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid request format',
        details: error.issues,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Validation request failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}