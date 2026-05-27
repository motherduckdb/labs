/// <reference types="vite/client" />

declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

interface ImportMetaEnv {
  readonly VITE_ENABLE_SQL_EDITOR?: string;
  readonly VITE_AUTH0_DOMAIN?: string;
  readonly VITE_AUTH0_CLIENT_ID?: string;
  readonly VITE_MD_TOKEN_LOOKUP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
