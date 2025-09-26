import { chromium, Browser, Page, BrowserContext } from 'playwright';
import { getUserAgents } from '../utils/user-agents';

export interface BrowserManagerOptions {
  headless?: boolean;
  proxy?: string;
  userAgent?: string;
  maxConcurrent?: number;
}

export class BrowserManager {
  private browsers: Browser[] = [];
  private contexts: BrowserContext[] = [];
  private pages: Page[] = [];
  private options: BrowserManagerOptions;
  private userAgents: string[];

  constructor(options: BrowserManagerOptions = {}) {
    this.options = {
      headless: true,
      maxConcurrent: parseInt(process.env.MAX_CONCURRENT_BROWSERS || '3'),
      ...options,
    };
    this.userAgents = getUserAgents();
  }

  async createBrowser(): Promise<Browser> {
    const browser = await chromium.launch({
      headless: this.options.headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080',
      ],
    });

    this.browsers.push(browser);
    return browser;
  }

  async createContext(browser?: Browser): Promise<BrowserContext> {
    const targetBrowser = browser || (await this.createBrowser());
    const userAgent = this.getRandomUserAgent();

    const context = await targetBrowser.newContext({
      userAgent,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });

    this.contexts.push(context);
    return context;
  }

  async createPage(context?: BrowserContext): Promise<Page> {
    const targetContext = context || (await this.createContext());
    const page = await targetContext.newPage();

    await this.configurePage(page);

    this.pages.push(page);
    return page;
  }

  private async configurePage(page: Page): Promise<void> {
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    });

    page.setDefaultTimeout(parseInt(process.env.REQUEST_TIMEOUT || '30000'));
  }

  private getRandomUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  async cleanup(): Promise<void> {
    await Promise.all(this.pages.map(page => page.close().catch(() => {})));
    await Promise.all(this.contexts.map(context => context.close().catch(() => {})));
    await Promise.all(this.browsers.map(browser => browser.close().catch(() => {})));

    this.pages = [];
    this.contexts = [];
    this.browsers = [];
  }

  getActiveBrowsers(): number {
    return this.browsers.length;
  }

  getActivePages(): number {
    return this.pages.length;
  }
}