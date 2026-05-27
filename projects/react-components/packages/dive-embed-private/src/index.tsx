import { CSSProperties, FC, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import styles from './styles.module.css';

const DEFAULT_EMBED_HOST = 'https://embed-motherduck.com';

export interface DiveEmbedPrivateProps {
  /** ID of the dive to embed. */
  diveId: string;
  /** Display title shown in the header (and on the iframe). */
  title?: string;
  /** Height of the embed, e.g. `'720px'`. */
  height?: string;
  /**
   * Endpoint your backend exposes to mint a session for the given `diveId`.
   * Must accept `POST { diveId }` and return `{ session: string }`.
   */
  sessionEndpoint: string;
  /** Show the bordered header with title + expand button. Default: true. */
  chrome?: boolean;
  /** Defer loading until the embed scrolls into view. Default: true. */
  lazy?: boolean;
  /** Override the embed iframe host. Default: https://embed-motherduck.com. */
  embedHost?: string;
  /** Optional URL to suggest if the embed fails to load. */
  fallbackUrl?: string;
}

interface DiveFrameProps extends Required<Pick<DiveEmbedPrivateProps, 'diveId' | 'title' | 'height' | 'sessionEndpoint' | 'chrome' | 'lazy' | 'embedHost'>> {
  fallbackUrl?: string;
}

const ExpandIcon: FC = () => (
  <svg viewBox='0 0 24 24' width='16' height='16' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>
    <path d='M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7' />
  </svg>
);

const CloseIcon: FC = () => (
  <svg viewBox='0 0 24 24' width='18' height='18' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' aria-hidden='true'>
    <path d='M18 6 6 18M6 6l12 12' />
  </svg>
);

const errorBody = (error: string, fallbackUrl?: string): ReactNode => (
  <div className={styles.message}>
    <p>Couldn't load the live Dive preview: {error}.</p>
    {fallbackUrl && (
      <p>
        Open{' '}
        <a href={fallbackUrl} target='_blank' rel='noopener noreferrer'>
          this dive on motherduck.com
        </a>{' '}
        instead.
      </p>
    )}
  </div>
);

const loadingBody: ReactNode = (
  <div className={styles.message}>
    <p>Loading live Dive preview...</p>
  </div>
);

const iframeElement = (session: string, title: string, embedHost: string) => (
  <iframe
    className={styles.frame}
    src={`${embedHost}/sandbox/#session=${encodeURIComponent(session)}`}
    title={title}
    sandbox='allow-scripts allow-same-origin'
    loading='lazy'
  />
);

const DiveFrame: FC<DiveFrameProps> = ({ diveId, title, height, sessionEndpoint, chrome, lazy, embedHost, fallbackUrl }) => {
  const [session, setSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(!lazy);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (shouldLoad) return;
    const node = rootRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [shouldLoad]);

  useEffect(() => {
    if (!shouldLoad) return;
    let cancelled = false;
    setSession(null);
    setError(null);

    fetch(sessionEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diveId }),
    })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`Session request failed (${res.status})`);
        }
        const data = (await res.json()) as { session?: string };
        if (!data.session) {
          throw new Error('Session missing from response');
        }
        if (!cancelled) setSession(data.session);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [diveId, sessionEndpoint, shouldLoad]);

  const closeModal = useCallback(() => setExpanded(false), []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [expanded, closeModal]);

  const body: ReactNode = error
    ? errorBody(error, fallbackUrl)
    : !shouldLoad || !session
      ? loadingBody
      : iframeElement(session, title, embedHost);

  if (!chrome) {
    return (
      <div ref={rootRef} className={styles.bare} style={{ height }}>
        {body}
      </div>
    );
  }

  const wrapperStyle = { '--dive-height': height } as CSSProperties;

  return (
    <div ref={rootRef} className={styles.wrapper} style={wrapperStyle}>
      <div className={`${styles.contentBox} ${expanded ? styles.contentBoxModal : styles.contentBoxInline}`}>
        <div className={styles.header}>
          <span className={styles.title}>{title}</span>
          {expanded ? (
            <button type='button' className={styles.closeButton} onClick={closeModal} aria-label='Close full view'>
              <CloseIcon />
            </button>
          ) : (
            <button
              type='button'
              className={styles.expandButton}
              onClick={() => setExpanded(true)}
              disabled={!session}
              aria-label={`Open ${title} in full view`}
            >
              <ExpandIcon />
              <span>Expand</span>
            </button>
          )}
        </div>
        {body}
      </div>
      {expanded && <div className={styles.backdrop} onClick={closeModal} role='presentation' />}
    </div>
  );
};

export const DiveEmbedPrivate: FC<DiveEmbedPrivateProps> = ({
  diveId,
  title = 'Embedded Dive',
  height = '720px',
  sessionEndpoint,
  chrome = true,
  lazy = true,
  embedHost = DEFAULT_EMBED_HOST,
  fallbackUrl,
}) => {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return chrome ? (
      <div className={styles.wrapper} style={{ '--dive-height': height } as CSSProperties}>
        <div className={`${styles.contentBox} ${styles.contentBoxInline}`}>
          <div className={styles.message}>
            <p>Loading live Dive preview...</p>
          </div>
        </div>
      </div>
    ) : (
      <div className={styles.bare} style={{ height }}>
        <div className={styles.message}>
          <p>Loading live Dive preview...</p>
        </div>
      </div>
    );
  }

  return (
    <DiveFrame
      diveId={diveId}
      title={title}
      height={height}
      sessionEndpoint={sessionEndpoint}
      chrome={chrome}
      lazy={lazy}
      embedHost={embedHost}
      fallbackUrl={fallbackUrl}
    />
  );
};

export default DiveEmbedPrivate;
