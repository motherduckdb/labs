import { startOAuthFlow } from '@/lib/motherduck-oauth';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const authUrl = await startOAuthFlow();
    return NextResponse.redirect(authUrl);
  } catch (error) {
    console.error('[OAuth] Failed to start flow:', error);
    return Response.json(
      { error: 'Failed to start MotherDuck authorization' },
      { status: 500 }
    );
  }
}
