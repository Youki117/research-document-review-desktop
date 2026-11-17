import {readFile, writeFile, mkdir, rename} from 'node:fs/promises';
import {join, extname, basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {annotatedArtifact, paragraphRuns} from './preview.mjs';

const activeWrites = new Set();
const problem = (message, status = 400) => Object.assign(new Error(message), {status});
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const elements = node => (node.elements || []).filter(child => child.type === 'element');
const textOf = node => paragraphRuns(node).map(run => run.text).join('');
function walk(node, callback) { callback(node); for (const child of node.elements || []) walk(child, callback); }

function revisionPairs(document, issues) {
  const pairs = [];
  let revisions = 0;
  walk(document.parts.get('word/document.xml'), node => { if (['w:ins', 'w:del', 'w:moveFrom', 'w:moveTo'].includes(node.name)) revisions++; });
  for (const [paragraphIndex, paragraph] of document.paragraphs.entries()) {
    function visit(parent) {
      const children = elements(parent);
      for (let index = 0; index < children.length; index++) {
        const deletion = children[index];
        if (deletion.name !== 'w:del') { visit(deletion); continue; }
        const insertion = children[index + 1], start = children[index - 1], end = children[index + 2];
        if (insertion?.name !== 'w:ins' || start?.name !== 'w:commentRangeStart' || end?.name !== 'w:commentRangeEnd' || start.attributes?.['w:id'] !== end.attributes?.['w:id']) throw problem('此文档的修订结构不支持安全审批，请用 Word/WPS 处理。', 409);
        const deletionId = deletion.attributes?.['w:id'], insertionId = insertion.attributes?.['w:id'];
        if (!/^\d+$/.test(deletionId || '') || !/^\d+$/.test(insertionId || '')) throw problem('修订标识无效。', 409);
        const original = textOf(deletion), suggested = textOf(insertion);
        const matches = issues.filter(issue => issue.original === original && issue.suggested === suggested);
        const issue = matches.find(item => paragraph.text.includes(item.context)) || matches[0];
        pairs.push({id: `${deletionId}:${insertionId}`, deletion_id: deletionId, insertion_id: insertionId,
          comment_id: start.attributes['w:id'], paragraph_id: `p-${paragraphIndex}`, original, suggested,
          context: paragraph.text, reason: issue?.reason || '请结合标注版和报告核对。', parent, deletion, insertion});
      }
    }
    visit(paragraph.paragraph);
  }
  if (revisions !== pairs.length * 2 || new Set(pairs.map(pair => pair.id)).size !== pairs.length) throw problem('修订未完整对应，已阻止生成审批副本。', 409);
  return pairs;
}
const publicPair = ({parent, deletion, insertion, ...pair}) => pair;
const recordPath = directory => join(directory, '..', 'private', 'approval.json');
async function atomicJson(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8'); await rename(temp, path);
}
async function load(job, directory) {
  const artifact = await annotatedArtifact(job, directory);
  if (extname(artifact.path).toLowerCase() !== '.docx') return {supported: false, message: '逐条审批和局部编辑目前支持 DOCX；PDF 可预览正文及下载批注版。'};
  const codec = await import('../scripts/document-core.mjs');
  const document = await codec.loadOoxmlDocument(await readFile(artifact.path));
  const pairs = revisionPairs(document, artifact.file.written_issues || []);
  let saved;
  try { saved = await readJson(recordPath(directory)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved && (saved.source_name !== artifact.file.output || saved.source_size !== artifact.info.size || saved.source_mtime_ms !== artifact.info.mtimeMs || saved.items.length !== pairs.length || saved.items.some((item, index) => item.id !== pairs[index].id || item.original !== pairs[index].original || item.suggested !== pairs[index].suggested))) {
    throw problem('标注副本已变化，原审批记录不再适用；请创建新任务重新审查。', 409);
  }
  const state = saved || {revision: 0, status: 'in_review', reviewer: '', note: '', updated_at: null, approved_at: null,
    source_name: artifact.file.output, source_size: artifact.info.size, source_mtime_ms: artifact.info.mtimeMs,
    items: pairs.map(pair => ({...publicPair(pair), decision: 'pending', replacement: pair.suggested}))};
  return {supported: true, state, document, pairs, codec, artifact};
}
function view(state, job) {
  return {...state, supported: true, machine_status: job.result_status || 'unknown',
    files: state.status === 'approved' ? [{name: resultName(job), url: `/api/jobs/${job.id}/approval/files/document`}] : []};
}
function resultName(job) { return basename(job.document_names?.[0] || '文档.docx').replace(/\.docx$/i,'').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0,120) + '_已修正.docx'; }
export async function getApproval(job, directory) {
  const loaded = await load(job, directory);
  return loaded.supported ? view(loaded.state, job) : loaded;
}
function validatedRequest(request, current) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['action', 'expected_revision', 'items', 'reviewer', 'note'].includes(key))) throw problem('审批请求字段无效。');
  if (!['save', 'approve', 'reopen'].includes(request.action)) throw problem('审批操作无效。');
  if (!Number.isSafeInteger(request.expected_revision) || request.expected_revision !== current.revision) throw problem('审批记录已在其他窗口更新，请重新载入后再保存。', 409);
  if (request.action === 'reopen') {
    if (current.status !== 'approved') throw problem('当前任务尚未完成审批。', 409);
    return {...current, status: 'in_review', approved_at: null, export_id: null};
  }
  if (current.status === 'approved') throw problem('已完成的审批记录已锁定，请先重新审批。', 409);
  for (const [key, limit] of [['reviewer', 80], ['note', 2000]]) {
    if (typeof request[key] !== 'string' || request[key].length > limit || !request[key].isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(request[key])) throw problem('审核人或备注无效。');
  }
  if (!Array.isArray(request.items) || request.items.length !== current.items.length || new Set(request.items.map(item => item?.id)).size !== current.items.length) throw problem('每条修订都需要独立的审批记录，不能重复或遗漏。');
  const items = current.items.map(existing => {
    const item = request.items.find(entry => entry?.id === existing.id);
    if (!item || Object.keys(item).some(key => !['id', 'decision', 'replacement'].includes(key)) || !['pending', 'accept', 'reject'].includes(item.decision) || typeof item.replacement !== 'string' || item.replacement.length > 8000 || !item.replacement.isWellFormed() || /[\x00-\x1f]/.test(item.replacement)) throw problem('修订决定或替换文字无效；局部替换须为不超过 8000 字的单行文字。');
    return {...existing, decision: item.decision, replacement: item.replacement};
  });
  if (request.action === 'approve' && items.some(item => item.decision === 'pending')) throw problem('仍有待定建议，请逐条接受或驳回后确认审批。', 409);
  return {...current, reviewer: request.reviewer.trim(), note: request.note, items, export_id: null};
}
async function approvedDocument(loaded, items) {
  const {document, pairs, codec} = loaded;
  const removedComments = new Set(pairs.map(pair => pair.comment_id));
  for (const pair of pairs) {
    const decision = items.find(item => item.id === pair.id);
    let retained = structuredClone(decision.decision === 'accept' ? pair.insertion.elements : pair.deletion.elements) || [];
    if (decision.decision === 'accept') {
      const textNodes = [];
      for (const node of retained) walk(node, child => { if (child.name === 'w:t') textNodes.push(child); });
      if (textNodes.length !== 1) throw problem('此修订的文本结构不支持安全导出。', 409);
      textNodes[0].elements = [{type: 'text', text: decision.replacement}];
      textNodes[0].attributes = {...textNodes[0].attributes, 'xml:space': 'preserve'};
      for (const node of retained) walk(node, child => { if (child.elements) child.elements = child.elements.filter(element => element.name !== 'w:highlight'); });
    } else {
      for (const node of retained) walk(node, child => { if (child.name === 'w:delText') { child.name = 'w:t'; child.attributes = {...child.attributes, 'xml:space': 'preserve'}; } });
    }
    const children = pair.parent.elements;
    const deletionIndex = children.indexOf(pair.deletion), insertionIndex = children.indexOf(pair.insertion);
    if (deletionIndex < 0 || insertionIndex < deletionIndex) throw problem('修订位置发生变化，已停止导出。', 409);
    children.splice(deletionIndex, insertionIndex - deletionIndex + 1, ...retained);
  }
  const root = document.parts.get('word/document.xml');
  walk(root, node => { if (node.elements) node.elements = node.elements.filter(child => !(['w:commentRangeStart', 'w:commentRangeEnd', 'w:commentReference'].includes(child.name) && removedComments.has(child.attributes?.['w:id']))); });
  walk(root, node => { if (['w:ins', 'w:del', 'w:moveFrom', 'w:moveTo'].includes(node.name)) throw problem('仍有未处理的修订，已停止导出。', 409); });
  document.archive.file('word/document.xml', codec.serializeOoxml(root, {compact: false}));
  const commentsFile = document.archive.file('word/comments.xml');
  if (commentsFile) {
    const comments = codec.parseOoxml(await commentsFile.async('string'), {compact: false});
    walk(comments, node => { if (node.elements) node.elements = node.elements.filter(child => !(child.name === 'w:comment' && removedComments.has(child.attributes?.['w:id']))); });
    document.archive.file('word/comments.xml', codec.serializeOoxml(comments, {compact: false}));
  }
  return Buffer.from(await document.archive.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'}));
}
export async function updateApproval(job, directory, request) {
  if (activeWrites.has(directory)) throw problem('此文档正在保存审批记录，请稍后重试。', 409);
  activeWrites.add(directory);
  try {
    const loaded = await load(job, directory);
    if (!loaded.supported) throw problem(loaded.message, 415);
    const next = validatedRequest(request, loaded.state);
    next.revision++; next.updated_at = new Date().toISOString();
    if (request.action === 'approve') {
      const bytes = await approvedDocument(loaded, next.items);
      next.status = 'approved'; next.approved_at = next.updated_at; next.export_id = randomUUID();
      const folder = join(directory, 'approved', next.export_id);
      await mkdir(folder, {recursive: true});
      next.document_name = resultName(job);
      await writeFile(join(folder, next.document_name), bytes, {flag: 'wx'});
      await writeFile(join(folder, '审批记录.json'), JSON.stringify({...next, job_id: job.id, machine_status: job.result_status,
        scope: '仅处理机器标注版中已写入的修订；未覆盖范围和未定位项目仍以原审查报告为准。'}, null, 2), {encoding: 'utf8', flag: 'wx'});
    }
    await mkdir(join(directory, '..', 'private'), {recursive: true});
    await atomicJson(recordPath(directory), next);
    return view(next, job);
  } finally { activeWrites.delete(directory); }
}
export async function approvalFile(job, directory, kind) {
  if (!['document', 'record'].includes(kind)) throw problem('未找到审批成果。', 404);
  const loaded = await load(job, directory);
  const state = loaded.state;
  if (!loaded.supported || state.status !== 'approved' || !/^[\da-f-]{36}$/.test(state.export_id || '')) throw problem('尚未生成当前审批版本的成果。', 409);
  const storedName = kind === 'document' ? state.document_name || '人工审批版.docx' : '审批记录.json';
  if (basename(storedName) !== storedName) throw problem('导出文件名无效。', 409);
  return {name:kind === 'document' ? resultName(job) : storedName, path: join(directory, 'approved', state.export_id, storedName)};
}
