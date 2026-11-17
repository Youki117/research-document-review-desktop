// Static business rules extracted from the recorded FastGPT export. No runtime evaluation.

export const splitSingleFile = (() => {
function stripFastGPTFileWrapper(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const parts = [];
  const contentPattern = /<content>\s*([\s\S]*?)\s*<\/content>/gi;
  let match;
  while ((match = contentPattern.exec(text))) parts.push(match[1].trim());
  if (parts.length) return parts.join('\n\n').trim();
  return text
    .replace(/^\s*File:[^\n]*\n?/gm, '')
    .replace(/<\/?content>/gi, '')
    .trim();
}

function buildOutputFileName(raw) {
  const text = String(raw || '');
  const nameMatch = text.match(/<name>\s*([\s\S]*?)\s*<\/name>/i);
  const fileMatch = text.match(/^\s*File:\s*([^\n]+)$/im);
  let fileName = nameMatch ? nameMatch[1].trim() : (fileMatch ? fileMatch[1].trim() : '文档');
  try { fileName = decodeURIComponent(fileName); } catch {}
  fileName = fileName.replace(/[?#].*$/, '').split(/[\\/]/).pop() || '文档';
  const extensionMatch = fileName.match(/\.(docx|pdf)$/i);
  const extension = extensionMatch ? extensionMatch[0].toLowerCase() : '';
  let baseName = extension ? fileName.slice(0, -extension.length) : fileName;
  baseName = baseName.replace(/_[A-Za-z0-9]{6}$/, '').trim() || '文档';
  return '[标注版]' + baseName + extension;
}

function splitIntoParagraphs(source) {
  const paragraphs = [];
  const pattern = /[^\n]+/g;
  let match;
  let order = 1;
  while ((match = pattern.exec(source))) {
    const text = match[0];
    if (!text.trim()) continue;
    paragraphs.push({
      paragraph_id: 'P' + String(order).padStart(4, '0'),
      order,
      text,
      source_start: match.index,
      source_end: match.index + text.length
    });
    order += 1;
  }
  return paragraphs;
}

function makeChunks(paragraphs, targetSize) {
  const chunks = [];
  let current = [];
  let size = 0;
  function flush() {
    if (!current.length) return;
    chunks.push(JSON.stringify({
      chunk_id: 'K' + String(chunks.length + 1).padStart(3, '0'),
      paragraphs: current.map(function (item) {
        return { paragraph_id: item.paragraph_id, text: item.text };
      })
    }));
    current = [];
    size = 0;
  }
  paragraphs.forEach(function (paragraph) {
    const cost = paragraph.text.length + paragraph.paragraph_id.length + 12;
    if (current.length && size + cost > targetSize) flush();
    current.push(paragraph);
    size += cost;
    if (size >= targetSize) flush();
  });
  flush();
  return chunks;
}

function main({ parsedText, task, targetSize = 4200 }) {
  if (!task || typeof task !== 'object') throw new Error('文件任务无效');
  const sourceText = String(parsedText || '').replace(/\r\n/g, '\n').trim();
  if (!sourceText) throw new Error('文档解析结果为空');
  const paragraphs = splitIntoParagraphs(sourceText);
  if (!paragraphs.length) throw new Error('没有提取到可审查段落');
  const reviewChunks = makeChunks(paragraphs, targetSize);
  return {
    fileContext: {
      file_id: task.file_id,
      file_index: task.file_index,
      file_url: task.file_url,
      original_name: task.original_name,
      extension: task.extension,
      source_text: sourceText,
      paragraphs,
      review_chunks: reviewChunks,
      output_file_name: task.original_name.replace(/(\.[^.]+)$/, '_校对批注$1'),
      paragraph_count: paragraphs.length,
      chunk_count: reviewChunks.length
    }
  };
}
return main;
})();

export const flattenParsedFiles = (() => {
function main({ fileTasks, fullResults }) {
  const tasks = Array.isArray(fileTasks) ? fileTasks : [];
  const results = Array.isArray(fullResults) ? fullResults : [];
  const files = [];
  const chunkTasks = [];
  tasks.forEach(function (task, index) {
    const result = results[index];
    if (!result || !result.success || !result.data) {
      files.push(Object.assign({}, task, { success: false, error: result && result.message ? String(result.message) : '文档解析任务未返回结果' }));
      return;
    }
    const context = result.data;
    files.push(Object.assign({}, context, { success: true, error: '' }));
    context.review_chunks.forEach(function (chunkJson, chunkIndex) {
      chunkTasks.push({
        file_id: context.file_id,
        file_index: context.file_index,
        chunk_index: chunkIndex,
        chunk_json: chunkJson
      });
    });
  });
  return {
    parseState: { files },
    chunkTasks,
    parseSuccessCount: files.filter(function (item) { return item.success; }).length,
    parseFailedCount: files.filter(function (item) { return !item.success; }).length
  };
}
return main;
})();

export const batchMergeChunk = (() => {
function parseArray(value) {
  if (Array.isArray(value)) return value;
  const raw = String(value || '').trim();
  if (!raw) return [];
  const fence = String.fromCharCode(96).repeat(3);
  let cleaned = raw;
  if (cleaned.startsWith(fence)) cleaned = cleaned.slice(3).replace(/^json\s*/i, '').trim();
  if (cleaned.endsWith(fence)) cleaned = cleaned.slice(0, -3).trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {}
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch {}
  }
  return [];
}

function main({ surfaceJson, languageJson }) {
  const surface = parseArray(surfaceJson).map(function (item) {
    return Object.assign({}, item, { discovery_pass: 'surface' });
  });
  const language = parseArray(languageJson).map(function (item) {
    return Object.assign({}, item, { discovery_pass: 'language' });
  });
  return { combinedJson: JSON.stringify(surface.concat(language)) };
}
return main;
})();

export const buildReviewState = (() => {
function parseValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  const raw = String(value).trim();
  if (!raw) return null;
  const fence = String.fromCharCode(96).repeat(3);
  let cleaned = raw;
  if (cleaned.startsWith(fence)) cleaned = cleaned.slice(3).replace(/^json\s*/i, '').trim();
  if (cleaned.endsWith(fence)) cleaned = cleaned.slice(0, -3).trim();
  try { return JSON.parse(cleaned); } catch {}
  const a = cleaned.indexOf('[');
  const b = cleaned.lastIndexOf(']');
  if (a >= 0 && b > a) {
    try { return JSON.parse(cleaned.slice(a, b + 1)); } catch {}
  }
  return null;
}

function occurrenceOffsets(text, needle) {
  const result = [];
  if (!needle) return result;
  let index = 0;
  while ((index = text.indexOf(needle, index)) >= 0) {
    result.push(index);
    index += Math.max(1, needle.length);
  }
  return result;
}

function addRuleMatches(paragraph, target, regex, replacement, reason, category, occupied) {
  let match;
  regex.lastIndex = 0;
  while ((match = regex.exec(paragraph.text))) {
    const wrong = match[0];
    const suggested = typeof replacement === 'function' ? replacement(match) : replacement;
    const start = match.index;
    const end = start + wrong.length;
    if (!occupied.some(function (range) { return start < range.end && end > range.start; })) {
      target.push({
        paragraph_id: paragraph.paragraph_id,
        wrong_text: wrong,
        suggested_text: suggested,
        reason,
        category,
        occurrence_index: occurrenceOffsets(paragraph.text, wrong).indexOf(start) + 1,
        discovery_pass: 'rule'
      });
      occupied.push({ start, end });
    }
    if (!regex.global) break;
    if (regex.lastIndex === match.index) regex.lastIndex += 1;
  }
}

function makeRuleCandidates(paragraphs) {
  const result = [];
  paragraphs.forEach(function (paragraph) {
    const occupied = [];
    addRuleMatches(paragraph, result, /(?:表|图|附件)\s*\d+\s*[-－]\s+\d+/g, function (m) { return m[0].replace(/\s*([-－])\s+/g, '$1'); }, '图表或附件编号的连字符内不应夹入空格', '空格重复', occupied);
    addRuleMatches(paragraph, result, /(\d+(?:\.\d+)?)oC\s*\+\s*(\d+(?:\.\d+)?)oC/g, function (m) { return m[1] + '°C ± ' + m[2] + '°C'; }, '温度符号应完整写为 °C 和 ±', '单位符号', occupied);
    addRuleMatches(paragraph, result, /(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)oC/g, function (m) { return m[1] + '±' + m[2] + '°C'; }, '温度符号应完整写为 °C 和 ±', '单位符号', occupied);
    addRuleMatches(paragraph, result, /(\d+(?:\.\d+)?)~(\d+(?:\.\d+)?)oC/g, function (m) { return m[1] + '-' + m[2] + '°C'; }, '温度范围符号和摄氏度符号应统一', '单位符号', occupied);
    addRuleMatches(paragraph, result, /(\d+(?:\.\d+)?)oC\b/g, function (m) { return m[1] + '°C'; }, '摄氏度符号误写为字母 o', '单位符号', occupied);
    addRuleMatches(paragraph, result, /(\d+(?:\.\d+)?)~(\d+(?:\.\d+)?)(?=\s*(?:hours?|days?|minutes?|min)\b)/gi, function (m) { return m[1] + '-' + m[2]; }, '数值范围分隔符应统一为连字符', '单位符号', occupied);
    addRuleMatches(paragraph, result, /\b1 hours\b/gi, function (m) { return /^1 Hours$/.test(m[0]) ? '1 Hour' : '1 hour'; }, '数值 1 后应使用单数 hour', '明显语法', occupied);
    addRuleMatches(paragraph, result, /\bstandard for(?=\s+\d+\s*(?:min|minutes?|hours?))/gi, function (m) { return /^[A-Z]/.test(m[0]) ? 'Stand for' : 'stand for'; }, '此处需要动词 stand 表示静置', '误输入', occupied);
    addRuleMatches(paragraph, result, /\bnature light\b/gi, 'natural light', '固定搭配应为 natural light', '明显语法', occupied);
    addRuleMatches(paragraph, result, /\bg o f\b/g, 'g of', 'of 被多余空格拆开', 'OCR错误', occupied);
    addRuleMatches(paragraph, result, /\bmix well Accurately\b/g, 'mix well. Accurately', '两个句子之间缺少句点', '标点格式', occupied);
    addRuleMatches(paragraph, result, /\bIdentification(\d+)\b/g, function (m) { return 'Identification ' + m[1]; }, '标题与编号之间缺少空格', '大小写编号', occupied);
    addRuleMatches(paragraph, result, /\bdarker that that\b/gi, 'darker than that', '比较级应使用 than', '明显语法', occupied);
    addRuleMatches(paragraph, result, /\bAll the reaction\b/g, 'Allow the reaction', '此处需要动词 Allow', '明显语法', occupied);
    addRuleMatches(paragraph, result, /\brefence\b/gi, 'reference', 'reference 拼写错误', '拼写错误', occupied);
    addRuleMatches(paragraph, result, /\bcorrector factor\b/gi, 'correction factor', '固定术语应为 correction factor', '术语不一致', occupied);
    addRuleMatches(paragraph, result, /\bTemperate program\b/g, 'Temperature program', 'temperature 拼写不完整', '拼写错误', occupied);
    addRuleMatches(paragraph, result, /\bzine granules\b/gi, 'zinc granules', 'zinc 拼写错误', '拼写错误', occupied);
    addRuleMatches(paragraph, result, /\bhead slowly\b/gi, 'heat slowly', '上下文需要动词 heat', '误输入', occupied);
    addRuleMatches(paragraph, result, /\bmacconkey(?=\s+(?:agar|broth)\b)/g, 'MacConkey', '专名 MacConkey 首字母应大写', '大小写编号', occupied);
    addRuleMatches(paragraph, result, /\bflaks\b/gi, 'flasks', 'flasks 拼写错误', '拼写错误', occupied);
    addRuleMatches(paragraph, result, /\bfilter member\b/gi, 'filter membrane', '与过滤膜语境不一致，交由复核确认', '术语不一致', occupied);
    addRuleMatches(paragraph, result, /\b4\.6 m(?=\s*x\s*150 mm)/g, '4.6 mm', '色谱柱内径单位应为 mm', '单位符号', occupied);
    if (/transfer|weigh|weighed/i.test(paragraph.text)) {
      addRuleMatches(paragraph, result, /\b(\d+(?:\.\d+)?)\s+mf\b/gi, function (m) { return m[1] + ' mg'; }, '称量单位 mg 被误写为 mf', 'OCR错误', occupied);
    }
  });
  return result;
}

function buildCandidatesForFile({ paragraphMapJson, discoveryResults }) {
  const paragraphs = parseValue(paragraphMapJson) || [];
  const paragraphMap = new Map(paragraphs.map(function (item) { return [item.paragraph_id, item]; }));
  const rawLoop = Array.isArray(discoveryResults) ? discoveryResults : [];
  const rawCandidates = [];
  rawLoop.forEach(function (entry) {
    const parsed = parseValue(entry);
    if (Array.isArray(parsed)) rawCandidates.push.apply(rawCandidates, parsed);
  });
  rawCandidates.push.apply(rawCandidates, makeRuleCandidates(paragraphs));

  const candidates = [];
  const seen = new Set();
  let invalidDiscoveryCount = 0;

  rawCandidates.forEach(function (raw) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const paragraphId = String(item.paragraph_id || '').trim();
    const paragraph = paragraphMap.get(paragraphId);
    const wrongText = String(item.wrong_text || '');
    const suggestedText = String(item.suggested_text || '');
    const offsets = paragraph ? occurrenceOffsets(paragraph.text, wrongText) : [];
    let occurrenceIndex = Number(item.occurrence_index || 1);
    if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 1) occurrenceIndex = 1;
    if (!paragraph || !wrongText.trim() || !suggestedText.trim() || wrongText === suggestedText || occurrenceIndex > offsets.length) {
      invalidDiscoveryCount += 1;
      return;
    }
    const offset = offsets[occurrenceIndex - 1];
    const key = [paragraphId, offset, wrongText, suggestedText].join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      candidate_id: '',
      paragraph_id: paragraphId,
      paragraph_text: paragraph.text,
      wrong_text: wrongText,
      suggested_text: suggestedText,
      reason: String(item.reason || '').trim(),
      category: String(item.category || '').trim(),
      occurrence_index: occurrenceIndex,
      original_offset: offset,
      discovery_pass: String(item.discovery_pass || 'ai')
    });
  });

  candidates.sort(function (a, b) {
    const pa = paragraphMap.get(a.paragraph_id);
    const pb = paragraphMap.get(b.paragraph_id);
    return pa.order - pb.order || a.original_offset - b.original_offset || a.suggested_text.localeCompare(b.suggested_text);
  });
  candidates.forEach(function (item, index) {
    item.candidate_id = 'C' + String(index + 1).padStart(3, '0');
  });

  const verificationBatches = [];
  for (let index = 0; index < candidates.length; index += 10) {
    verificationBatches.push(JSON.stringify({
      batch_id: 'B' + String(verificationBatches.length + 1).padStart(3, '0'),
      candidates: candidates.slice(index, index + 10).map(function (item) {
        return {
          candidate_id: item.candidate_id,
          paragraph_id: item.paragraph_id,
          paragraph_text: item.paragraph_text,
          wrong_text: item.wrong_text,
          suggested_text: item.suggested_text,
          reason: item.reason,
          category: item.category,
          occurrence_index: item.occurrence_index
        };
      })
    }));
  }

  return {
    candidatesJson: JSON.stringify(candidates),
    verificationBatches,
    candidateCount: candidates.length,
    invalidDiscoveryCount
  };
}
function main({ parseState, chunkTasks, discoveryFullResults }) {
  const state = parseState && typeof parseState === 'object' ? parseState : { files: [] };
  const files = Array.isArray(state.files) ? state.files.map(function (item) { return Object.assign({}, item); }) : [];
  const tasks = Array.isArray(chunkTasks) ? chunkTasks : [];
  const results = Array.isArray(discoveryFullResults) ? discoveryFullResults : [];
  const discoveries = new Map();
  const failedFiles = new Map();

  tasks.forEach(function (task, index) {
    const result = results[index];
    if (!result || !result.success) {
      failedFiles.set(task.file_id, result && result.message ? String(result.message) : '分块检查任务未返回结果');
      return;
    }
    if (!discoveries.has(task.file_id)) discoveries.set(task.file_id, []);
    discoveries.get(task.file_id).push(result.data);
  });

  const verificationTasks = [];
  files.forEach(function (file) {
    if (!file.success || file.error) return;
    if (failedFiles.has(file.file_id)) {
      file.success = false;
      file.error = '存在分块检查失败：' + failedFiles.get(file.file_id);
      return;
    }
    const built = buildCandidatesForFile({
      paragraphMapJson: JSON.stringify(file.paragraphs || []),
      discoveryResults: discoveries.get(file.file_id) || []
    });
    file.candidates = JSON.parse(built.candidatesJson || '[]');
    file.candidate_count = Number(built.candidateCount || 0);
    file.invalid_discovery_count = Number(built.invalidDiscoveryCount || 0);
    built.verificationBatches.forEach(function (batchJson, batchIndex) {
      verificationTasks.push({
        file_id: file.file_id,
        file_index: file.file_index,
        batch_index: batchIndex,
        batch_json: batchJson
      });
    });
  });

  return { reviewState: { files }, verificationTasks };
}
return main;
})();

export const buildAnnotationState = (() => {
function parseValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  const raw = String(value).trim();
  if (!raw) return null;
  const fence = String.fromCharCode(96).repeat(3);
  let cleaned = raw;
  if (cleaned.startsWith(fence)) cleaned = cleaned.slice(3).replace(/^json\s*/i, '').trim();
  if (cleaned.endsWith(fence)) cleaned = cleaned.slice(0, -3).trim();
  try { return JSON.parse(cleaned); } catch {}
  const a = cleaned.indexOf('[');
  const b = cleaned.lastIndexOf(']');
  if (a >= 0 && b > a) {
    try { return JSON.parse(cleaned.slice(a, b + 1)); } catch {}
  }
  return null;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) >= 0) {
    count += 1;
    index += Math.max(1, needle.length);
  }
  return count;
}

function occurrenceOffsets(text, needle) {
  const result = [];
  if (!needle) return result;
  let index = 0;
  while ((index = text.indexOf(needle, index)) >= 0) {
    result.push(index);
    index += Math.max(1, needle.length);
  }
  return result;
}

function normalizeFullWidthDigits(value) {
  return String(value || '').replace(/[０-９]/g, function (char) {
    return String(char.charCodeAt(0) - 0xFF10);
  });
}

function isUnarySign(text, signIndex) {
  let index = signIndex - 1;
  while (index >= 0 && /\s/.test(text[index])) index -= 1;
  if (index < 0) return true;
  return /[\(\[\{=:;,<>]/.test(text[index]);
}

function numberTokens(value) {
  const text = normalizeFullWidthDigits(value);
  const pattern = /\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?/g;
  const tokens = [];
  let match;

  while ((match = pattern.exec(text))) {
    let token = match[0];
    let signIndex = match.index - 1;
    while (signIndex >= 0 && /\s/.test(text[signIndex])) signIndex -= 1;
    const sign = text[signIndex];
    if ((sign === '-' || sign === '−' || sign === '+') && isUnarySign(text, signIndex)) {
      token = (sign === '−' ? '-' : sign) + token;
    }
    tokens.push(token);
  }

  return tokens;
}

function sameNumbers(before, after) {
  return JSON.stringify(numberTokens(before)) === JSON.stringify(numberTokens(after));
}

function getReviewDecision(item) {
  const value = String((item && item.decision) || '').trim().toLowerCase();
  if (value === 'accept' || value === 'reject') return value;
  return 'invalid';
}

function punctuationSpacingCount(value) {
  return (String(value || '').match(/\s+[.,;:!?]/g) || []).length;
}

function appearsExactlyOnce(text, needle) {
  if (!needle) return false;
  const first = text.indexOf(needle);
  if (first < 0) return false;
  return text.indexOf(needle, first + Math.max(1, needle.length)) < 0;
}

function safeContext(source, paragraph, offset, wrongText) {
  const radii = [60, 120, 240, 480, paragraph.text.length];
  for (const radius of radii) {
    const left = Math.max(0, offset - radius);
    const right = Math.min(paragraph.text.length, offset + wrongText.length + radius);
    const context = paragraph.text.slice(left, right);
    if (appearsExactlyOnce(context, wrongText) && appearsExactlyOnce(source, context)) return context;
  }
  return '';
}

function buildOneFile({ sourceText, paragraphMapJson, candidatesJson, verificationResults }) {
  const source = String(sourceText || '');
  const paragraphs = parseValue(paragraphMapJson) || [];
  const paragraphMap = new Map(paragraphs.map(function (item) { return [item.paragraph_id, item]; }));
  const candidates = parseValue(candidatesJson) || [];
  const decisions = new Map();
  const rawResults = Array.isArray(verificationResults) ? verificationResults : [];
  rawResults.forEach(function (entry) {
    const batch = parseValue(entry);
    if (!Array.isArray(batch)) return;
    batch.forEach(function (item) {
      if (item && item.candidate_id && !decisions.has(String(item.candidate_id))) {
        decisions.set(String(item.candidate_id), item);
      }
    });
  });

  const accepted = [];
  const acceptedIssues = [];
  const validationRejected = [];
  candidates.forEach(function (candidate) {
    const decision = decisions.get(candidate.candidate_id);
    if (!decision) return;
    const reviewDecision = getReviewDecision(decision);
    if (reviewDecision === 'reject') return;
    if (reviewDecision === 'invalid') {
      validationRejected.push({ candidate_id: candidate.candidate_id, reason: '复核结果缺少有效的 accept/reject 决定' });
      return;
    }
    accepted.push(candidate.candidate_id);
    const paragraph = paragraphMap.get(candidate.paragraph_id);
    const wrongText = String(decision.wrong_text || candidate.wrong_text || '');
    const suggestedText = String(decision.suggested_text || candidate.suggested_text || '').replace(/((?:表|图|附件)\s*\d+)\s*([-－])\s+(\d+)/g, '$1$2$3');
    let occurrenceIndex = Number(decision.occurrence_index || candidate.occurrence_index || 1);
    if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 1) occurrenceIndex = 1;
    const reject = function (reason) {
      validationRejected.push({ candidate_id: candidate.candidate_id, reason });
    };

    if (!paragraph) return reject('段落编号不存在');
    if (!wrongText.trim() || !suggestedText.trim() || wrongText === suggestedText) return reject('修订内容为空或没有变化');
    const offsets = occurrenceOffsets(paragraph.text, wrongText);
    if (occurrenceIndex > offsets.length) return reject('最终 wrong_text 无法在段落中按序定位');
    if (!sameNumbers(wrongText, suggestedText)) return reject('修改改变了原文数字');
    if (/\bto\s+(?:mL|mg|g|L|°C)\b/i.test(wrongText)) return reject('原文缺失具体数值，禁止猜测修复');

    const offset = offsets[occurrenceIndex - 1];
    const revised = paragraph.text.slice(0, offset) + suggestedText + paragraph.text.slice(offset + wrongText.length);
    if (punctuationSpacingCount(revised) > punctuationSpacingCount(paragraph.text)) return reject('替换后新增了标点前空格');
    const context = safeContext(source, paragraph, offset, wrongText);
    if (!context) return reject('无法生成全文唯一且单目标的定位上下文');
    const globalStart = paragraph.source_start + offset;
    acceptedIssues.push({
      candidate_id: candidate.candidate_id,
      paragraph_id: candidate.paragraph_id,
      global_start: globalStart,
      global_end: globalStart + wrongText.length,
      source_text: context,
      wrong_text: wrongText,
      suggested_text: suggestedText,
      reason: String(decision.reason || candidate.reason || '').trim(),
      apply_scope: 'single'
    });
  });

  acceptedIssues.sort(function (a, b) { return a.global_start - b.global_start || b.global_end - a.global_end; });
  // Broad suggestions may share unchanged context while fixing different words.
  const overlapping = new Set();
  for (let i = 0; i < acceptedIssues.length; i++) {
    for (let j = i + 1; j < acceptedIssues.length && acceptedIssues[j].global_start < acceptedIssues[i].global_end; j++) {
      overlapping.add(acceptedIssues[i]); overlapping.add(acceptedIssues[j]);
    }
  }
  for (const item of overlapping) {
    const before = Array.from(item.wrong_text), after = Array.from(item.suggested_text);
    let left = 0, right = 0;
    while (left < Math.min(before.length, after.length) && before[left] === after[left]) left++;
    while (right < Math.min(before.length, after.length) - left && before[before.length - 1 - right] === after[after.length - 1 - right]) right++;
    if (left + right >= Math.min(before.length, after.length)) { if (left) left--; else if (right) right--; }
    item.global_start += before.slice(0, left).join('').length;
    item.wrong_text = before.slice(left, before.length - right).join('');
    item.suggested_text = after.slice(left, after.length - right).join('');
    item.global_end = item.global_start + item.wrong_text.length;
    const paragraph = paragraphMap.get(item.paragraph_id);
    item.source_text = safeContext(source, paragraph, item.global_start - paragraph.source_start, item.wrong_text);
  }
  acceptedIssues.sort(function (a, b) { return a.global_start - b.global_start || b.global_end - a.global_end; });
  const issues = [];
  let previousEnd = -1;
  acceptedIssues.forEach(function (item) {
    if (!item.source_text) { validationRejected.push({candidate_id:item.candidate_id, reason:'缩小修订后无法唯一定位'}); return; }
    const previous = issues[issues.length - 1];
    if (previous && item.global_start === previous._start && item.global_end === previousEnd && item.suggested_text === previous.suggested_text) return;
    if (item.global_start < previousEnd) {
      validationRejected.push({ candidate_id: item.candidate_id, reason: '与另一项修订范围重叠' });
      return;
    }
    previousEnd = item.global_end;
    issues.push({
      source_text: item.source_text,
      wrong_text: item.wrong_text,
      suggested_text: item.suggested_text,
      reason: item.reason,
      apply_scope: item.apply_scope,
      _start:item.global_start
    });
  });
  issues.forEach(function (item) { delete item._start; });

  return {
    issuesJson: JSON.stringify(issues),
    candidateCount: candidates.length,
    reviewerAcceptedCount: accepted.length,
    verifiedIssueCount: issues.length,
    validationRejectedCount: validationRejected.length,
    rejectedCount: Math.max(0, candidates.length - issues.length),
    validationRejectedJson: JSON.stringify(validationRejected)
  };
}
function main({ reviewState, verificationTasks, verificationFullResults }) {
  const state = reviewState && typeof reviewState === 'object' ? reviewState : { files: [] };
  const files = Array.isArray(state.files) ? state.files.map(function (item) { return Object.assign({}, item); }) : [];
  const tasks = Array.isArray(verificationTasks) ? verificationTasks : [];
  const results = Array.isArray(verificationFullResults) ? verificationFullResults : [];
  const decisions = new Map();
  const failedFiles = new Map();

  tasks.forEach(function (task, index) {
    const result = results[index];
    if (!result || !result.success) {
      failedFiles.set(task.file_id, result && result.message ? String(result.message) : '复核任务未返回结果');
      return;
    }
    if (!decisions.has(task.file_id)) decisions.set(task.file_id, []);
    decisions.get(task.file_id).push(result.data);
  });

  const annotationTasks = [];
  files.forEach(function (file) {
    if (!file.success || file.error) return;
    if (failedFiles.has(file.file_id)) {
      file.success = false;
      file.error = '存在候选复核失败：' + failedFiles.get(file.file_id);
      return;
    }
    const built = buildOneFile({
      sourceText: file.source_text,
      paragraphMapJson: JSON.stringify(file.paragraphs || []),
      candidatesJson: JSON.stringify(file.candidates || []),
      verificationResults: decisions.get(file.file_id) || []
    });
    file.candidate_count = Number(built.candidateCount || 0);
    file.reviewer_accepted_count = Number(built.reviewerAcceptedCount || 0);
    file.verified_issue_count = Number(built.verifiedIssueCount || 0);
    file.validation_rejected_count = Number(built.validationRejectedCount || 0);
    file.validation_rejections = JSON.parse(built.validationRejectedJson || "[]");
    annotationTasks.push({
      file_id: file.file_id,
      file_index: file.file_index,
      file_url: file.file_url,
      original_name: file.original_name,
      output_file_name: file.output_file_name,
      issues_json: built.issuesJson
    });
  });

  return { annotationState: { files }, annotationTasks };
}
return main;
})();
