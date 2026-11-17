#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { basename, extname, join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { outputFileName } from './regional-profile.mjs';
import {requestWithRecovery, mapConcurrent} from './discovery.mjs';
import {
  splitSingleFile, flattenParsedFiles, batchMergeChunk, buildReviewState, buildAnnotationState
} from './workflow-core.mjs';
import {
  annotateDocx, annotatePdf, readTextItems, loadOoxmlDocument, prepareIssuesWithReport
} from './document-core.mjs';

const MAX_FILES = 1;
const timeoutMs = Number(process.env.REVIEW_TIMEOUT_MS || 120000);
const promptsPath = new URL('../references/prompts.json', import.meta.url);
const modelAudit = [];
// Original FastGPT multi-file workflow: two chunks, two branches per chunk; two verification batches.
const CONCURRENCY = 2;
let activeRequests = 0, peakRequests = 0, diagnosticSequence = 0;
let progressWrites = Promise.resolve();
let progressPath, currentProgress = {};
async function saveProgress(update) {
  if (!progressPath) return;
  Object.assign(currentProgress, update, {updated_at: new Date().toISOString(), requests: modelAudit.length});
  progressWrites = progressWrites.then(async () => {
    await writeFile(progressPath + '.tmp', JSON.stringify(currentProgress), 'utf8');
    await rename(progressPath + '.tmp', progressPath);
  });
  await progressWrites;
}

function usage() {
  return 'Usage: node proofread.mjs [--output-dir DIR] FILE.docx|FILE.pdf ...\n       node proofread.mjs prepare --output-dir NEWDIR FILE...\n       node proofread.mjs verify-input --prepared prepared.json --discovery discoveries.json --output review.json\n       node proofread.mjs finalize --review review.json --verification verifications.json --output-dir NEWDIR';
}
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required');
function fail(message) { throw new Error(message); }
function hash(data) { return createHash('sha256').update(data).digest('hex'); }
function safeName(name) { return basename(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 160) || 'document'; }
function parseJson(raw, label) {
  try { return JSON.parse(raw); } catch { fail(`${label} must be valid JSON`); }
}
function parseModelArray(content, stage) {
  let raw = content.trim().replace(/^\uFEFF/, '');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fenced) raw = fenced[1].trim();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) fail(`${stage} response must be a JSON array`);
    return parsed;
  } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  const start = raw.indexOf('['), end = raw.lastIndexOf(']');
  if (start < 0 || end < start) fail(`${stage} response must be valid JSON`);
  raw = raw.slice(start, end + 1);
  let cleaned = '', inString = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    // Only remove syntax outside strings; never rewrite source text or invent missing values.
    if (!inString && char === ',' && /^\s*[}\]]/.test(raw.slice(i + 1))) continue;
    cleaned += char;
    if (escaped) escaped = false;
    else if (inString && char === '\\') escaped = true;
    else if (char === '"') inString = !inString;
  }
  const parsed = parseJson(cleaned, `${stage} response`);
  if (!Array.isArray(parsed)) fail(`${stage} response must be a JSON array`);
  return parsed;
}
function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be a non-empty string`);
  return value;
}
function cli(args) {
  let phase = 'run', outputDir, preparedFile, discoveryFile, reviewFile, verificationFile, outputFile, checkpoint;
  const rest = [];
  if (['prepare', 'verify-input', 'finalize', 'run'].includes(args[0])) phase = args.shift();
  while (args.length) {
    const arg = args.shift();
    if (arg === '--output-dir') outputDir = args.shift();
    else if (arg === '--checkpoint') checkpoint = args.shift();
    else if (arg === '--prepared') preparedFile = args.shift();
    else if (arg === '--discovery') discoveryFile = args.shift();
    else if (arg === '--review') reviewFile = args.shift();
    else if (arg === '--verification') verificationFile = args.shift();
    else if (arg === '--output') outputFile = args.shift();
    else if (arg.startsWith('-')) fail(`Unknown option: ${arg}`);
    else rest.push(arg);
  }
  if (phase === 'verify-input' && (!preparedFile || !discoveryFile || !outputFile)) fail('verify-input requires --prepared, --discovery, and --output');
  if (phase === 'finalize' && (!reviewFile || !verificationFile || !outputDir)) fail('finalize requires --review, --verification, and --output-dir');
  return { phase, checkpoint: checkpoint && resolve(checkpoint), outputDir: outputDir && resolve(outputDir), preparedFile: preparedFile && resolve(preparedFile), discoveryFile: discoveryFile && resolve(discoveryFile), reviewFile: reviewFile && resolve(reviewFile), verificationFile: verificationFile && resolve(verificationFile), outputFile: outputFile && resolve(outputFile), paths: rest.map((p) => resolve(p)) };
}
function validatePaths(paths) {
  if (!paths.length || paths.length > MAX_FILES) fail('Supply exactly 1 DOCX/PDF file');
  return paths.map((path, i) => {
    const extension = extname(path).toLowerCase().slice(1);
    if (!['docx', 'pdf'].includes(extension)) fail(`Unsupported file type: ${basename(path)}`);
    return { file_id: `F${String(i + 1).padStart(3, '0')}`, file_index: i, file_url: path, original_name: basename(path), extension };
  });
}
async function createOutputDir(requested) {
  const dir = requested || join(process.cwd(), `proofread-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(dir, { recursive: false });
  return resolve(dir);
}
function plainDocxText(paragraphs) {
  return paragraphs.map((p) => String(p.text ?? '')).filter((s) => s.trim()).join('\n');
}
async function extract(task, bytes) {
  if (task.extension === 'docx') {
    const doc = await loadOoxmlDocument(bytes);
    const raw = await doc.archive.file('word/document.xml').async('string');
    if (/<w:(?:ins|del|moveFrom|moveTo)(?:\s|>)/i.test(raw)) fail('DOCX contains tracked revisions; accept or reject them before review');
    const text = plainDocxText(doc.paragraphs);
    if (!text.trim()) fail('DOCX has no extractable paragraph text');
    return text;
  }
  const pages = await readTextItems(bytes);
  if (!pages.length || pages.some((page) => !page.map((x) => x.str).join('').trim())) fail('PDF has an empty text page; OCR is required before review');
  return pages.map((page) => page.map((item) => item.str + (item.hasEOL ? '\n' : '')).join('')).join('\n');
}
async function chat(stage, prompt, payload) {
  const url = process.env.REVIEW_CHAT_URL;
  const model = process.env.REVIEW_MODEL;
  const apiKey = process.env.REVIEW_API_KEY;
  if (!url || !model || !apiKey) {
    modelAudit.push({ stage, model: model || null, status: 'failed', elapsed_ms: 0, error: 'missing_model_configuration' });
    fail('Set REVIEW_CHAT_URL, REVIEW_MODEL, and REVIEW_API_KEY to enable model calls');
  }
  const body = { model, temperature: prompt.temperature ?? 0, messages: [
    { role: 'system', content: prompt.system_prompt },
    { role: 'user', content: JSON.stringify(payload) }
  ] };
  // The company MS_LLM gateway accepts low reasoning; measured long-block latency fell below the timeout.
  if (model === 'MS_LLM') body.reasoning_effort = 'low';
  if (/^doubao-seed-/i.test(model)) {
    body.thinking = { type: 'disabled' };
    body.max_tokens = 8192;
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    await saveProgress({pass: stage});
    const started = performance.now();
    const requestInfo = {started_at:new Date().toISOString(), chunk_id:payload.chunk_id, batch_id:payload.batch_id, active_requests:++activeRequests};
    peakRequests = Math.max(peakRequests, activeRequests);
    let status = 'failed', usage = null, httpStatus = null, content;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      });
      httpStatus = response.status;
      if (!response.ok) fail(`${stage} request failed (HTTP ${response.status})`);
      const data = await response.json();
      usage = data.usage || null;
      if (data?.choices?.[0]?.finish_reason && data.choices[0].finish_reason !== 'stop') fail(`${stage} response ended before completion`);
      content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') fail(`${stage} returned no text content`);
      const parsed = parseModelArray(content, stage);
      status = 'success';
      return parsed;
    } catch (error) {
      const formatError = [`${stage} response must be valid JSON`, `${stage} response must be a JSON array`].includes(error.message);
      if (progressPath && formatError && typeof content === 'string') {
        await writeFile(join(dirname(progressPath),'private',`invalid-${safeName(stage)}-${safeName(payload.chunk_id || payload.batch_id || 'batch')}-${++diagnosticSequence}-${attempt}.txt`),content.slice(0,256000),'utf8');
      }
      modelAudit.push({ ...requestInfo, stage, model, attempt, status, elapsed_ms: Math.round(performance.now() - started), http_status: httpStatus, usage, error: String(error.message || error).slice(0, 300) });
      if (attempt !== 1 || !formatError) throw error;
      // An identical retry can return the same malformed response from the gateway cache.
      body.messages.push({role:'assistant', content}, {role:'user', content:'上一次返回不是合法 JSON。请只纠正 JSON 语法并输出完整 JSON 数组，不加解释或代码围栏；字符串中的反斜杠、双引号和换行必须正确转义。保留原段落编号和检查范围，不要新增或猜测数值。'});
    } finally {
      clearTimeout(timer);
      activeRequests--;
      if (status === 'success') modelAudit.push({ ...requestInfo, stage, model, attempt, status, elapsed_ms: Math.round(performance.now() - started), http_status: httpStatus, usage });
      await saveProgress({});
    }
  }
}
function assertExactIds(actual, expected, label) {
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || expected.some((id) => !actual.includes(id))) fail(`${label} must contain every expected ID exactly once`);
}
async function prepare(paths, outputDir) {
  const tasks = validatePaths(paths);
  const out = await createOutputDir(outputDir);
  const files = [];
  for (const task of tasks) {
    try {
      if ((await stat(task.file_url)).size > 50 * 1024 * 1024) fail('File exceeds the 50 MiB per-file limit');
      const bytes = await readFile(task.file_url);
      const sourceText = await extract(task, bytes);
      const split = splitSingleFile({ parsedText: sourceText, task, targetSize: 1800 });
      const context = split.fileContext;
      context.output_file_name = outputFileName(task.original_name, task.extension);
      files.push({ ...context, source_path: task.file_url, source_sha256: hash(bytes), source_size: bytes.length, success: true });
    } catch (error) {
      files.push({ ...task, source_path: task.file_url, success: false, error: String(error.message || error).slice(0, 500) });
    }
  }
  const fileTasks = files.map((f) => ({ ...f, file_url: f.source_path }));
  const flat = flattenParsedFiles({ fileTasks, fullResults: files.map((f) => f.success ? { success: true, data: f } : { success: false, message: f.error }) });
  const discoveryTasks = flat.chunkTasks.map((task) => {
    const chunk = parseJson(task.chunk_json, 'chunk');
    return { file_id: task.file_id, chunk_id: chunk.chunk_id, paragraphs: chunk.paragraphs };
  });
  return { version: 1, output_dir: out, files, discoveryTasks };
}
async function verify(state, prompts, checkpoint) {
  const results = [];
  const audit = [];
  let reusedBatches = 0, completedBatches = 0;
  await saveProgress({completed_verification_batches:0, total_verification_batches:state.verificationTasks.length, reused_verification_batches:0});
  await mapConcurrent(state.verificationTasks, CONCURRENCY, async (task, taskIndex) => {
    const batch = parseJson(task.batch_json, 'verification batch');
    const candidates = batch.candidates;
    try {
      const saved = checkpoint?.verifications.find(item => item.file_id === task.file_id && JSON.stringify(item.batch) === JSON.stringify(batch));
      const decisions = saved ? saved.decisions : [];
      if (!saved) {
        for (let index = 0; index < candidates.length; index += 5) {
          decisions.push(...await requestWithRecovery(chat, 'verification', prompts.verification, {...batch, candidates:candidates.slice(index, index + 5)}));
        }
      }
      assertExactIds(decisions.map((d) => String(d.candidate_id || '')), candidates.map((c) => c.candidate_id), `Verification batch ${batch.batch_id}`);
      const normalized = decisions.map((d) => ({ ...d, decision: String(d.decision || '').toLowerCase() }));
      if (normalized.some((d) => !['accept', 'reject'].includes(d.decision) || typeof d.wrong_text !== 'string' || typeof d.suggested_text !== 'string' || typeof d.reason !== 'string')) fail(`Verification batch ${batch.batch_id} has an invalid decision`);
      if (saved) reusedBatches++;
      else if (checkpoint) {
        checkpoint.verifications.push({file_id:task.file_id, batch, decisions:normalized});
        await checkpoint.save();
      }
      results[taskIndex] = { success: true, data: normalized };
      audit[taskIndex] = { success: true, file_id: task.file_id, batch_id: batch.batch_id, decisions: normalized };
    } catch (error) {
      const message = String(error.message || error).slice(0, 500);
      results[taskIndex] = { success: false, message };
      audit[taskIndex] = { success: false, file_id: task.file_id, batch_id: batch.batch_id, error: message };
    }
    await saveProgress({completed_verification_batches:++completedBatches, total_verification_batches:state.verificationTasks.length, reused_verification_batches:reusedBatches});
  });
  const annotation = buildAnnotationState({ reviewState: state.reviewState, verificationTasks: state.verificationTasks, verificationFullResults: results });
  for (const file of annotation.annotationState.files) file.verification_audit = audit.filter((a) => a.file_id === file.file_id);
  annotation.reused_verification_batches = reusedBatches;
  return annotation;
}
function prepareVerificationInput(envelope) {
  const state = envelope.state;
  if (!state || !Array.isArray(state.files) || !Array.isArray(state.discoveryTasks) || !Array.isArray(envelope.discoveries)) fail('Input requires state.files, state.discoveryTasks, and discoveries');
  const tasks = state.discoveryTasks;
  const expected = tasks.map((t) => `${t.file_id}\0${t.chunk_id}`);
  const actual = envelope.discoveries.map((d) => `${d.file_id}\0${d.chunk_id}`);
  assertExactIds(actual, expected, 'Discovery results');
  const fileTasks = state.files.map((f) => ({ ...f, file_url: f.source_path }));
  const discoveryById = new Map(envelope.discoveries.map((item) => [`${item.file_id}\0${item.chunk_id}`, item]));
  const full = tasks.map((task) => {
    const item = discoveryById.get(`${task.file_id}\0${task.chunk_id}`);
    if (item.failure) return { success: false, message: String(item.failure).slice(0, 500) };
    if (!Array.isArray(item.surface) || !Array.isArray(item.language)) fail(`Discovery ${task.file_id}/${task.chunk_id} requires two result arrays`);
    try {
      return { success: true, data: batchMergeChunk({ surfaceJson: item.surface, languageJson: item.language }).combinedJson };
    } catch (error) { return { success: false, message: String(error.message || error).slice(0, 500) }; }
  });
  const flat = flattenParsedFiles({ fileTasks, fullResults: state.files.map((f) => f.success ? { success: true, data: f } : { success: false, message: f.error }) });
  const built = buildReviewState({ parseState: flat.parseState, chunkTasks: flat.chunkTasks, discoveryFullResults: full });
  const verificationTasks = built.verificationTasks.map((t) => ({ file_id: t.file_id, batch_index: t.batch_index, batch: parseJson(t.batch_json, 'verification batch') }));
  return { version: 1, output_dir: state.output_dir, files: state.files, reviewState: built.reviewState, verificationTasks };
}
async function finalize(state, annotation, outputDir) {
  const dir = outputDir || state.output_dir;
  if (!dir) fail('Missing output directory');
  if (resolve(dir) !== resolve(state.output_dir)) await mkdir(dir, { recursive: false });
  const files = [];
  const annotationTasks = new Map((annotation.annotationTasks || []).map((task) => [task.file_id, task]));
  for (const file of annotation.annotationState.files) {
    const sourceMeta = state.files.find((x) => x.file_id === file.file_id);
    if (!sourceMeta?.success) { files.push({ file_id: file.file_id, name: file.original_name, status: 'failed', error: sourceMeta?.error || 'Review failed' }); continue; }
    try {
      if (!file.success || file.error) fail(file.error || 'Review stage failed');
      const source = await readFile(sourceMeta.source_path);
      if (hash(source) !== sourceMeta.source_sha256) fail('Source changed after review; refusing to finalize');
      const annotationTask = annotationTasks.get(file.file_id);
      if (!annotationTask) fail('Annotation task was not returned');
      const rawIssues = JSON.parse(annotationTask.issues_json || '[]');
      const converted = rawIssues.map((i) => ({ sourceText: i.source_text, wrongText: i.wrong_text, suggestedText: i.suggested_text, reason: i.reason, applyScope: i.apply_scope }));
      const prepared = prepareIssuesWithReport(converted);
      const extension = sourceMeta.extension;
      const result = prepared.issues.length ? (extension === 'docx' ? await annotateDocx(source, prepared.issues, 'Document Proofread') : await annotatePdf(source, prepared.issues)) : { output: source, annotatedCount: 0, unmatchedIssues: [] };
      const outputName = safeName(`${file.file_id}-${file.output_file_name || `[标注版]${sourceMeta.original_name}`}`);
      const outputPath = join(dir, outputName);
      await writeFile(outputPath, result.output, { flag: 'wx' });
      const unmatchedIndexes = new Set(result.unmatchedIssues.map((item) => item.index));
      const writtenIssues = prepared.issues.filter((_, index) => !unmatchedIndexes.has(index));
      const status = prepared.filteredIssues.length || result.unmatchedIssues.length || file.validation_rejected_count || file.invalid_discovery_count ? 'partial' : 'complete';
      files.push({ file_id: file.file_id, name: sourceMeta.original_name, status, source_sha256: sourceMeta.source_sha256,
        output: outputName, discovered: file.candidate_count, accepted: file.reviewer_accepted_count,
        discovery_audit: file.candidates || [], verification_audit: file.verification_audit || [], invalid_discovery_count: file.invalid_discovery_count || 0,
        written_issues: writtenIssues.map((i) => ({ original: i.wrongText, suggested: i.suggestedText, reason: i.reason, context: i.sourceText })),
        validation_rejected: file.validation_rejections || [], filtered: prepared.filteredIssues.map((x) => ({ code: x.code, reason: x.reason, original: x.issue?.wrongText, suggested: x.issue?.suggestedText, context: x.issue?.sourceText })),
        unmatched: result.unmatchedIssues.map((x) => ({ code: x.code, reason: x.reason, original: x.issue?.wrongText, suggested: x.issue?.suggestedText, context: x.issue?.sourceText })), annotated: result.annotatedCount });
    } catch (error) {
      files.push({ file_id: file.file_id, name: sourceMeta.original_name, status: 'failed', error: String(error.message || error).slice(0, 500) });
    }
  }
  const report = { created_at: new Date().toISOString(), concurrency:{chunks:CONCURRENCY, branches_per_chunk:2, verification_batches:CONCURRENCY, peak_model_requests:peakRequests}, model_calls: modelAudit.length ? 'fresh_chat_completions_requests' : 'host_supplied_or_none', model_audit: modelAudit, reused_discovery_passes:state.reused_discovery_passes || 0, reused_verification_batches:annotation.reused_verification_batches || 0, files };
  await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  const inline = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_[\]{}()#!|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
  const labels = {complete:'完成', partial:'部分完成', failed:'失败'};
  const lines = ['# 研发文档校对报告', '', `生成时间：${report.created_at}`, '', report.model_audit.length ? `模型请求：${report.model_audit.length} 次；每次为独立接口上下文。` : '模型结果由宿主提供；独立上下文及用量需以宿主日志核对。', ''];
  if (report.reused_discovery_passes) lines.push(`复用此前成功检查：${report.reused_discovery_passes} 次；文档、分块、模型接口与提示词已核对一致。`, '');
  if (report.reused_verification_batches) lines.push(`复用此前成功复核：${report.reused_verification_batches} 批；候选内容已核对一致。`, '');
  for (const f of files) lines.push(`## ${inline(f.name || f.file_id)}`, '', `状态：${labels[f.status]}`, f.output ? `输出文件：${inline(f.output)}` : '', f.error ? `失败原因：${inline(f.error)}` : '', `候选：${f.discovered ?? 0}；复核接受：${f.accepted ?? 0}；实际标注：${f.annotated ?? 0}；保护拒绝：${f.validation_rejected?.length ?? 0}；工具过滤：${f.filtered?.length ?? 0}；未定位：${f.unmatched?.length ?? 0}`, '', ...(f.written_issues || []).map((i) => `- ${inline(i.original)} → ${inline(i.suggested)}：${inline(i.reason)}`), f.validation_rejected?.length ? `保护拒绝详情：${inline(JSON.stringify(f.validation_rejected))}` : '', f.filtered?.length ? `工具过滤详情：${inline(JSON.stringify(f.filtered))}` : '', f.unmatched?.length ? `未定位详情：${inline(JSON.stringify(f.unmatched))}` : '', '');
  await writeFile(join(dir, 'report.md'), lines.join('\n'), { flag: 'wx' });
  return report;
}
async function readInput(path) { return parseJson(await readFile(path, 'utf8'), path); }
async function writeJson(path, value) { await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx' }); }
async function main(args) {
  const options = cli(args);
  const prompts = parseJson(await readFile(promptsPath, 'utf8'), 'prompts.json');
  if (options.phase === 'prepare') {
    const result = await prepare(options.paths, options.outputDir);
    const path = join(result.output_dir, 'prepared.json');
    await writeJson(path, result);
    process.stdout.write(JSON.stringify({ prepared: path, files: result.files.map((f) => ({ file_id: f.file_id, success: f.success, error: f.error })), discoveryTasks: result.discoveryTasks }, null, 2)); return;
  }
  if (options.phase === 'verify-input') {
    const state = await readInput(options.preparedFile);
    const discovery = await readInput(options.discoveryFile);
    const result = prepareVerificationInput({ state, discoveries: discovery.discoveries });
    await writeJson(options.outputFile, result);
    process.stdout.write(JSON.stringify({ review: options.outputFile, verificationTasks: result.verificationTasks }, null, 2)); return;
  }
  if (options.phase === 'finalize') {
    const state = await readInput(options.reviewFile);
    const wrapper = await readInput(options.verificationFile);
    if (!state?.reviewState || !Array.isArray(state.verificationTasks) || !Array.isArray(wrapper.verifications)) fail('Input requires state.reviewState, state.verificationTasks, and verifications');
    const tasks = state.verificationTasks;
    const expected = tasks.map((t) => `${t.file_id}\0${t.batch.batch_id}`);
    const actual = wrapper.verifications.map((v) => `${v.file_id}\0${v.batch_id}`);
    assertExactIds(actual, expected, 'Verification results');
    const verificationById = new Map(wrapper.verifications.map((v) => [`${v.file_id}\0${v.batch_id}`, v]));
    const results = tasks.map((task) => {
      const v = verificationById.get(`${task.file_id}\0${task.batch.batch_id}`);
      try {
        const candidates = task.batch.candidates;
        if (!Array.isArray(v.decisions)) fail(`Verification batch ${v.batch_id} decisions must be an array`);
        assertExactIds(v.decisions.map((d) => String(d.candidate_id || '')), candidates.map((c) => c.candidate_id), `Verification batch ${v.batch_id}`);
        if (v.decisions.some((d) => !['accept', 'reject'].includes(String(d.decision || '').toLowerCase()) || typeof d.wrong_text !== 'string' || typeof d.suggested_text !== 'string' || typeof d.reason !== 'string')) fail(`Verification batch ${v.batch_id} has an invalid decision`);
        return { success: true, data: v.decisions.map((d) => ({ ...d, decision: String(d.decision).toLowerCase() })) };
      } catch (error) { return { success: false, message: String(error.message || error).slice(0, 500) }; }
    });
    const buildTasks = tasks.map((t) => ({ file_id: t.file_id, batch_index: t.batch_index, batch_json: JSON.stringify(t.batch) }));
    const annotation = buildAnnotationState({ reviewState: state.reviewState, verificationTasks: buildTasks, verificationFullResults: results });
    for (const file of annotation.annotationState.files) file.verification_audit = wrapper.verifications.filter((v) => v.file_id === file.file_id).map((v) => ({ batch_id: v.batch_id, decisions: v.decisions }));
    const report = await finalize(state, annotation, options.outputDir);
    process.stdout.write(JSON.stringify(report, null, 2));
    if (report.files.length && report.files.every((file) => file.status === 'failed')) process.exitCode = 1;
    return;
  }
  const prepared = await prepare(options.paths, options.outputDir);
  progressPath = join(prepared.output_dir, 'progress.json');
  await saveProgress({stage:'discovery', completed_chunks:0, total_chunks:prepared.discoveryTasks.length});
  const identity = {sources:prepared.files.map(file=>file.source_sha256),tasks:prepared.discoveryTasks,model:process.env.REVIEW_MODEL,url:process.env.REVIEW_CHAT_URL,reasoning:process.env.REVIEW_MODEL === 'MS_LLM' ? 'low' : null,prompts};
  const records = new Map();
  const verifications = [];
  if (options.checkpoint) {
    try {
      const saved = await readInput(options.checkpoint);
      if (saved.version === 1 && JSON.stringify(saved.identity) === JSON.stringify(identity) && Array.isArray(saved.discoveries)) {
        for (const item of saved.discoveries) records.set(`${item.file_id}:${item.chunk_id}`, item);
        if (Array.isArray(saved.verifications)) verifications.push(...saved.verifications);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const checkpointPath = join(prepared.output_dir, 'private', 'discovery-checkpoint.json');
  await mkdir(join(prepared.output_dir, 'private'), {recursive:true});
  let checkpointWrites = Promise.resolve();
  async function saveCheckpoint() {
    checkpointWrites = checkpointWrites.then(async () => {
      await writeFile(checkpointPath + '.tmp', JSON.stringify({version:1,identity,discoveries:[...records.values()],verifications}), 'utf8');
      await rename(checkpointPath + '.tmp', checkpointPath);
    });
    await checkpointWrites;
  }
  let reusedPasses = 0, completedChunks = 0;
  const inputTasks = prepared.discoveryTasks;
  const discoveries = await mapConcurrent(inputTasks, CONCURRENCY, async task => {
    const chunk = { chunk_id: task.chunk_id, paragraphs: task.paragraphs };
    const key = `${task.file_id}:${task.chunk_id}`;
    const record = records.get(key) || {file_id:task.file_id, chunk_id:task.chunk_id};
    delete record.failure;
    records.set(key,record);
    const passes = await Promise.allSettled(['surface','language'].map(async pass => {
      if (Array.isArray(record[pass])) reusedPasses++;
      else { record[pass] = await requestWithRecovery(chat, `${pass} discovery`, prompts[pass], chunk); await saveCheckpoint(); }
    }));
    const failed = passes.find(result => result.status === 'rejected');
    if (failed) record.failure = String(failed.reason.message || failed.reason);
    await saveCheckpoint();
    await saveProgress({completed_chunks:++completedChunks, reused_passes:reusedPasses});
    return record;
  });
  await saveProgress({stage:'verification'});
  const review = prepareVerificationInput({ state: prepared, discoveries });
  review.reused_discovery_passes = reusedPasses;
  const annotation = await verify({ reviewState: review.reviewState, verificationTasks: review.verificationTasks.map((t) => ({ ...t, batch_json: JSON.stringify(t.batch) })) }, prompts, {verifications,save:saveCheckpoint});
  const report = await finalize(review, annotation, prepared.output_dir);
  await saveProgress({stage:'complete'});
  process.stdout.write(JSON.stringify(report, null, 2));
  if (report.files.length && report.files.every((file) => file.status === 'failed')) process.exitCode = 1;
}

export { prepare, verify, finalize, extract, chat, validatePaths, prepareVerificationInput, parseModelArray };
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${String(error.message || error).slice(0, 500)}\n${usage()}\n`); process.exitCode = 1; });
}
