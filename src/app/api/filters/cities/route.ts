import { NextRequest, NextResponse } from 'next/server';
import { filterManager } from '@/lib/filters/filter-manager';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const state = searchParams.get('state');

    if (!state) {
      return NextResponse.json({
        success: false,
        error: 'State parameter is required',
      }, { status: 400 });
    }

    const cities = await filterManager.getCitiesByState(state);

    return NextResponse.json({
      success: true,
      state,
      cities,
    });

  } catch (error) {
    console.error('Error fetching cities:', error);

    return NextResponse.json({
      success: false,
      error: 'Failed to fetch cities',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}