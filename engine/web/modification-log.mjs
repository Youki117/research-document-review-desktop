import {appendFile, mkdir} from 'node:fs/promises';
import {join} from 'node:path';

let pending = Promise.resolve();
export async function recordModification(dataDir, job, event, details = {}) {
  const date = new Date();
  const record = {schema_version: 1, timestamp: date.toISOString(), event, job_id: job.id,
    files: job.document_names || [], retry_of: job.retry_of || null, ...details};
  const path = join(dataDir, `修改记录-${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}.jsonl`);
  // Serialize appends across files so concurrent saves never interleave JSON lines.
  const write = pending.then(async () => {
    await mkdir(dataDir, {recursive: true});
    await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
  });
  pending = write.catch(() => {});
  try { await write; return null; }
  catch { return '处理结果已保存，但本地修改日志写入失败，请检查 data 目录的空间和写入权限。'; }
}

export function reviewChanges(previous, next) {
  return next.items.flatMap((item, index) => {
    const before = previous.items[index];
    if (item.decision === before.decision && item.replacement === before.replacement) return [];
    return [{id: item.id, paragraph_id: item.paragraph_id, original: item.original, ai_suggested: item.suggested,
      reason: item.reason, context: item.context,
      before: {decision: before.decision, replacement: before.replacement},
      after: {decision: item.decision, replacement: item.replacement},
      final_text: item.decision === 'reject' ? item.original : item.decision === 'accept' ? item.replacement : null}];
  });
}
