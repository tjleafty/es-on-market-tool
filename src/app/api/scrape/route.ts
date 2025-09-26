import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/database';
import { scrapeQueue } from '@/lib/queue/scrape-queue';
import { FilterValidator } from '@/lib/scraper/filters/filter-validator';

const ScrapeRequestSchema = z.object({
  filters: z.record(z.any()).default({}),
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
        filters: sanitizedFilters,
        status: 'PENDING',
      },
    });

    await scrapeQueue.add('scrape-listings', {
      id: scrapeJob.id,
      filters: sanitizedFilters,
      priority,
    }, {
      priority,
      jobId: scrapeJob.id,
    });

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
        details: error.errors,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to create scrape job',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}