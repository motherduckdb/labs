import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { FONT_CONFIG } from '../constants';

const baseBlock = {
  margin: 0,
  padding: 0,
  overflow: 'visible',
  fontFamily: FONT_CONFIG.fontFamily,
  fontSize: FONT_CONFIG.fontSize,
  lineHeight: FONT_CONFIG.lineHeight,
  textShadow: 'none',
};

const lightTheme = {
  ...vscDarkPlus,
  'pre[class*="language-"]': { ...vscDarkPlus['pre[class*="language-"]'], ...baseBlock, background: '#f8f9fa' },
  'code[class*="language-"]': { ...vscDarkPlus['code[class*="language-"]'], ...baseBlock, background: '#f8f9fa', color: '#333' },
  comment: { color: '#6a9955' },
  punctuation: { color: '#333' },
  property: { color: '#0070c1' },
  selector: { color: '#0070c1' },
  string: { color: '#a31515' },
  'attr-name': { color: '#0070c1' },
  'attr-value': { color: '#a31515' },
  keyword: { color: '#0033cc', fontWeight: 'bold' },
  builtin: { color: '#0033cc', fontWeight: 'bold' },
  'class-name': { color: '#267f99' },
  function: { color: '#795e26' },
  boolean: { color: '#0000ff' },
  number: { color: '#098658' },
  operator: { color: '#800080' },
};

const darkTheme = {
  ...vscDarkPlus,
  'pre[class*="language-"]': { ...vscDarkPlus['pre[class*="language-"]'], ...baseBlock, background: '#1e1e1e' },
  'code[class*="language-"]': { ...vscDarkPlus['code[class*="language-"]'], ...baseBlock, background: '#1e1e1e', color: '#d4d4d4' },
  comment: { color: '#6a9955' },
  punctuation: { color: '#d4d4d4' },
  property: { color: '#9cdcfe' },
  selector: { color: '#9cdcfe' },
  string: { color: '#ce9178' },
  'attr-name': { color: '#9cdcfe' },
  'attr-value': { color: '#ce9178' },
  keyword: { color: '#569cd6', fontWeight: 'bold' },
  builtin: { color: '#569cd6', fontWeight: 'bold' },
  'class-name': { color: '#4ec9b0' },
  function: { color: '#dcdcaa' },
  boolean: { color: '#569cd6' },
  number: { color: '#b5cea8' },
  operator: { color: '#c586c0' },
};

export const getSqlTheme = (colorMode: 'light' | 'dark') =>
  colorMode === 'dark' ? darkTheme : lightTheme;
