'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function LoginContent() {
  const params = useSearchParams();
  const error = params.get('error');

  const errorMessages: Record<string, string> = {
    authorization_denied: 'Authorization was denied. Please try again.',
    missing_code: 'Authorization failed. Please try again.',
    token_exchange_failed: 'Could not complete authorization. Please try again.',
    state_mismatch: 'Authorization session expired or could not be verified. Please try again.',
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-background p-4">
      <div className="w-full max-w-[440px] bg-brutal-surface border-2 border-foreground rounded-sm shadow-[4px_4px_0_#171717] p-10">
        <h1 className="text-[30px] font-semibold tracking-tight text-foreground leading-tight mb-3">
          Sign in with MotherDuck.
        </h1>
        <p className="text-sm text-brutal-muted mb-8 leading-relaxed">
          Connect your MotherDuck account to browse and view your Dives. You&apos;ll be redirected to MotherDuck to authorize access.
        </p>

        {error && (
          <p className="text-sm text-destructive mb-4">
            {errorMessages[error] || 'An error occurred. Please try again.'}
          </p>
        )}

        <a
          href="/api/auth/motherduck"
          className="w-full py-3 px-6 text-base font-semibold flex items-center justify-center gap-2 bg-primary text-primary-foreground border-2 border-foreground rounded-sm shadow-[2px_2px_0_#171717] cursor-pointer transition-all duration-150 hover:shadow-[4px_4px_0_#171717] hover:-translate-x-0.5 hover:-translate-y-0.5 no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Continue <span aria-hidden="true">&rarr;</span>
        </a>

        <p className="mt-4 text-xs font-mono text-brutal-muted text-center">
          secured by OAuth &middot; PKCE
        </p>

        <div className="mt-8 pt-6 border-t-2 border-foreground/10">
          <p className="text-xs text-brutal-muted text-center">
            No account?{' '}
            <a
              href="https://motherduck.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground underline underline-offset-2 hover:text-accent-foreground"
            >
              Create one at motherduck.com
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}
