import { NextRequest, NextResponse } from 'next/server';
import { apiAuthService, AuthContext, PERMISSIONS } from './api-auth';

export interface AuthMiddlewareOptions {
  required?: boolean;
  permissions?: string[];
  rateLimited?: boolean;
  skipPaths?: string[];
}

export class AuthMiddleware {
  async authenticate(
    request: NextRequest,
    options: AuthMiddlewareOptions = {}
  ): Promise<{
    authContext: AuthContext | null;
    response?: NextResponse;
  }> {
    const {
      required = true,
      permissions = [],
      rateLimited = true,
      skipPaths = []
    } = options;

    // Check if path should be skipped
    const pathname = new URL(request.url).pathname;
    if (skipPaths.some(path => pathname.startsWith(path))) {
      return { authContext: null };
    }

    // Attempt authentication
    const authContext = await apiAuthService.authenticate(request);

    // Handle missing authentication
    if (!authContext) {
      if (required) {
        return {
          authContext: null,
          response: NextResponse.json({
            success: false,
            error: 'Authentication required',
            message: 'Valid API key required. Include X-API-Key header.',
          }, { status: 401 })
        };
      }
      return { authContext: null };
    }

    // Check permissions
    for (const permission of permissions) {
      if (!apiAuthService.hasPermission(authContext, permission)) {
        return {
          authContext,
          response: NextResponse.json({
            success: false,
            error: 'Insufficient permissions',
            message: `Permission required: ${permission}`,
            required: permissions,
            granted: Array.from(authContext.permissions),
          }, { status: 403 })
        };
      }
    }

    // Check rate limits
    if (rateLimited) {
      const allowed = await apiAuthService.checkRateLimit(authContext, pathname);
      const rateLimitInfo = apiAuthService.getRateLimitInfo(authContext, pathname);

      if (!allowed) {
        const response = NextResponse.json({
          success: false,
          error: 'Rate limit exceeded',
          message: `Too many requests. Limit: ${rateLimitInfo.limit} per minute.`,
          retryAfter: rateLimitInfo.retryAfter,
        }, { status: 429 });

        // Add rate limit headers
        response.headers.set('X-RateLimit-Limit', rateLimitInfo.limit.toString());
        response.headers.set('X-RateLimit-Remaining', rateLimitInfo.remaining.toString());
        response.headers.set('X-RateLimit-Reset', rateLimitInfo.resetTime.toString());

        if (rateLimitInfo.retryAfter) {
          response.headers.set('Retry-After', rateLimitInfo.retryAfter.toString());
        }

        return { authContext, response };
      }

      // Add rate limit headers to successful responses (will be added later)
      request.headers.set('X-Internal-RateLimit-Info', JSON.stringify(rateLimitInfo));
    }

    return { authContext };
  }

  addRateLimitHeaders(response: NextResponse, request: NextRequest): NextResponse {
    const rateLimitInfo = request.headers.get('X-Internal-RateLimit-Info');
    if (rateLimitInfo) {
      const info = JSON.parse(rateLimitInfo);
      response.headers.set('X-RateLimit-Limit', info.limit.toString());
      response.headers.set('X-RateLimit-Remaining', info.remaining.toString());
      response.headers.set('X-RateLimit-Reset', info.resetTime.toString());
    }
    return response;
  }
}

// Helper function to create authenticated route handlers
export function withAuth(
  handler: (request: NextRequest, authContext: AuthContext | null) => Promise<NextResponse>,
  options: AuthMiddlewareOptions = {}
) {
  const middleware = new AuthMiddleware();

  return async (request: NextRequest): Promise<NextResponse> => {
    const { authContext, response } = await middleware.authenticate(request, options);

    if (response) {
      return response;
    }

    try {
      const handlerResponse = await handler(request, authContext);

      // Add rate limit headers if authentication was performed
      if (authContext) {
        return middleware.addRateLimitHeaders(handlerResponse, request);
      }

      return handlerResponse;
    } catch (error) {
      console.error('Handler error:', error);

      return NextResponse.json({
        success: false,
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      }, { status: 500 });
    }
  };
}

// Pre-configured middleware functions for common scenarios
export const authMiddleware = new AuthMiddleware();

export const requireAuth = (options: Omit<AuthMiddlewareOptions, 'required'> = {}) =>
  withAuth(async (request, authContext) => {
    // This should never be called if auth failed, but just in case
    return NextResponse.json({ success: true, authenticated: true });
  }, { ...options, required: true });

export const optionalAuth = (options: Omit<AuthMiddlewareOptions, 'required'> = {}) =>
  withAuth(async (request, authContext) => {
    return NextResponse.json({
      success: true,
      authenticated: !!authContext,
      tier: authContext?.rateLimitTier,
    });
  }, { ...options, required: false });

// Permission-specific middleware creators
export const requireJobsAccess = (permissions: string[] = [PERMISSIONS.JOBS_READ]) =>
  withAuth(async () => NextResponse.next(), {
    required: true,
    permissions,
  });

export const requireListingsAccess = (permissions: string[] = [PERMISSIONS.LISTINGS_READ]) =>
  withAuth(async () => NextResponse.next(), {
    required: true,
    permissions,
  });

export const requireMonitoringAccess = (permissions: string[] = [PERMISSIONS.MONITORING_READ]) =>
  withAuth(async () => NextResponse.next(), {
    required: true,
    permissions,
  });

export const requireAdminAccess = (permissions: string[] = [PERMISSIONS.ADMIN_SYSTEM]) =>
  withAuth(async () => NextResponse.next(), {
    required: true,
    permissions,
  });

// Utility function to extract auth context from request (for use in route handlers)
export async function getAuthContext(request: NextRequest): Promise<AuthContext | null> {
  return await apiAuthService.authenticate(request);
}

// Helper to check permissions in route handlers
export function checkPermissions(authContext: AuthContext | null, permissions: string[]): boolean {
  if (!authContext) return false;
  return permissions.every(permission => apiAuthService.hasPermission(authContext, permission));
}

// Helper to enforce permissions in route handlers
export function requirePermissions(authContext: AuthContext | null, permissions: string[]): void {
  if (!authContext) {
    throw new Error('Authentication required');
  }

  permissions.forEach(permission => {
    apiAuthService.requirePermission(authContext, permission);
  });
}