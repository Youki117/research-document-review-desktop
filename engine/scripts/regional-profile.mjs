import { basename, extname } from 'node:path';

function sanitizeBase(value) {
  let name = String(value || '');
  try { name = name.normalize('NFKC'); } catch {}
  name = name.replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[^A-Za-z0-9\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF_-]+/g, '_')
    .replace(/_+/g, '_').replace(/^[-_]+|[-_]+$/g, '');
  return name || '文档';
}

export function outputFileName(originalName, extension) {
  const stem = basename(originalName, extname(originalName)).replace(/_[A-Za-z0-9]{6}$/, '').trim() || '文档';
  return '[标注版]' + sanitizeBase(stem) + '.' + extension;
}
