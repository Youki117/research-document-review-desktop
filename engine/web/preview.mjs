import {readFile, stat} from 'node:fs/promises';
import {join, basename, extname} from 'node:path';
import {docxLayout} from './docx-layout.mjs';

// Render actual OOXML revision runs; keep pagination and layout in the downloadable original.
export function paragraphRuns(paragraph) {
  const runs = [];
  function visit(node, kind = 'text', revisionId) {
    if (node.type !== 'element') return;
    if (['w:del', 'w:moveFrom'].includes(node.name)) { kind = 'deletion'; revisionId = node.attributes?.['w:id']; }
    if (['w:ins', 'w:moveTo'].includes(node.name)) { kind = 'insertion'; revisionId = node.attributes?.['w:id']; }
    let text;
    if (['w:t', 'w:delText', 'm:t'].includes(node.name)) {
      text = (node.elements || []).filter(child => child.type === 'text').map(child => child.text || '').join('');
    } else if (node.name === 'w:tab') text = '\t';
    else if (['w:br', 'w:cr'].includes(node.name)) text = '\n';
    if (text !== undefined) {
      const previous = runs.at(-1);
      if (previous?.kind === kind && previous.revision_id === revisionId) previous.text += text;
      else runs.push({kind, text, ...(revisionId !== undefined ? {revision_id: revisionId} : {})});
      return;
    }
    for (const child of node.elements || []) visit(child, kind, revisionId);
  }
  visit(paragraph);
  return runs;
}

export async function annotatedArtifact(job, directory) {
  const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
  const file = report.files?.[0];
  if (!file || file.status === 'failed' || !file.output || basename(file.output) !== file.output || !(job.artifact_names || []).includes(file.output)) {
    throw Object.assign(new Error('此任务没有可预览的标注副本，请查看审查报告。'), {status: 409});
  }
  const path = join(directory, file.output);
  const info = await stat(path);
  if (info.size > 50 * 1024 * 1024) throw Object.assign(new Error('标注副本过大，请下载后查看。'), {status: 413});
  return {report, file, path, info};
}

export async function documentPreview(job, directory) {
  const {file, path} = await annotatedArtifact(job, directory);
  const {loadOoxmlDocument, readTextItems, parseOoxml} = await import('../scripts/document-core.mjs');
  const bytes = await readFile(path);
  const format = extname(file.output).toLowerCase();
  let paragraphs,layout;
  if (format === '.docx') {
    const document = await loadOoxmlDocument(bytes);
    paragraphs = document.paragraphs.map((item, index) => ({id: `p-${index}`, runs: paragraphRuns(item.paragraph)}));
    layout = await docxLayout(document,parseOoxml,paragraphRuns);
  } else if (format === '.pdf') {
    const pages = await readTextItems(bytes);
    paragraphs = pages.map((page, index) => ({id: `p-${index}`, label: `第 ${index + 1} 页`, runs: [{kind: 'text', text: page.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('')}]}));
  } else throw Object.assign(new Error('此文件格式暂不支持预览。'), {status: 415});
  if (paragraphs.length > 20000 || paragraphs.reduce((sum, p) => sum + p.runs.reduce((n, r) => n + r.text.length, 0), 0) > 2000000) {
    throw Object.assign(new Error('正文过长，请下载标注版查看，未截取部分内容作为完整预览。'), {status: 413});
  }
  return {name: file.output, format, status: file.status, annotated: file.annotated || 0, paragraphs,layout,
    issues: file.written_issues || [], unmatched: file.unmatched || [], filtered: file.filtered || [],
    validation_rejected: file.validation_rejected || [], verification_rejected: file.verification_rejected || []};
}
