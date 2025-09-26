import Bull from 'bull';
import { getRedisClient } from './redis';

export interface ScrapeJobData {
  id: string;
  filters: Record<string, any>;
  priority?: number;
}

export interface ScrapeJobResult {
  listingsFound: number;
  listingsScraped: number;
  errors: string[];
}

export const scrapeQueue = new Bull<ScrapeJobData>('scrape-queue', {
  redis: {
    host: process.env.REDIS_URL?.split('://')[1]?.split(':')[0] || 'localhost',
    port: parseInt(process.env.REDIS_URL?.split(':')[2] || '6379'),
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 50,
    removeOnFail: 10,
  },
});

export default scrapeQueue;