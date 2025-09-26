import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/database';
import { jobQueue } from '@/lib/jobs/database-queue';
import { FilterValidator } from '@/lib/scraper/filters/filter-validator';

const ScrapeRequestSchema = z.object({
  filters: z.record(z.string(), z.any()).default({}),
  priority: z.number().min(1).max(10).default(5),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { filters, priority } = ScrapeRequestSchema.parse(body);

    const validatedFilters = FilterValidator.validate(filters);
    const sanitizedFilters = FilterValidator.sanitizeFilters(validatedFilters);

    const scrapeJob = await prisma.scrapeJob.create({
      data: {
        filters: sanitizedFilters as any,
        status: 'PENDING',
      },
    });

    // Job is already created in database with PENDING status
    // The database queue will automatically process it

    return NextResponse.json({
      success: true,
      jobId: scrapeJob.id,
      status: 'PENDING',
      message: 'Scrape job created successfully',
    });

  } catch (error) {
    console.error('Error creating scrape job:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid request data',
        details: error.issues,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to create scrape job',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}