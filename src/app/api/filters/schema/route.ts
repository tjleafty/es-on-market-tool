import { NextResponse } from 'next/server';
import { FilterValidator } from '@/lib/scraper/filters/filter-validator';

export async function GET() {
  try {
    const schema = FilterValidator.getValidationSchema();

    return NextResponse.json({
      success: true,
      schema,
      description: 'Valid options and constraints for filter parameters',
    });

  } catch (error) {
    console.error('Error fetching filter schema:', error);

    return NextResponse.json({
      success: false,
      error: 'Failed to fetch filter schema',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}