'use client';

import { useState, useEffect } from 'react';

interface ScrapeJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  searchParams: {
    location?: string;
    minPrice?: number;
    maxPrice?: number;
    industry?: string;
  };
  resultCount: number;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export default function Dashboard() {
  const [jobs, setJobs] = useState<ScrapeJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    location: '',
    minPrice: '',
    maxPrice: '',
    industry: '',
    pages: '1'
  });

  const fetchJobs = async () => {
    try {
      const response = await fetch('/api/jobs');
      if (response.ok) {
        const data = await response.json();
        setJobs(data.jobs || []);
      }
    } catch (error) {
      console.error('Failed to fetch jobs:', error);
    }
  };

  const startScrape = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const searchParams = {
        ...(formData.location && { location: formData.location }),
        ...(formData.minPrice && { minPrice: parseInt(formData.minPrice) }),
        ...(formData.maxPrice && { maxPrice: parseInt(formData.maxPrice) }),
        ...(formData.industry && { industry: formData.industry }),
      };

      const response = await fetch('/api/scrape/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          searchParams,
          pages: parseInt(formData.pages) || 1,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        alert(`Scrape job started! Job ID: ${result.jobId}`);
        fetchJobs();
      } else {
        const error = await response.json();
        alert(`Error: ${error.error || 'Failed to start scrape job'}`);
      }
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  const downloadResults = async (jobId: string) => {
    try {
      const response = await fetch(`/api/export/csv?jobId=${jobId}`);
      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `business-listings-${jobId}.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      } else {
        alert('Failed to download results');
      }
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : 'Download failed'}`);
    }
  };

  const cancelJob = async (jobId: string) => {
    try {
      const response = await fetch(`/api/jobs/${jobId}/cancel`, {
        method: 'POST',
      });
      if (response.ok) {
        fetchJobs();
      } else {
        alert('Failed to cancel job');
      }
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : 'Cancel failed'}`);
    }
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'text-green-600 bg-green-100';
      case 'running': return 'text-blue-600 bg-blue-100';
      case 'failed': return 'text-red-600 bg-red-100';
      default: return 'text-yellow-600 bg-yellow-100';
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-900 mb-4">
            BizBuySell Scraper Dashboard
          </h1>
          <p className="text-xl text-gray-600">
            Start scraping business listings and monitor your jobs
          </p>
        </div>

        {/* Scrape Form */}
        <div className="bg-white p-6 rounded-lg shadow-md mb-8">
          <h2 className="text-2xl font-semibold text-gray-900 mb-4">Start New Scrape Job</h2>
          <form onSubmit={startScrape} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Location
                </label>
                <input
                  type="text"
                  value={formData.location}
                  onChange={(e) => setFormData({...formData, location: e.target.value})}
                  placeholder="e.g., California, New York"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Min Price ($)
                </label>
                <input
                  type="number"
                  value={formData.minPrice}
                  onChange={(e) => setFormData({...formData, minPrice: e.target.value})}
                  placeholder="0"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Max Price ($)
                </label>
                <input
                  type="number"
                  value={formData.maxPrice}
                  onChange={(e) => setFormData({...formData, maxPrice: e.target.value})}
                  placeholder="1000000"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Industry
                </label>
                <select
                  value={formData.industry}
                  onChange={(e) => setFormData({...formData, industry: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">All Industries</option>
                  <option value="restaurants">Restaurants</option>
                  <option value="retail">Retail</option>
                  <option value="automotive">Automotive</option>
                  <option value="healthcare-medical">Healthcare & Medical</option>
                  <option value="internet-technology">Internet & Technology</option>
                  <option value="construction">Construction</option>
                  <option value="manufacturing">Manufacturing</option>
                  <option value="real-estate">Real Estate</option>
                  <option value="business-services">Business Services</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Pages to Scrape
                </label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={formData.pages}
                  onChange={(e) => setFormData({...formData, pages: e.target.value})}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="flex justify-center">
              <button
                type="submit"
                disabled={loading}
                className="bg-blue-600 text-white px-8 py-3 rounded-md font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
              >
                {loading && (
                  <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                )}
                <span>{loading ? 'Starting...' : 'Start Scrape Job'}</span>
              </button>
            </div>
          </form>
        </div>

        {/* Jobs List */}
        <div className="bg-white rounded-lg shadow-md">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-2xl font-semibold text-gray-900">Recent Jobs</h2>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Job ID
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Parameters
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Results
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Created
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {jobs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-4 text-center text-gray-500">
                      No jobs found. Start your first scrape job above.
                    </td>
                  </tr>
                ) : (
                  jobs.map((job) => (
                    <tr key={job.id}>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {job.id.substring(0, 8)}...
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusColor(job.status)}`}>
                          {job.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900">
                        <div className="max-w-xs">
                          {job.searchParams.location && <div>Location: {job.searchParams.location}</div>}
                          {job.searchParams.industry && <div>Industry: {job.searchParams.industry}</div>}
                          {job.searchParams.minPrice && <div>Min: ${job.searchParams.minPrice.toLocaleString()}</div>}
                          {job.searchParams.maxPrice && <div>Max: ${job.searchParams.maxPrice.toLocaleString()}</div>}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                        {job.resultCount > 0 ? `${job.resultCount} listings` : '-'}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {new Date(job.createdAt).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                        {job.status === 'completed' && job.resultCount > 0 && (
                          <button
                            onClick={() => downloadResults(job.id)}
                            className="text-blue-600 hover:text-blue-900"
                          >
                            Download
                          </button>
                        )}
                        {(job.status === 'pending' || job.status === 'running') && (
                          <button
                            onClick={() => cancelJob(job.id)}
                            className="text-red-600 hover:text-red-900"
                          >
                            Cancel
                          </button>
                        )}
                        {job.error && (
                          <span className="text-red-500" title={job.error}>
                            Error
                          </span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}