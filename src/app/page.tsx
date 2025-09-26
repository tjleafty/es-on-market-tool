export default function Home() {
  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            BizBuySell Scraper
          </h1>
          <p className="text-xl text-gray-600 mb-8">
            Professional business listing data extraction tool
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          <div className="bg-white p-6 rounded-lg shadow-md">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Advanced Filtering
            </h3>
            <p className="text-gray-600">
              Filter by location, price range, industry, revenue, and more
            </p>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-md">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Queue Management
            </h3>
            <p className="text-gray-600">
              Reliable job processing with retry logic and progress tracking
            </p>
          </div>

          <div className="bg-white p-6 rounded-lg shadow-md">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Export Options
            </h3>
            <p className="text-gray-600">
              Export data in CSV, JSON, or access via REST API
            </p>
          </div>
        </div>

        <div className="mt-12 text-center">
          <div className="inline-flex items-center space-x-4 text-sm text-gray-500">
            <div className="flex items-center space-x-1">
              <div className="w-2 h-2 bg-green-500 rounded-full"></div>
              <span>Project Structure Complete</span>
            </div>
            <div className="flex items-center space-x-1">
              <div className="w-2 h-2 bg-yellow-500 rounded-full"></div>
              <span>Phase 1 Complete</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
