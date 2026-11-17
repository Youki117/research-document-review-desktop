export async function mapConcurrent(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({length:Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index], index);
    }
  });
  // Drain in-flight work even if persistence fails, before the caller exits.
  const settled = await Promise.allSettled(workers);
  const failed = settled.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}

// Bound recovery of timeout/format errors, sequentially, without changing source IDs.
export async function requestWithRecovery(request, stage, prompt, chunk, depth = 0) {
  try { return await request(stage, prompt, chunk); }
  catch (error) {
    const recoverable = ['AbortError', 'TimeoutError'].includes(error.name) || /aborted|timed out|HTTP (408|504)|response must be (?:valid JSON|a JSON array)|response ended before completion/i.test(error.message);
    const field = Array.isArray(chunk.paragraphs) ? 'paragraphs' : 'candidates';
    const items = chunk[field];
    if (!recoverable || depth >= 2 || !Array.isArray(items) || items.length < 2) throw error;
    const weight = item => typeof item.text === 'string' ? item.text.length + 20 : JSON.stringify(item).length;
    const total = items.reduce((n, item) => n + weight(item), 0);
    let size = 0, middle = 0;
    do { size += weight(items[middle++]); } while (middle < items.length - 1 && size < total / 2);
    const left = await requestWithRecovery(request, stage, prompt, {...chunk, [field]: items.slice(0, middle)}, depth + 1);
    const right = await requestWithRecovery(request, stage, prompt, {...chunk, [field]: items.slice(middle)}, depth + 1);
    return [...left, ...right];
  }
}
