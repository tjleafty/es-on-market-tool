import { EventEmitter } from 'events';
import { WriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface ScrapingMetrics {
  startTime: number;
  endTime?: number;
  duration?: number;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  totalPages: number;
  pagesScraped: number;
  totalListings: number;
  listingsProcessed: number;
  listingsSuccessful: number;
  listingsFailed: number;
  duplicatesSkipped: number;
  errorsEncountered: number;
  averagePageTime: number;
  averageListingTime: number;
  throughputListingsPerMinute: number;
  memoryUsageMB: number;
  proxyStats?: {
    enabled: boolean;
    totalProxies: number;
    healthyProxies: number;
  };
}

export interface AlertConfig {
  errorThreshold: number; // Number of errors before alert
  slowResponseThreshold: number; // Seconds
  memoryThresholdMB: number;
  webhookUrl?: string;
  emailConfig?: {
    enabled: boolean;
    recipients: string[];
    smtpConfig: any;
  };
}

export interface LogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  context?: string;
  data?: any;
  jobId?: string;
  sessionId?: string;
}

export class ScrapingMonitor extends EventEmitter {
  private metrics: ScrapingMetrics;
  private alertConfig: AlertConfig;
  private logEntries: LogEntry[] = [];
  private logStream?: WriteStream;
  private sessionId: string;
  private monitoringInterval?: NodeJS.Timeout;
  private alertCounts = {
    errors: 0,
    slowResponses: 0,
    memoryWarnings: 0,
  };

  constructor(alertConfig: Partial<AlertConfig> = {}) {
    super();

    this.sessionId = this.generateSessionId();
    this.alertConfig = {
      errorThreshold: 10,
      slowResponseThreshold: 30,
      memoryThresholdMB: 1024,
      ...alertConfig,
    };

    this.metrics = {
      startTime: Date.now(),
      totalJobs: 0,
      completedJobs: 0,
      failedJobs: 0,
      totalPages: 0,
      pagesScraped: 0,
      totalListings: 0,
      listingsProcessed: 0,
      listingsSuccessful: 0,
      listingsFailed: 0,
      duplicatesSkipped: 0,
      errorsEncountered: 0,
      averagePageTime: 0,
      averageListingTime: 0,
      throughputListingsPerMinute: 0,
      memoryUsageMB: 0,
    };

    this.startMonitoring();
  }

  async startSession(logFilePath?: string): Promise<void> {
    console.log(`📊 Starting monitoring session: ${this.sessionId}`);

    // Initialize log file if path provided
    if (logFilePath) {
      await this.initializeLogFile(logFilePath);
    }

    this.log('info', 'Monitoring session started', 'monitor', {
      sessionId: this.sessionId,
      alertConfig: this.alertConfig,
    });

    this.emit('sessionStarted', { sessionId: this.sessionId, startTime: this.metrics.startTime });
  }

  async endSession(): Promise<ScrapingMetrics> {
    console.log(`📊 Ending monitoring session: ${this.sessionId}`);

    this.metrics.endTime = Date.now();
    this.metrics.duration = this.metrics.endTime - this.metrics.startTime;

    // Calculate final metrics
    this.calculateFinalMetrics();

    this.log('info', 'Monitoring session ended', 'monitor', {
      sessionId: this.sessionId,
      finalMetrics: this.metrics,
    });

    // Stop monitoring
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    // Close log file
    if (this.logStream) {
      this.logStream.end();
    }

    this.emit('sessionEnded', { sessionId: this.sessionId, metrics: this.metrics });

    return this.metrics;
  }

  updateMetrics(updates: Partial<ScrapingMetrics>): void {
    Object.assign(this.metrics, updates);

    // Check for alerts
    this.checkAlerts();

    this.emit('metricsUpdated', this.metrics);
  }

  incrementCounter(counter: keyof ScrapingMetrics): void {
    if (typeof this.metrics[counter] === 'number') {
      (this.metrics[counter] as number)++;
    }
  }

  recordPageScrapeTime(timeMs: number): void {
    this.metrics.pagesScraped++;

    // Update average using exponential moving average
    const alpha = 0.1;
    this.metrics.averagePageTime = this.metrics.averagePageTime === 0
      ? timeMs
      : (alpha * timeMs) + ((1 - alpha) * this.metrics.averagePageTime);

    // Check for slow response alert
    if (timeMs > this.alertConfig.slowResponseThreshold * 1000) {
      this.alertCounts.slowResponses++;
      this.log('warn', `Slow page scrape detected: ${timeMs}ms`, 'performance', {
        pageTime: timeMs,
        threshold: this.alertConfig.slowResponseThreshold * 1000,
      });
    }
  }

  recordListingProcessTime(timeMs: number): void {
    this.metrics.listingsProcessed++;

    // Update average using exponential moving average
    const alpha = 0.1;
    this.metrics.averageListingTime = this.metrics.averageListingTime === 0
      ? timeMs
      : (alpha * timeMs) + ((1 - alpha) * this.metrics.averageListingTime);
  }

  log(level: LogEntry['level'], message: string, context?: string, data?: any, jobId?: string): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      message,
      context,
      data,
      jobId,
      sessionId: this.sessionId,
    };

    this.logEntries.push(entry);

    // Keep only recent log entries in memory
    if (this.logEntries.length > 1000) {
      this.logEntries = this.logEntries.slice(-500);
    }

    // Write to log file if available
    if (this.logStream) {
      this.logStream.write(JSON.stringify(entry) + '\n');
    }

    // Console output with formatting
    const timestamp = new Date(entry.timestamp).toISOString();
    const contextStr = context ? `[${context}]` : '';
    const jobStr = jobId ? `[job:${jobId}]` : '';

    switch (level) {
      case 'error':
        console.error(`❌ ${timestamp} ${contextStr}${jobStr} ${message}`, data ? data : '');
        this.metrics.errorsEncountered++;
        this.alertCounts.errors++;
        break;
      case 'warn':
        console.warn(`⚠️  ${timestamp} ${contextStr}${jobStr} ${message}`, data ? data : '');
        break;
      case 'info':
        console.log(`ℹ️  ${timestamp} ${contextStr}${jobStr} ${message}`, data ? data : '');
        break;
      case 'debug':
        if (process.env.NODE_ENV === 'development') {
          console.debug(`🐛 ${timestamp} ${contextStr}${jobStr} ${message}`, data ? data : '');
        }
        break;
    }

    this.emit('logEntry', entry);
  }

  getMetrics(): ScrapingMetrics {
    // Update throughput
    const currentTime = Date.now();
    const elapsedMinutes = (currentTime - this.metrics.startTime) / (1000 * 60);
    this.metrics.throughputListingsPerMinute = elapsedMinutes > 0
      ? this.metrics.listingsSuccessful / elapsedMinutes
      : 0;

    // Update memory usage
    const memoryUsage = process.memoryUsage();
    this.metrics.memoryUsageMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);

    return { ...this.metrics };
  }

  getRecentLogs(count: number = 100): LogEntry[] {
    return this.logEntries.slice(-count);
  }

  getLogsByLevel(level: LogEntry['level'], count: number = 50): LogEntry[] {
    return this.logEntries
      .filter(entry => entry.level === level)
      .slice(-count);
  }

  async exportLogs(filePath: string, format: 'json' | 'csv' = 'json'): Promise<void> {
    try {
      let content: string;

      if (format === 'json') {
        content = JSON.stringify(this.logEntries, null, 2);
      } else {
        // CSV format
        const headers = 'timestamp,level,message,context,jobId,sessionId\n';
        const rows = this.logEntries.map(entry => [
          new Date(entry.timestamp).toISOString(),
          entry.level,
          `"${entry.message.replace(/"/g, '""')}"`, // Escape quotes
          entry.context || '',
          entry.jobId || '',
          entry.sessionId,
        ].join(','));

        content = headers + rows.join('\n');
      }

      await fs.writeFile(filePath, content, 'utf-8');
      console.log(`📄 Logs exported to: ${filePath}`);

    } catch (error) {
      console.error('Failed to export logs:', error);
      throw error;
    }
  }

  private async initializeLogFile(logFilePath: string): Promise<void> {
    try {
      // Ensure directory exists
      const dir = path.dirname(logFilePath);
      await fs.mkdir(dir, { recursive: true });

      // Create write stream
      this.logStream = require('fs').createWriteStream(logFilePath, { flags: 'a' });

      console.log(`📝 Logging to file: ${logFilePath}`);
    } catch (error) {
      console.error('Failed to initialize log file:', error);
    }
  }

  private startMonitoring(): void {
    this.monitoringInterval = setInterval(() => {
      // Update memory usage
      const memoryUsage = process.memoryUsage();
      this.metrics.memoryUsageMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);

      // Check memory threshold
      if (this.metrics.memoryUsageMB > this.alertConfig.memoryThresholdMB) {
        this.alertCounts.memoryWarnings++;
        this.log('warn', `High memory usage: ${this.metrics.memoryUsageMB}MB`, 'system', {
          memoryUsage: this.metrics.memoryUsageMB,
          threshold: this.alertConfig.memoryThresholdMB,
        });
      }

      // Emit periodic metrics update
      this.emit('periodicUpdate', this.getMetrics());

    }, 30000); // Every 30 seconds
  }

  private checkAlerts(): void {
    // Error threshold alert
    if (this.alertCounts.errors >= this.alertConfig.errorThreshold) {
      this.sendAlert('error', `Error threshold exceeded: ${this.alertCounts.errors} errors`);
      this.alertCounts.errors = 0; // Reset counter
    }

    // Memory threshold alert
    if (this.alertCounts.memoryWarnings >= 3) {
      this.sendAlert('warning', `Persistent high memory usage: ${this.metrics.memoryUsageMB}MB`);
      this.alertCounts.memoryWarnings = 0; // Reset counter
    }
  }

  private async sendAlert(type: 'error' | 'warning', message: string): Promise<void> {
    console.log(`🚨 ALERT [${type}]: ${message}`);

    const alertData = {
      type,
      message,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      metrics: this.getMetrics(),
    };

    // Emit alert event
    this.emit('alert', alertData);

    // Send webhook if configured
    if (this.alertConfig.webhookUrl) {
      try {
        await this.sendWebhookAlert(alertData);
      } catch (error) {
        console.error('Failed to send webhook alert:', error);
      }
    }

    // Send email if configured
    if (this.alertConfig.emailConfig?.enabled) {
      try {
        await this.sendEmailAlert(alertData);
      } catch (error) {
        console.error('Failed to send email alert:', error);
      }
    }
  }

  private async sendWebhookAlert(alertData: any): Promise<void> {
    // Implementation would send POST request to webhook URL
    console.log(`📡 Would send webhook alert to: ${this.alertConfig.webhookUrl}`);
  }

  private async sendEmailAlert(alertData: any): Promise<void> {
    // Implementation would send email using SMTP
    console.log(`📧 Would send email alert to: ${this.alertConfig.emailConfig?.recipients.join(', ')}`);
  }

  private calculateFinalMetrics(): void {
    const duration = this.metrics.duration || 0;
    const elapsedMinutes = duration / (1000 * 60);

    if (elapsedMinutes > 0) {
      this.metrics.throughputListingsPerMinute = this.metrics.listingsSuccessful / elapsedMinutes;
    }
  }

  private generateSessionId(): string {
    return `scrape_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  // Health check methods
  getHealthStatus(): {
    status: 'healthy' | 'warning' | 'critical';
    issues: string[];
    recommendations: string[];
  } {
    const issues: string[] = [];
    const recommendations: string[] = [];

    // Check error rate
    const errorRate = this.metrics.listingsProcessed > 0
      ? (this.metrics.listingsFailed / this.metrics.listingsProcessed) * 100
      : 0;

    if (errorRate > 20) {
      issues.push(`High error rate: ${errorRate.toFixed(1)}%`);
      recommendations.push('Check data sources and extraction logic');
    }

    // Check memory usage
    if (this.metrics.memoryUsageMB > this.alertConfig.memoryThresholdMB) {
      issues.push(`High memory usage: ${this.metrics.memoryUsageMB}MB`);
      recommendations.push('Consider reducing concurrency or implementing memory optimization');
    }

    // Check throughput
    if (this.metrics.throughputListingsPerMinute < 1 && this.metrics.listingsProcessed > 10) {
      issues.push(`Low throughput: ${this.metrics.throughputListingsPerMinute.toFixed(2)} listings/min`);
      recommendations.push('Consider increasing concurrency or optimizing extraction logic');
    }

    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (issues.length > 0) {
      status = errorRate > 50 || this.metrics.memoryUsageMB > this.alertConfig.memoryThresholdMB * 1.5
        ? 'critical'
        : 'warning';
    }

    return { status, issues, recommendations };
  }
}