import { NextRequest, NextResponse } from 'next/server';
import { filterManager } from '@/lib/filters/filter-manager';
import { FilterValidator } from '@/lib/scraper/filters/filter-validator';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');

    if (category) {
      const options = await filterManager.getFilterOptionsByCategory(category);
      return NextResponse.json({
        success: true,
        category,
        options,
      });
    }

    // Get all filter options grouped by category
    const allOptions = await filterManager.getFilterOptions();

    return NextResponse.json({
      success: true,
      filters: allOptions,
    });

  } catch (error) {
    console.error('Error fetching filter options:', error);

    return NextResponse.json({
      success: false,
      error: 'Failed to fetch filter options',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { filters } = body;

    // Validate the filters
    const validation = FilterValidator.validateForScraping(filters);

    return NextResponse.json({
      success: true,
      validation,
    });

  } catch (error) {
    console.error('Error validating filters:', error);

    return NextResponse.json({
      success: false,
      error: 'Filter validation failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 400 });
  }
}