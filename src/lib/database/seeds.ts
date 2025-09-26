import { prisma } from './index';
import {
  US_STATES,
  BUSINESS_INDUSTRIES,
  PRICE_RANGES,
  REVENUE_RANGES,
  CASH_FLOW_RANGES,
  EMPLOYEE_RANGES,
  ESTABLISHED_RANGES,
  LISTING_FEATURES,
  SORT_OPTIONS,
  MAJOR_METROPOLITAN_AREAS,
} from '../filters/constants';

interface FilterOptionData {
  category: string;
  value: string;
  label: string;
  metadata?: any;
}

export async function seedFilterOptions() {
  console.log('🌱 Starting filter options seed...');

  try {
    // Clear existing filter options
    await prisma.filterOption.deleteMany({});

    const filterOptions: FilterOptionData[] = [];

    // US States
    US_STATES.forEach(state => {
      filterOptions.push({
        category: 'state',
        value: state.value,
        label: state.label,
      });
    });

    // Major Cities
    MAJOR_METROPOLITAN_AREAS.forEach(city => {
      filterOptions.push({
        category: 'city',
        value: city.value,
        label: city.label,
        metadata: { state: city.state },
      });
    });

    // Business Industries
    BUSINESS_INDUSTRIES.forEach(industry => {
      filterOptions.push({
        category: 'industry',
        value: industry.value,
        label: industry.label,
      });
    });

    // Price Ranges
    PRICE_RANGES.forEach(range => {
      filterOptions.push({
        category: 'price_range',
        value: range.value,
        label: range.label,
        metadata: { min: range.min, max: range.max },
      });
    });

    // Revenue Ranges
    REVENUE_RANGES.forEach(range => {
      filterOptions.push({
        category: 'revenue_range',
        value: range.value,
        label: range.label,
        metadata: { min: range.min, max: range.max },
      });
    });

    // Cash Flow Ranges
    CASH_FLOW_RANGES.forEach(range => {
      filterOptions.push({
        category: 'cash_flow_range',
        value: range.value,
        label: range.label,
        metadata: { min: range.min, max: range.max },
      });
    });

    // Employee Ranges
    EMPLOYEE_RANGES.forEach(range => {
      filterOptions.push({
        category: 'employee_range',
        value: range.value,
        label: range.label,
        metadata: { min: range.min, max: range.max },
      });
    });

    // Established Ranges
    ESTABLISHED_RANGES.forEach(range => {
      filterOptions.push({
        category: 'established_range',
        value: range.value,
        label: range.label,
        metadata: { min: range.min, max: range.max },
      });
    });

    // Listing Features
    LISTING_FEATURES.forEach(feature => {
      filterOptions.push({
        category: 'feature',
        value: feature.value,
        label: feature.label,
      });
    });

    // Sort Options
    SORT_OPTIONS.forEach(sort => {
      filterOptions.push({
        category: 'sort',
        value: sort.value,
        label: sort.label,
      });
    });

    // Create filter options in batches
    const batchSize = 100;
    for (let i = 0; i < filterOptions.length; i += batchSize) {
      const batch = filterOptions.slice(i, i + batchSize);
      await prisma.filterOption.createMany({
        data: batch.map(option => ({
          category: option.category,
          value: option.value,
          label: option.label,
          metadata: option.metadata || {},
        })),
      });
    }

    console.log(`✅ Successfully seeded ${filterOptions.length} filter options`);

    // Log summary by category
    const categoryCounts = filterOptions.reduce((acc, option) => {
      acc[option.category] = (acc[option.category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('📊 Filter options by category:');
    Object.entries(categoryCounts).forEach(([category, count]) => {
      console.log(`  ${category}: ${count} options`);
    });

  } catch (error) {
    console.error('❌ Error seeding filter options:', error);
    throw error;
  }
}

export async function seedSampleBusinessListings() {
  console.log('🌱 Starting sample business listings seed...');

  const sampleListings = [
    {
      bizBuySellId: 'BBS001',
      title: 'Profitable Restaurant in Downtown Atlanta',
      askingPrice: 450000,
      revenue: 850000,
      cashFlow: 125000,
      location: 'Atlanta, GA',
      state: 'GA',
      industry: 'restaurants',
      description: 'Well-established restaurant with loyal customer base. Prime downtown location with high foot traffic.',
      listedDate: new Date('2024-01-15'),
      sellerFinancing: true,
      reasonForSelling: 'Retirement',
      employees: 15,
      established: 2015,
      imageUrls: [],
    },
    {
      bizBuySellId: 'BBS002',
      title: 'Tech Consulting Firm - Home Based',
      askingPrice: 125000,
      revenue: 180000,
      cashFlow: 75000,
      location: 'Seattle, WA',
      state: 'WA',
      industry: 'internet-technology',
      description: 'Fully remote tech consulting business with established client base and recurring contracts.',
      listedDate: new Date('2024-02-01'),
      sellerFinancing: false,
      reasonForSelling: 'New opportunity',
      employees: 3,
      established: 2018,
      imageUrls: [],
    },
    {
      bizBuySellId: 'BBS003',
      title: 'Automotive Repair Shop with Real Estate',
      askingPrice: 750000,
      revenue: 420000,
      cashFlow: 95000,
      location: 'Phoenix, AZ',
      state: 'AZ',
      industry: 'automotive',
      description: 'Established automotive repair shop including building and land. Great location with growth potential.',
      listedDate: new Date('2024-01-28'),
      sellerFinancing: true,
      reasonForSelling: 'Owner health issues',
      employees: 8,
      established: 2008,
      imageUrls: [],
    },
  ];

  try {
    for (const listing of sampleListings) {
      await prisma.businessListing.upsert({
        where: { bizBuySellId: listing.bizBuySellId },
        update: listing,
        create: listing,
      });
    }

    console.log(`✅ Successfully seeded ${sampleListings.length} sample business listings`);
  } catch (error) {
    console.error('❌ Error seeding sample listings:', error);
    throw error;
  }
}

export async function runAllSeeds() {
  console.log('🌱 Running all database seeds...\n');

  await seedFilterOptions();
  await seedSampleBusinessListings();

  console.log('\n✅ All seeds completed successfully!');
}

// Run seeds if this file is executed directly
if (require.main === module) {
  runAllSeeds()
    .catch(error => {
      console.error(error);
      process.exit(1);
    })
    .finally(() => {
      prisma.$disconnect();
    });
}