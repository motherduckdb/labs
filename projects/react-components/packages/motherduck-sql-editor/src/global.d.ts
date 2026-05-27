declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

// CommonJS `require` shim for the conditional load of @motherduck/wasm-client.
// Avoids pulling in @types/node just for one call site.
declare const require: (id: string) => any;
