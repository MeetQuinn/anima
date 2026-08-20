export type KbFileKind = 'markdown' | 'html' | 'json' | 'code' | 'image' | 'pdf' | 'text' | 'binary';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif']);
const TEXT_EXTENSIONS = new Set(['txt', 'text', 'log', '', 'env', 'gitignore']);

const CODE_LANGUAGES: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'c',
  java: 'java',
  js: 'javascript',
  jsx: 'jsx',
  kt: 'kotlin',
  mjs: 'javascript',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

export function kbFileExtension(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function kbFileKind(path: string): KbFileKind {
  const ext = kbFileExtension(path);
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'json') return 'json';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (CODE_LANGUAGES[ext]) return 'code';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'binary';
}

export function kbCodeLanguage(path: string): string | undefined {
  return CODE_LANGUAGES[kbFileExtension(path)];
}
