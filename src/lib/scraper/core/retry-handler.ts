import { Page } from 'playwright';

export interface RetryConfig {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
  retryableErrors?: string[];
  onRetry?: (attempt: number, error: Error) => void;
  onFinalFailure?: (error: Error, attempts: number) => void;
}

export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
  totalTime: number;
}

export enum ErrorType {
  NETWORK = 'network',
  TIMEOUT = 'timeout',
  CAPTCHA = 'captcha',
  BLOCKED = 'blocked',
  RATE_LIMITED = 'rate_limited',
  PARSING = 'parsing',
  UNKNOWN = 'unknown',
}

export class RetryHandler {
  private defaultConfig: Required<RetryConfig> = {
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    retryableErrors: [
      'net::ERR_NETWORK_CHANGED',
      'net::ERR_CONNECTION_RESET',
      'net::ERR_CONNECTION_REFUSED',
      'net::ERR_TIMED_OUT',
      'TimeoutError',
      'ProtocolError',
    ],
    onRetry: () => {},
    onFinalFailure: () => {},
  };

  async executeWithRetry<T>(
    operation: () => Promise<T>,
    config: RetryConfig = {}
  ): Promise<RetryResult<T>> {
    const finalConfig = { ...this.defaultConfig, ...config };
    const startTime = Date.now();
    let lastError: Error;

    for (let attempt = 1; attempt <= finalConfig.maxRetries + 1; attempt++) {
      try {
        const data = await operation();
        return {
          success: true,
          data,
          attempts: attempt,
          totalTime: Date.now() - startTime,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt > finalConfig.maxRetries) {
          finalConfig.onFinalFailure(lastError, attempt);
          break;
        }

        const errorType = this.classifyError(lastError);
        const isRetryable = this.isRetryableError(lastError, finalConfig, errorType);

        if (!isRetryable) {
          console.warn(`Non-retryable error on attempt ${attempt}:`, lastError.message);
          break;
        }

        const delay = this.calculateDelay(attempt - 1, finalConfig);
        console.log(`Retrying in ${delay}ms (attempt ${attempt}/${finalConfig.maxRetries + 1}):`, lastError.message);

        finalConfig.onRetry(attempt, lastError);
        await this.sleep(delay);
      }
    }

    return {
      success: false,
      error: lastError!,
      attempts: finalConfig.maxRetries + 1,
      totalTime: Date.now() - startTime,
    };
  }

  async retryPageNavigation(
    page: Page,
    url: string,
    config: RetryConfig = {}
  ): Promise<RetryResult<void>> {
    return this.executeWithRetry(async () => {
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });

      // Check for common error states
      await this.checkForPageErrors(page);
    }, config);
  }

  async retryPageAction<T>(
    action: () => Promise<T>,
    config: RetryConfig = {}
  ): Promise<RetryResult<T>> {
    return this.executeWithRetry(action, {
      maxRetries: 2,
      baseDelay: 500,
      ...config,
    });
  }

  private classifyError(error: Error): ErrorType {
    const message = error.message.toLowerCase();
    const stack = error.stack?.toLowerCase() || '';

    if (message.includes('timeout') || message.includes('timed out')) {
      return ErrorType.TIMEOUT;
    }

    if (message.includes('network') ||
        message.includes('connection') ||
        message.includes('net::err')) {
      return ErrorType.NETWORK;
    }

    if (message.includes('captcha') ||
        message.includes('recaptcha')) {
      return ErrorType.CAPTCHA;
    }

    if (message.includes('blocked') ||
        message.includes('access denied') ||
        message.includes('403') ||
        message.includes('rate limit')) {
      return ErrorType.BLOCKED;
    }

    if (message.includes('rate limit') ||
        message.includes('too many requests') ||
        message.includes('429')) {
      return ErrorType.RATE_LIMITED;
    }

    if (message.includes('parse') ||
        message.includes('extract') ||
        message.includes('selector')) {
      return ErrorType.PARSING;
    }

    return ErrorType.UNKNOWN;
  }

  private isRetryableError(error: Error, config: Required<RetryConfig>, errorType: ErrorType): boolean {
    // Check against configured retryable errors
    const isConfiguredRetryable = config.retryableErrors.some(pattern =>
      error.message.includes(pattern)
    );

    if (isConfiguredRetryable) {
      return true;
    }

    // Check by error type
    switch (errorType) {
      case ErrorType.NETWORK:
      case ErrorType.TIMEOUT:
      case ErrorType.RATE_LIMITED:
        return true;

      case ErrorType.CAPTCHA:
      case ErrorType.BLOCKED:
        return false; // These usually require manual intervention

      case ErrorType.PARSING:
        return false; // Parsing errors are usually permanent

      case ErrorType.UNKNOWN:
      default:
        return true; // Be optimistic about unknown errors
    }
  }

  private calculateDelay(attempt: number, config: Required<RetryConfig>): number {
    const exponentialDelay = config.baseDelay * Math.pow(config.backoffMultiplier, attempt);
    const jitter = Math.random() * 0.1 * exponentialDelay; // Add 10% jitter
    const totalDelay = exponentialDelay + jitter;

    return Math.min(totalDelay, config.maxDelay);
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async checkForPageErrors(page: Page): Promise<void> {
    // Check for common error indicators
    const errorSelectors = [
      '[data-testid="error"]',
      '.error',
      '.blocked',
      '.access-denied',
      'h1:has-text("Error")',
      'h1:has-text("Access Denied")',
      'h1:has-text("Blocked")',
    ];

    for (const selector of errorSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const text = await element.textContent();
          throw new Error(`Page error detected: ${text}`);
        }
      } catch (selectorError) {
        // If the selector itself fails, that's okay - continue checking
        if (selectorError instanceof Error && selectorError.message.includes('Page error detected')) {
          throw selectorError; // Re-throw actual page errors
        }
      }
    }

    // Check for captcha
    const captchaSelectors = [
      '.captcha',
      '.recaptcha',
      'iframe[src*="recaptcha"]',
      '[data-testid="captcha"]',
    ];

    for (const selector of captchaSelectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          throw new Error('Captcha detected on page');
        }
      } catch (selectorError) {
        if (selectorError instanceof Error && selectorError.message.includes('Captcha detected')) {
          throw selectorError;
        }
      }
    }

    // Check for rate limiting indicators
    const rateLimitText = await page.textContent('body') || '';
    const rateLimitPatterns = [
      /rate limit/i,
      /too many requests/i,
      /please wait/i,
      /try again later/i,
    ];

    for (const pattern of rateLimitPatterns) {
      if (pattern.test(rateLimitText)) {
        throw new Error(`Rate limiting detected: ${rateLimitText.substring(0, 100)}...`);
      }
    }
  }

  createCircuitBreaker(
    maxFailures: number = 5,
    resetTimeout: number = 60000
  ) {
    let failures = 0;
    let lastFailureTime = 0;
    let state: 'closed' | 'open' | 'half-open' = 'closed';

    return {
      async execute<T>(operation: () => Promise<T>): Promise<T> {
        // Check if we should reset from open state
        if (state === 'open' && Date.now() - lastFailureTime > resetTimeout) {
          state = 'half-open';
          failures = 0;
        }

        // Reject immediately if circuit is open
        if (state === 'open') {
          throw new Error('Circuit breaker is open - too many recent failures');
        }

        try {
          const result = await operation();

          // Success - reset if we were in half-open state
          if (state === 'half-open') {
            state = 'closed';
            failures = 0;
          }

          return result;
        } catch (error) {
          failures++;
          lastFailureTime = Date.now();

          // Open circuit if too many failures
          if (failures >= maxFailures) {
            state = 'open';
            console.warn(`Circuit breaker opened after ${failures} failures`);
          }

          throw error;
        }
      },

      getState() {
        return { state, failures, lastFailureTime };
      },

      reset() {
        state = 'closed';
        failures = 0;
        lastFailureTime = 0;
      }
    };
  }

  async withTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    timeoutMessage?: string
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(timeoutMessage || `Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return Promise.race([operation(), timeoutPromise]);
  }

  async handleCaptcha(page: Page): Promise<boolean> {
    console.warn('Captcha detected - manual intervention may be required');

    // Wait a bit to see if captcha resolves automatically
    await this.sleep(5000);

    // Check if captcha is still present
    try {
      const captcha = await page.$('.captcha, .recaptcha');
      return !captcha; // Return true if captcha is gone
    } catch {
      return false;
    }
  }

  async handleRateLimit(page: Page, waitTime?: number): Promise<void> {
    const defaultWait = waitTime || 60000; // Default to 1 minute
    console.warn(`Rate limit detected - waiting ${defaultWait / 1000} seconds`);

    await this.sleep(defaultWait);

    // Optionally refresh the page
    try {
      await page.reload({ waitUntil: 'networkidle' });
    } catch (error) {
      console.warn('Failed to reload page after rate limit:', error);
    }
  }
}