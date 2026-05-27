import { FC, useEffect, useState } from 'react';
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react';

import { DiveEmbedPublic } from '../../packages/dive-embed-public/src';
import { DiveEmbedPrivate } from '../../packages/dive-embed-private/src';
import MotherDuckSQLEditor, {
  configureAuth,
  setAuth0ReactContext,
} from '../../packages/motherduck-sql-editor/src';

const enableSqlEditor = import.meta.env.VITE_ENABLE_SQL_EDITOR === 'true';
const auth0Domain = import.meta.env.VITE_AUTH0_DOMAIN ?? '';
const auth0ClientId = import.meta.env.VITE_AUTH0_CLIENT_ID ?? '';
const mdTokenLookupUrl = import.meta.env.VITE_MD_TOKEN_LOOKUP_URL ?? '';

if (enableSqlEditor && mdTokenLookupUrl) {
  configureAuth({ mdTokenLookupUrl });
}

const sectionStyle: React.CSSProperties = {
  padding: '24px',
  borderBottom: '1px solid #e6e6e6',
};

const Section: FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section style={sectionStyle}>
    <h2 style={{ marginTop: 0, fontFamily: 'Inter, system-ui, sans-serif' }}>{title}</h2>
    {children}
  </section>
);

const AuthBridge: FC<{ children: React.ReactNode }> = ({ children }) => {
  const auth0 = useAuth0();
  useEffect(() => {
    setAuth0ReactContext(auth0);
  }, [auth0]);
  return <>{children}</>;
};

const SqlEditorSection: FC = () => {
  if (!enableSqlEditor) {
    return (
      <Section title='3. motherduck-sql-editor (disabled)'>
        <p>
          Set <code>VITE_ENABLE_SQL_EDITOR=true</code> in <code>.env.local</code> and configure
          Auth0 + MotherDuck values to enable this section. See the README.
        </p>
      </Section>
    );
  }

  if (!auth0Domain || !auth0ClientId) {
    return (
      <Section title='3. motherduck-sql-editor (misconfigured)'>
        <p>
          SQL editor is enabled but <code>VITE_AUTH0_DOMAIN</code> /{' '}
          <code>VITE_AUTH0_CLIENT_ID</code> are not set. Copy <code>.env.example</code> to{' '}
          <code>.env.local</code>.
        </p>
      </Section>
    );
  }

  return (
    <Section title='3. motherduck-sql-editor'>
      <Auth0Provider
        domain={auth0Domain}
        clientId={auth0ClientId}
        authorizationParams={{ redirect_uri: window.location.origin }}
      >
        <AuthBridge>
          <MotherDuckSQLEditor
            database='sample_data'
            query='SELECT * FROM sample_data.hn.hacker_news ORDER BY score DESC LIMIT 10;'
          />
        </AuthBridge>
      </Auth0Provider>
    </Section>
  );
};

const App: FC = () => {
  const [showPrivate, setShowPrivate] = useState(false);

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', maxWidth: 1100, margin: '0 auto' }}>
      <header style={{ padding: '24px' }}>
        <h1 style={{ marginBottom: 4 }}>react-components playground</h1>
        <p style={{ marginTop: 0, color: '#6a6a6a' }}>
          End-to-end verification of the three labs packages.
        </p>
      </header>

      <Section title='1. dive-embed-public'>
        <p>Loads a real public dive snippet — no auth, no backend.</p>
        <DiveEmbedPublic
          snippetId='galactic-coffee-theme-gallery'
          title='Galactic Coffee'
          height={720}
        />
      </Section>

      <Section title='2. dive-embed-private'>
        <p>
          Calls <code>/api/dive-embed-session</code> (mocked by{' '}
          <code>vite.config.ts</code> — returns a fake session). The iframe will fail to render
          a real dive, but you can confirm the loading flow, the expand modal, and Escape-to-close.
        </p>
        <p>
          <button onClick={() => setShowPrivate((v) => !v)}>
            {showPrivate ? 'Hide' : 'Show'} private dive
          </button>
        </p>
        {showPrivate && (
          <DiveEmbedPrivate
            diveId='example-dive-id'
            sessionEndpoint='/api/dive-embed-session'
            title='Example private dive'
            height='720px'
          />
        )}
      </Section>

      <SqlEditorSection />
    </div>
  );
};

export default App;
