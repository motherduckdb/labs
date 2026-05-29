import next from 'eslint-config-next';

// eslint-config-next 16 ships a flat config array (core-web-vitals +
// typescript); spread it directly — FlatCompat is not needed.
const eslintConfig = [
  ...next,
  {
    ignores: ['.next/**', 'node_modules/**'],
  },
];

export default eslintConfig;
