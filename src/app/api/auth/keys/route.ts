import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiAuthService, PERMISSIONS } from '@/lib/auth/api-auth';
import { withAuth } from '@/lib/auth/middleware';

const CreateKeySchema = z.object({
  name: z.string().min(1).max(100),
  tier: z.enum(['basic', 'premium', 'enterprise']).default('basic'),
  permissions: z.array(z.string()).optional(),
  expiresIn: z.number().min(1).max(365).optional(), // days
  metadata: z.record(z.any()).optional(),
});

const UpdateKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  permissions: z.array(z.string()).optional(),
  expiresIn: z.number().min(1).max(365).optional(), // days from now
  metadata: z.record(z.any()).optional(),
});

// GET /api/auth/keys - List API keys (admin only)
export const GET = withAuth(async (request, authContext) => {
  if (!authContext || !apiAuthService.hasPermission(authContext, PERMISSIONS.ADMIN_KEYS)) {
    return NextResponse.json({
      success: false,
      error: 'Admin access required',
    }, { status: 403 });
  }

  try {
    // In production, fetch from database
    const mockKeys = [
      {
        id: 'key_basic_1',
        name: 'Basic Development Key',
        tier: 'basic',
        permissions: ['jobs:read', 'listings:read'],
        enabled: true,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        // Never return actual key or hash
        keyPreview: 'sk_test_basic_***',
      },
      {
        id: 'key_premium_1',
        name: 'Premium API Key',
        tier: 'premium',
        permissions: ['jobs:read', 'jobs:create', 'listings:read', 'listings:export'],
        enabled: true,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        keyPreview: 'sk_live_premium_***',
      },
    ];

    return NextResponse.json({
      success: true,
      data: {
        keys: mockKeys,
        total: mockKeys.length,
      },
    });

  } catch (error) {
    console.error('Failed to list API keys:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to list API keys',
    }, { status: 500 });
  }
});

// POST /api/auth/keys - Create new API key (admin only)
export const POST = withAuth(async (request, authContext) => {
  if (!authContext || !apiAuthService.hasPermission(authContext, PERMISSIONS.ADMIN_KEYS)) {
    return NextResponse.json({
      success: false,
      error: 'Admin access required',
    }, { status: 403 });
  }

  try {
    const body = await request.json();
    const keyRequest = CreateKeySchema.parse(body);

    console.log(`🔑 Creating new API key: ${keyRequest.name} (${keyRequest.tier})`);

    const { key, secret } = await apiAuthService.generateApiKey(
      keyRequest.name,
      keyRequest.tier,
      keyRequest.permissions
    );

    // In production, store in database with proper hashing
    const keyData = {
      id: `key_${keyRequest.tier}_${Date.now()}`,
      name: keyRequest.name,
      key: key, // Only return this once!
      secret: secret, // Only return this once!
      tier: keyRequest.tier,
      permissions: keyRequest.permissions,
      enabled: true,
      createdAt: new Date().toISOString(),
      expiresAt: keyRequest.expiresIn
        ? new Date(Date.now() + keyRequest.expiresIn * 24 * 60 * 60 * 1000).toISOString()
        : null,
      metadata: keyRequest.metadata,
    };

    return NextResponse.json({
      success: true,
      data: keyData,
      message: 'API key created successfully. Store the key and secret securely - they will not be shown again.',
    }, { status: 201 });

  } catch (error) {
    console.error('Failed to create API key:', error);

    if (error instanceof z.ZodError) {
      return NextResponse.json({
        success: false,
        error: 'Invalid key creation request',
        details: error.errors,
      }, { status: 400 });
    }

    return NextResponse.json({
      success: false,
      error: 'Failed to create API key',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
});

// PUT /api/auth/keys/[keyId] - Update API key
export async function PUT(request: NextRequest, { params }: { params: { keyId: string } }) {
  const authResult = await withAuth(async (req, authContext) => {
    if (!authContext || !apiAuthService.hasPermission(authContext, PERMISSIONS.ADMIN_KEYS)) {
      return NextResponse.json({
        success: false,
        error: 'Admin access required',
      }, { status: 403 });
    }

    try {
      const keyId = params.keyId;
      const body = await request.json();
      const updateData = UpdateKeySchema.parse(body);

      console.log(`🔑 Updating API key: ${keyId}`);

      // In production, update database record
      const updatedKey = {
        id: keyId,
        ...updateData,
        updatedAt: new Date().toISOString(),
      };

      return NextResponse.json({
        success: true,
        data: updatedKey,
        message: 'API key updated successfully',
      });

    } catch (error) {
      console.error('Failed to update API key:', error);

      if (error instanceof z.ZodError) {
        return NextResponse.json({
          success: false,
          error: 'Invalid key update request',
          details: error.errors,
        }, { status: 400 });
      }

      return NextResponse.json({
        success: false,
        error: 'Failed to update API key',
        message: error instanceof Error ? error.message : 'Unknown error',
      }, { status: 500 });
    }
  })(request);

  return authResult;
}

// DELETE /api/auth/keys/[keyId] - Delete/disable API key
export async function DELETE(request: NextRequest, { params }: { params: { keyId: string } }) {
  const authResult = await withAuth(async (req, authContext) => {
    if (!authContext || !apiAuthService.hasPermission(authContext, PERMISSIONS.ADMIN_KEYS)) {
      return NextResponse.json({
        success: false,
        error: 'Admin access required',
      }, { status: 403 });
    }

    try {
      const keyId = params.keyId;

      console.log(`🔑 Deleting API key: ${keyId}`);

      // In production, soft delete or disable the key in database
      // Never actually delete keys completely for audit trails

      return NextResponse.json({
        success: true,
        message: 'API key deleted successfully',
      });

    } catch (error) {
      console.error('Failed to delete API key:', error);

      return NextResponse.json({
        success: false,
        error: 'Failed to delete API key',
        message: error instanceof Error ? error.message : 'Unknown error',
      }, { status: 500 });
    }
  })(request);

  return authResult;
}