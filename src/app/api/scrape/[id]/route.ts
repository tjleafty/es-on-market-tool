import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/database';
import { jobQueue } from '@/lib/jobs/database-queue';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json({
        success: false,
        error: 'Job ID is required',
      }, { status: 400 });
    }

    const scrapeJob = await prisma.scrapeJob.findUnique({
      where: { id },
    });

    if (!scrapeJob) {
      return NextResponse.json({
        success: false,
        error: 'Scrape job not found',
      }, { status: 404 });
    }

    // Database queue - progress is stored directly in the job record
    const progress = {
      current: scrapeJob.progress,
      total: 100,
      percentage: scrapeJob.progress,
    };

    return NextResponse.json({
      success: true,
      job: {
        id: scrapeJob.id,
        status: scrapeJob.status,
        filters: scrapeJob.filters,
        resultCount: scrapeJob.listingsFound,
        error: scrapeJob.error,
        startedAt: scrapeJob.startedAt,
        completedAt: scrapeJob.completedAt,
        createdAt: scrapeJob.createdAt,
        progress,
      },
    });

  } catch (error) {
    console.error('Error fetching scrape job:', error);

    return NextResponse.json({
      success: false,
      error: 'Failed to fetch scrape job',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json({
        success: false,
        error: 'Job ID is required',
      }, { status: 400 });
    }

    // Database queue - job will be cancelled via database update

    await prisma.scrapeJob.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        completedAt: new Date(),
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Scrape job cancelled successfully',
    });

  } catch (error) {
    console.error('Error cancelling scrape job:', error);

    return NextResponse.json({
      success: false,
      error: 'Failed to cancel scrape job',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}