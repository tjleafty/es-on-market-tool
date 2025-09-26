# BizBuySell Scraper API

A comprehensive Next.js application for scraping and managing business listings from BizBuySell with real-time monitoring, data export capabilities, and webhook integrations.

## 🚀 Features

- **Advanced Web Scraping** - Automated business listing extraction with smart filtering
- **Real-Time Updates** - Server-Sent Events for live progress tracking
- **Data Export** - Export to CSV, Excel, JSON, and XML formats
- **API Management** - RESTful API with authentication and rate limiting
- **Monitoring & Analytics** - Comprehensive system health and performance metrics
- **Webhook System** - Event-driven notifications for integrations
- **Database-Driven Jobs** - Scalable job queue system optimized for serverless

## 🏗️ Architecture

### Serverless-First Design
- **Vercel Functions** - API routes optimized for serverless deployment
- **Supabase PostgreSQL** - Cloud database with connection pooling
- **Server-Sent Events** - Real-time updates without WebSocket dependency
- **Database Job Queue** - Background processing without Redis dependency

### Key Technologies
- **Next.js 15** with App Router
- **TypeScript** for type safety
- **Prisma ORM** with Supabase integration
- **Playwright** for browser automation
- **Zod** for schema validation
- **Server-Sent Events** for real-time communication

## 🚀 Quick Start

### Prerequisites
1. **Node.js 18+**
2. **Supabase Account** - Database hosting
3. **Vercel Account** (for deployment)

### Local Development
```bash
git clone https://github.com/tjleafty/es-on-market-tool.git
cd es-on-market-tool
npm install

# Copy and configure environment
cp .env.example .env.local
# Edit .env.local with your credentials

# Setup database
npx prisma generate
npx prisma db push

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to access the application.

## 🌐 Deployment to Vercel

### Environment Variables (Required)
```bash
# Database (Supabase)
DATABASE_URL="postgresql://postgres:[PASSWORD]@db.hqolrrdextzomcdbommn.supabase.co:5432/postgres?pgbouncer=true&connection_limit=1"
DIRECT_URL="postgresql://postgres:[PASSWORD]@db.hqolrrdextzomcdbommn.supabase.co:5432/postgres"

# Supabase
NEXT_PUBLIC_SUPABASE_URL="https://hqolrrdextzomcdbommn.supabase.co"
NEXT_PUBLIC_SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."

# Security
API_KEY_SALT="your-32-character-salt"
NEXTAUTH_SECRET="your-32-character-secret"
NEXTAUTH_URL="https://your-app.vercel.app"
```

### Deploy Steps
1. **Connect to Vercel**
   - Import your GitHub repository to Vercel
   - Configure environment variables in Vercel dashboard
   - Deploy automatically

2. **Database Setup**
   ```bash
   npx prisma db push  # Deploy schema to Supabase
   ```

## 📖 API Usage

### Authentication
All API requests require an API key:
```bash
curl -H "X-API-Key: sk_live_premium_abc123..." \
     https://your-app.vercel.app/api/jobs
```

### Key Endpoints

#### Create Scraping Job
```bash
POST /api/jobs
{
  "filters": { "state": "CA", "industry": "restaurant" },
  "maxListings": 1000
}
```

#### Search Listings
```bash
GET /api/listings/enhanced?industry=restaurant&state=CA
```

#### Export Data
```bash
POST /api/export
{
  "format": "excel",
  "filters": { "industry": "restaurant" },
  "template": "detailed"
}
```

#### Real-Time Updates
```bash
GET /api/realtime  # Establish SSE connection
```

### Interactive Documentation
Visit `https://your-app.vercel.app/api/docs` for complete API documentation.

## 🔧 Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint
- `npm run test` - Run tests
- `npm run db:generate` - Generate Prisma client
- `npm run db:push` - Push schema to database

## 📊 Monitoring

Access system monitoring at:
- **Health Check**: `/api/monitoring/system`
- **Analytics**: `/api/monitoring/analytics`
- **Metrics**: `/api/monitoring/metrics`

## 🔐 Security Features

- **API Key Authentication** with tiered permissions
- **Rate Limiting** (100-10,000 req/min based on tier)
- **Input Validation** using Zod schemas
- **SQL Injection Protection** via Prisma ORM

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Documentation**: [API Docs](/api/docs)
- **Issues**: [GitHub Issues](https://github.com/tjleafty/es-on-market-tool/issues)
- **Health Check**: `/health`

---

**Built for scalable business listing data extraction and management**
