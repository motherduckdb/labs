import { handleOAuthCallback, OAuthStateError } from '@/lib/motherduck-oauth';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const baseUrl = request.nextUrl.origin;
  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const error = request.nextUrl.searchParams.get('error');

  if (error) {
    console.error('[OAuth] Authorization error:', error);
    return NextResponse.redirect(`${baseUrl}/login?error=authorization_denied`);
  }

  if (!code) {
    return NextResponse.redirect(`${baseUrl}/login?error=missing_code`);
  }

  try {
    await handleOAuthCallback(code, state);
    // Land on the home dashboard (the Dive list).
    return NextResponse.redirect(`${baseUrl}/`);
  } catch (err) {
    if (err instanceof OAuthStateError) {
      console.warn('[OAuth] State validation failed:', err.message);
      return NextResponse.redirect(`${baseUrl}/login?error=state_mismatch`);
    }
    console.error('[OAuth] Callback error:', err);
    return NextResponse.redirect(`${baseUrl}/login?error=token_exchange_failed`);
  }
}
