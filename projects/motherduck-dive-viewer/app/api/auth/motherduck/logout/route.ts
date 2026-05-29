import { clearOAuthState } from '@/lib/motherduck-oauth';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  await clearOAuthState();
  return NextResponse.redirect(`${request.nextUrl.origin}/login`);
}
