const $ = selector => document.querySelector(selector);
const statuses = {queued: '排队中', running: '审查中', completed: 'AI审查完成', failed: '失败', interrupted: '已中断'};
const stages = {discovery: '发现问题', verification: '独立复核', annotation: '生成标注', complete: '处理结束'};
let config, jobs = [], pending = [], selected = '', selectedVersion = '', submitting = false, refreshing = false, poll;
let preview = null, report = '', previewError = '', loadSequence = 0;
let review = null, reviewDirty = false, reviewSaving = false;
let currentEditId = '', saveTimer, changeVersion = 0, savingPromise = null, exclusiveWrite = false;
let guardGeneration = null, guardSequence = 0;
async function syncWindowGuard() {
  if (guardGeneration !== null) await window.pywebview.api.update_review_state(guardGeneration, ++guardSequence, reviewDirty, reviewSaving);
}
window.addEventListener('pywebviewready', async () => {
  guardGeneration = await window.pywebview.api.begin_page();
  await syncWindowGuard();
  try {
    const update=await window.pywebview.api.check_updates();
    if(update.available){$('#update-text').textContent=`有新版本 ${update.version}`;$('#update-banner').hidden=false;}
  } catch { /* Update checks never block reviewing documents. */ }
});

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
async function api(path, options = {}) {
  const response = await fetch(path, {...options, headers: {...options.headers, ...(options.method === 'POST' ? {'X-Review-Client': 'packaging-review'} : {})}});
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try { message = (await response.json()).error || message; } catch { /* Non-JSON errors retain their HTTP status. */ }
    throw new Error(message);
  }
  return response;
}
function message(text, error = false) {
  $('#import-message').textContent = text;
  $('#import-message').hidden = !text;
  $('#import-message').classList.toggle('error', error);
}
function pane(name) {
  $('.workbench').dataset.pane = name;
  document.querySelectorAll('.compact-nav button').forEach(button => button.setAttribute('aria-current', button.dataset.pane === name ? 'page' : 'false'));
}
function controls() {
  $('#submit').disabled = submitting || !pending.length || !config?.tools?.xiasha?.ready;
  $('#submit').textContent = submitting ? '正在加入队列…' : '加入审查队列';
  for (const id of ['pick-files', 'pick-folder', 'batch-name']) $(`#${id}`).disabled = submitting;
  $('#clear-pending').disabled = submitting || !pending.length;
}
function renderPending() {
  $('#pending-count').textContent = `${pending.length} 份`;
  $('#pending-empty').hidden = pending.length > 0;
  $('#pending-list').replaceChildren();
  for (const entry of pending) {
    const row = element('li');
    const label = element('span', entry.file.name);
    label.dataset.help = `${entry.path} · ${(entry.file.size / 1024 / 1024).toFixed(2)} MiB`;
    const remove = element('button', '移除');
    remove.type = 'button'; remove.disabled = submitting; remove.setAttribute('aria-label', `移除 ${entry.path}`);
    remove.addEventListener('click', () => { pending = pending.filter(item => item !== entry); renderPending(); });
    row.append(label, remove); $('#pending-list').append(row);
  }
  controls();
}
function addFiles(files, directory = false) {
  if (submitting) return;
  const skipped = [];
  const limit = config?.limits?.file_bytes || 50 * 1024 * 1024;
  const keys = new Set(pending.map(item => item.key));
  const sorted = [...files].sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, 'zh-CN', {numeric: true}));
  for (const file of sorted) {
    const path = file.webkitRelativePath || file.name;
    const key = `${path}|${file.size}|${file.lastModified}`;
    let reason = '';
    if (file.name.startsWith('~$')) reason = 'Office 临时文件';
    else if (!/\.(docx|pdf)$/i.test(file.name)) reason = '格式不支持';
    else if (!file.size || file.size > limit) reason = '文件为空或超过 50 MiB';
    else if (keys.has(key)) reason = '已在待提交清单中';
    else if (pending.length >= 200) reason = '超过每批 200 份上限';
    if (reason) { skipped.push(`${path}：${reason}`); continue; }
    pending.push({file, path, key}); keys.add(key);
  }
  if (directory && files.length && !$('#batch-name').value) $('#batch-name').value = (files[0].webkitRelativePath || '').split('/')[0].slice(0, 120);
  $('#skipped').hidden = !skipped.length;
  $('#skipped-summary').textContent = `${skipped.length} 份文件未加入`;
  $('#skipped-list').replaceChildren(...skipped.map(text => element('li', text)));
  message(''); renderPending();
}
async function loadConfig() {
  try {
    config = await (await api('/api/config')).json();
    const ready = config.tools.xiasha.ready;
    $('#connection').textContent = ready ? '模型已配置' : '模型未配置';
    $('#connection').dataset.help = ready ? '文档会发送到本机配置的模型接口。' : '请通过窗口菜单“工具 → 模型设置”配置文本模型。';
  } catch (error) { config = null; $('#connection').textContent = `连接失败：${error.message}`; }
  controls();
}
function status(job) {
  return statuses[job.status] || '未知状态';
}
function progressDetail(job) {
  if (job.stage === 'verification' && job.total_verification_batches) return `独立复核 · ${job.completed_verification_batches} / ${job.total_verification_batches} 批`;
  return `${stages[job.stage] || '正在处理'}${job.total_chunks ? ` · ${job.completed_stages} / ${job.total_chunks} 分块` : ''}`;
}
function renderJobs() {
  const active = jobs.filter(job => ['queued', 'running'].includes(job.status)).length;
  const done = jobs.filter(job => job.status === 'completed').length;
  const problems = jobs.length - active - done;
  $('#queue-counts').textContent = `${jobs.length} 份文件`;
  $('#queue-counts').dataset.help = `未完成 ${active} · 已完成 ${done} · 异常 ${problems}。退出会中断未完成任务，重启保留记录。`;
  const search = $('#search').value.trim().toLocaleLowerCase();
  const filter = $('#filter').value;
  const visible = jobs.filter(job => {
    const matches = `${job.batch_name || ''} ${job.source_path || ''} ${job.document_names?.join(' ') || ''}`.toLocaleLowerCase().includes(search);
    return matches && (filter === 'all' || filter === 'active' && ['queued', 'running'].includes(job.status) || filter === 'completed' && job.status === 'completed' || filter === 'problem' && ['failed', 'interrupted'].includes(job.status));
  });
  $('#queue-message').hidden = visible.length > 0;
  $('#queue-message').textContent = jobs.length ? '没有符合条件的任务' : '还没有任务，添加文件后开始审查。';
  const target = $('#job-list'), scrollTop = target.scrollTop;
  const version = JSON.stringify([selected, visible.map(job => [job.id, job.status, job.result_status, job.approval_status, job.error])]);
  if (version !== target.dataset.version) {
  const focusedId = target.contains(document.activeElement) ? document.activeElement.dataset.job : null;
  target.replaceChildren();
  for (const job of visible) {
    const row = element('button', undefined, `job${job.id === selected ? ' selected' : ''}`);
    row.type = 'button'; row.dataset.job = job.id; row.setAttribute('aria-current', job.id === selected ? 'true' : 'false');
    const name = job.document_names?.join('、') || job.source_path?.split('/').at(-1) || '文档';
    row.append(element('span', name, 'job-name'), element('span', status(job), `job-status ${job.status}`));
    row.dataset.help = job.error || name;
    row.addEventListener('click', () => selectJob(job.id)); target.append(row);
    if (focusedId === job.id) row.focus({preventScroll: true});
  }
  target.scrollTop = scrollTop;
  target.dataset.version = version;
  }
  for (const row of target.children) {
    const job = visible.find(item => item.id === row.dataset.job);
    if (job?.status === 'running') row.dataset.help = `${job.source_path || job.document_names.join('、')}\n${progressDetail(job)}`;
  }
  if ((active || submitting) && !poll) poll = setInterval(refreshJobs, 2500);
  if (!active && !submitting && poll) { clearInterval(poll); poll = null; }
}
async function refreshJobs() {
  if (refreshing) return;
  refreshing = true;
  try {
    jobs = await (await api('/api/jobs')).json();
    renderJobs();
    if (!selected && jobs.length) await selectJob((jobs.find(job => job.status === 'completed') || jobs[0]).id);
    else if (selected) {
      const job = jobs.find(item => item.id === selected);
      if (job?.status === 'running') $('#document-info').dataset.help = `${status(job)} · ${progressDetail(job)}`;
      if (job && `${job.id}:${job.updated_at}:${job.status}` !== selectedVersion) await selectJob(job.id);
    }
  } catch (error) { $('#queue-message').hidden = false; $('#queue-message').textContent = `读取失败：${error.message}`; }
  finally { refreshing = false; }
}
function showState(title, detail, error = false) {
  $('#viewer-state').replaceChildren(element('h3', title), element('p', detail));
  $('#viewer-state').hidden = false; $('#viewer-state').classList.toggle('error', error);
}
function showDocument() {
  $('#document-view').hidden = !preview;
  if (preview) $('#viewer-state').hidden = true;
  else if (previewError) showState('正文预览暂不可用', previewError, true);
}
function paragraphText(paragraph) {
  const node = element('p', undefined, 'paragraph-text');
  const format = preview?.layout?.formats[paragraph.id];
  Object.assign(node.style,format?.style || {});
  const styles = format?.run_styles || [];
  let offset = 0;
  function appendStyled(mark,text,start) {
    let cursor = 0, consumed = 0;
    for (const part of styles) {
      const end = cursor + part.text.length;
      const left = Math.max(start,cursor), right = Math.min(start + text.length,end);
      if(right > left) {
        const span = element('span',text.slice(left-start,right-start));Object.assign(span.style,part.style);mark.append(span);consumed += right-left;
      }
      cursor = end;
    }
    if(consumed < text.length)mark.append(document.createTextNode(text.slice(consumed)));
  }
  for (const run of paragraph.runs) {
    const start = offset;offset += run.text.length;
    const decision = review?.supported && run.revision_id !== undefined ? review.items.find(item => item.deletion_id === run.revision_id || item.insertion_id === run.revision_id) : null;
    if(decision?.decision==='accept'&&run.kind==='deletion'||decision?.decision==='reject'&&run.kind==='insertion')continue;
    const tag=decision?.decision!=='pending'&&decision ? 'span' : run.kind==='deletion'?'del':run.kind==='insertion'?'ins':'span';
    const mark=element(tag);
    const text=decision?.decision==='accept'?decision.replacement:run.text;
    if(text===run.text)appendStyled(mark,text,start);else {Object.assign(mark.style,styles.find(s=>s.text===run.text)?.style||{});mark.textContent=text;}
    if(decision) {
      mark.dataset.issueId=decision.id;mark.className=`revision ${decision.decision}`;mark.tabIndex=0;mark.setAttribute('role','button');mark.setAttribute('aria-label',`修改：${decision.original}`);
    }
    node.append(mark);
  }
  for(const image of format?.images||[]) {const img=element('img');img.src=preview.layout.images[image.source];img.alt='文档插图';img.width=image.width;img.height=image.height;img.loading='lazy';node.append(img);}
  return node;
}
function renderBody(data) {
  const body = $('#document-body'); body.replaceChildren();
  body.style.maxWidth=data.layout?`${data.layout.page_width_pt}pt`:'';
  const seen=new Set(),paragraphs=new Map(data.paragraphs.map(p=>[p.id,p]));
  function appendBlocks(blocks,parent) {
    for(const block of blocks) {
      if(block.type==='paragraph') {
        const paragraph=paragraphs.get(block.id);if(!paragraph||seen.has(block.id))continue;seen.add(block.id);
        const row=element('div',undefined,'paragraph-row');row.id=paragraph.id;
        if(paragraph.label)row.append(element('small',paragraph.label));row.append(paragraphText(paragraph));parent.append(row);
      }else if(block.type==='table') {
        const table=element('table',undefined,'document-table'),tbody=element('tbody');
        for(const cells of block.rows) {
          const tr=element('tr');for(const cell of cells) {
            if(cell.type==='continuation')continue;
            const td=element('td');td.colSpan=cell.colspan;td.rowSpan=cell.rowspan;appendBlocks(cell.blocks,td);tr.append(td);
          }tbody.append(tr);
        }
        table.append(tbody);const wrap=element('div',undefined,'table-scroll');wrap.append(table);parent.append(wrap);
      }
    }
  }
  appendBlocks(data.layout?.blocks||data.paragraphs.map(p=>({type:'paragraph',id:p.id})),body);
  appendBlocks(data.paragraphs.filter(p=>!seen.has(p.id)).map(p=>({type:'paragraph',id:p.id})),body);
}
function renderPreview(data) {
  renderBody(data);
  const note = data.format === '.docx' ? '点击标注可修改，勾选后自动定位下一处。预览保留表格、图片和主要样式，精确分页以导出文件为准。' : 'PDF 可预览和下载批注副本，修正文档导出支持 DOCX。';
  $('#document-info').dataset.help = `${$('#document-info').dataset.help.split('\n')[0]}\n${data.annotated} 处标注。${note}`;
  if (data.unmatched.length) reviewMessage(`${data.unmatched.length} 条建议未写入，详情见报告。`, true);
}
function reviewMessage(text, error = false) {
  $('#review-message').textContent = text; $('#review-message').hidden = !text; $('#review-message').classList.toggle('error', error);
}
function reviewControls() {
  document.body.dataset.unsavedReview = String(reviewDirty || reviewSaving);
  document.body.dataset.savingReview = String(reviewSaving);
  syncWindowGuard().catch(() => console.warn('窗口状态同步失败，退出前请保存审批记录。'));
  if (!review?.supported) {
    for (const id of ['next-review', 'approve-review', 'reload-review']) $(`#${id}`).hidden = true;
    return;
  }
  for (const id of ['next-review', 'approve-review', 'reload-review']) $(`#${id}`).hidden = false;
  const locked = review.status === 'approved';
  const pendingCount = review.items.filter(item => item.decision === 'pending').length;
  $('#review-state').textContent = `${review.items.length - pendingCount} / ${review.items.length} 已确认${reviewSaving?' · 保存中':reviewDirty?' · 待保存':' · 已保存'}`;
  $('#approve-review').dataset.help = pendingCount ? `还有 ${pendingCount} 处待确认` : '导出无 AI 批注和修订痕迹的修正文档';
  $('#approve-review').disabled = reviewSaving;
  $('#next-review').hidden = !review.items.length;
  $('#next-review').textContent = pendingCount ? '定位待确认项' : '继续修改';
  $('#next-review').disabled=exclusiveWrite;$('#replacement').disabled=exclusiveWrite;$('#confirm-edit').disabled=exclusiveWrite;
  $('#reviewer').disabled = locked || exclusiveWrite; $('#review-note').disabled = locked || exclusiveWrite;
  $('#reload-review').disabled = reviewSaving;
}
function dirtyReview() {
  reviewDirty = true;changeVersion++;reviewMessage('');reviewControls();
  clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveReview('save'),700);
}
function renderReview() {
  $('#approval-panel').hidden = false;
  $('#review-fields').hidden = !review?.supported;

  if (!review?.supported) { $('#review-state').textContent = '仅预览'; $('#review-state').dataset.help = review?.message || '修改记录未能载入'; reviewControls(); return; }
  delete $('#review-state').dataset.help;
  $('#reviewer').value = review.reviewer; $('#review-note').value = review.note;
  reviewControls();
}
async function saveReview(action) {
  clearTimeout(saveTimer);
  while(savingPromise)await savingPromise;
  if (!review?.supported || action==='save'&&!reviewDirty) return true;
  if(action==='approve'&&review.items.some(item=>item.decision==='pending')) {reviewMessage(`还有 ${review.items.filter(i=>i.decision==='pending').length} 处待确认`);await nextReview();return false;}
  reviewSaving = true;exclusiveWrite=action!=='save';reviewControls();
  const id = selected,version=changeVersion;
  savingPromise=(async()=>{try {
    await syncWindowGuard();
    const payload = {action, expected_revision: review.revision};
    if (action !== 'reopen') Object.assign(payload, {reviewer: $('#reviewer').value, note: $('#review-note').value, items: review.items.map(({id, decision, replacement}) => ({id, decision, replacement}))});
    const result = await (await api(`/api/jobs/${id}/approval`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)})).json();
    if (selected !== id) return;
    if(version===changeVersion||action!=='save') {review=result;reviewDirty=false;}
    else review.revision=result.revision;
    const job = jobs.find(item => item.id === id); if (job) { job.approval_status = review.status; job.approval_revision = review.revision; }
    renderJobs();reviewControls();
    reviewMessage('');
    return true;
  } catch (error) { reviewMessage(`保存失败：${error.message}`, true);return false; }
  finally { reviewSaving = false;exclusiveWrite=false;reviewControls();savingPromise=null; }
  })();
  const success=await savingPromise;
  if(success&&reviewDirty) {clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveReview('save'),700);}
  return success;
}
function updateParagraph(id) {const p=preview?.paragraphs.find(p=>p.id===id);if(p)document.getElementById(id)?.querySelector('.paragraph-text')?.replaceWith(paragraphText(p));}
function editAnchor(id) {return [...document.querySelectorAll('[data-issue-id]')].find(n=>n.dataset.issueId===id);}
function positionEditor() {
  if($('#edit-popover').hidden)return;
  const anchor=editAnchor(currentEditId);if(!anchor){$('#edit-popover').hidden=true;return;}
  const rect=anchor.getClientRects()[0]||anchor.getBoundingClientRect(),panel=$('.viewer-panel').getBoundingClientRect(),box=$('#edit-popover');
  if(rect.bottom<panel.top+100||rect.top>panel.bottom){box.hidden=true;return;}
  const left=Math.max(8,Math.min(rect.left,innerWidth-box.offsetWidth-12));
  const below=rect.bottom+10,above=rect.top-box.offsetHeight-10;
  box.style.left=`${left}px`;box.style.top=`${Math.max(8,Math.min(below+box.offsetHeight<innerHeight?below:above,innerHeight-box.offsetHeight-8))}px`;
}
async function openReview(id) {
  if(!review?.supported||exclusiveWrite)return;
  if(review.status==='approved'&&!await saveReview('reopen'))return;
  const item=review.items.find(i=>i.id===id);if(!item)return;
  currentEditId=id;
  const anchor=editAnchor(id);if(!anchor)return;
  anchor.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  $('#replacement').value=item.decision==='reject'?item.original:item.replacement;
  $('#edit-position').textContent=`${review.items.indexOf(item)+1} / ${review.items.length}`;
  $('#edit-position').dataset.help=item.reason;
  $('#edit-reason').textContent=item.reason;
  $('#edit-popover').hidden=false;
  document.querySelectorAll('.revision.current').forEach(n=>n.classList.remove('current'));
  document.querySelectorAll('[data-issue-id]').forEach(n=>{if(n.dataset.issueId===id)n.classList.add('current');});
  positionEditor();$('#replacement').focus({preventScroll:true});
}
async function nextReview(after='') {
  if(!review?.supported)return;
  const index=review.items.findIndex(i=>i.id===after);
  const ordered=[...review.items.slice(index+1),...review.items.slice(0,index+1)];
  const next=ordered.find(i=>i.decision==='pending');
  if(next)await openReview(next.id);else {$('#edit-popover').hidden=true;currentEditId='';$('#approve-review').focus({preventScroll:true});}
}
async function exportDocument() {
  $('#edit-popover').hidden=true;
  if(review?.status!=='approved'&&!await saveReview('approve'))return;
  const file=review?.files?.find(f=>f.name.endsWith('.docx'));if(!file)return;
  const link=element('a');link.href=file.url;link.download=file.name;document.body.append(link);link.click();link.remove();
}
async function reloadReview() {
  if (reviewSaving || !selected || reviewDirty && !window.confirm('当前审批更改尚未保存，重新载入将丢弃这些更改。确定继续？')) return;
  const id = selected;
  try {
    const value = await (await api(`/api/jobs/${id}/approval`)).json();
    if (selected !== id) return;
    review = value; reviewDirty = false; reviewMessage(''); renderReview(); if (preview) renderPreview(preview);
  } catch (error) { reviewMessage(error.message, true); }
}
async function selectJob(id) {
  if(savingPromise)await savingPromise;
  if (reviewDirty && id === selected) return;
  if (reviewDirty && !await saveReview('save')) return;
  const job = jobs.find(item => item.id === id);
  if (!job) return;
  selected = id; selectedVersion = `${id}:${job.updated_at}:${job.status}`;
  const sequence = ++loadSequence;
  preview = null; report = ''; previewError = ''; review = null; reviewDirty = false; reviewControls(); reviewMessage(''); $('#approval-panel').hidden = true;
  $('#edit-popover').hidden=true;currentEditId='';
  renderJobs(); pane('viewer');
  $('#document-title').textContent = job.document_names?.join('、') || job.source_path?.split('/').at(-1) || '文档';
  $('#document-info').dataset.help = `${job.batch_name ? job.batch_name + ' · ' : ''}${status(job)}${job.status === 'running' && job.stage ? ` · ${stages[job.stage] || '正在处理'}` : ''}`;
  $('#downloads').replaceChildren(); $('#document-view').hidden = true; $('#report-dialog').close(); $('#document-more').open = false;
  if (job.status !== 'completed') {
    showState(status(job), job.error || (job.status === 'queued' ? '文件已保存，轮到后自动开始审查。' : '正在处理这份文件，完成后可以查看标注正文和审查报告。'), ['failed', 'interrupted'].includes(job.status));
    if (['failed', 'interrupted'].includes(job.status)) {
      const retry = element('button', '重试'); retry.type = 'button'; retry.addEventListener('click', () => retryJob(job, retry)); $('#viewer-state').append(retry);
    }
    return;
  }
  for (const file of job.files || []) {
    if (!/\.(docx|pdf)$|^report\.md$/i.test(file.name)) continue;
    const link = element('a', file.name === 'report.md' ? '下载报告' : '下载标注版'); link.href = file.url; link.download = file.name;
    $('#downloads').append(link);
  }
  showState('正在读取审查结果', '正在加载标注正文和报告…');
  const results = await Promise.allSettled([
    api(`/api/jobs/${id}/preview`).then(response => response.json()),
    api(`/api/jobs/${id}/report`).then(response => response.text()),
    api(`/api/jobs/${id}/approval`).then(response => response.json())
  ]);
  if (sequence !== loadSequence) return;
  if (results[2].status === 'fulfilled') review = results[2].value;
  else review = {supported: false, message: `审批记录载入失败：${results[2].reason.message}`};
  renderReview();
  if (results[0].status === 'fulfilled') { preview = results[0].value; renderPreview(preview); }
  else previewError = results[0].reason.message;
  if (results[1].status === 'fulfilled') report = results[1].value;
  else report = `报告读取失败：${results[1].reason.message}`;
  showDocument();
  if(review?.supported&&review.items.some(item=>item.decision==='pending'))await nextReview();
}
async function submit() {
  if (submitting || !pending.length || !config?.tools?.xiasha?.ready) return;
  const batchName = $('#batch-name').value.trim();
  if (/[\x00-\x1f<>:"/\\|?*]/.test(batchName)) { message('批次名称不能包含路径或文件名保留字符。', true); return; }
  submitting = true; renderPending();
  let count = 0;
  const total = pending.length;
  try {
    for (const entry of [...pending]) {
      message(`正在保存第 ${count + 1} / ${total} 份文件…`);
      const form = new FormData(); form.set('kind', 'xiasha');
      // Directory uploads can carry the relative path as the multipart filename.
      form.set('document', entry.file, entry.file.name.split(/[\\/]/).at(-1)); form.set('source_path', entry.path);
      if (batchName) form.set('batch_name', batchName);
      const job = await (await api('/api/jobs', {method: 'POST', body: form})).json();
      jobs.unshift(job); pending = pending.filter(item => item !== entry); count++;
      renderPending(); renderJobs();
    }
    message(`${count} 份文件已加入审查队列。`);
    if (!pending.length) $('#batch-name').value = '';
  } catch (error) { message(`已保存 ${count} 份；其余 ${pending.length} 份保留在清单中。${error.message}`, true); }
  finally { submitting = false; renderPending(); await refreshJobs(); }
}
$('#pick-files').addEventListener('click', () => $('#files').click());
$('#pick-folder').addEventListener('click', () => $('#folder').click());
$('#files').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
$('#folder').addEventListener('change', event => { addFiles(event.target.files, true); event.target.value = ''; });
$('#clear-pending').addEventListener('click', () => { pending = []; renderPending(); message(''); });
$('#submit').addEventListener('click', submit);
$('#refresh').addEventListener('click', () => { loadConfig(); refreshJobs(); });
$('#search').addEventListener('input', renderJobs); $('#filter').addEventListener('change', renderJobs);
$('#open-report').addEventListener('click', () => { $('#report-text').textContent = report || '暂无报告'; $('#document-more').open = false; $('#report-dialog').showModal(); });
$('#close-report').addEventListener('click', () => $('#report-dialog').close());
$('#download-update').addEventListener('click',()=>window.pywebview?.api.open_update());
$('#dismiss-update').addEventListener('click',()=>{$('#update-banner').hidden=true;});
$('#reviewer').addEventListener('input', () => { if (review?.supported) { review.reviewer = $('#reviewer').value; dirtyReview(); } });
$('#review-note').addEventListener('input', () => { if (review?.supported) { review.note = $('#review-note').value; dirtyReview(); } });
$('#next-review').addEventListener('click', () => {const next=review?.items.find(i=>i.decision==='pending')||review?.items[0];if(next)openReview(next.id);});
$('#approve-review').addEventListener('click', exportDocument);
$('#close-edit').addEventListener('click',()=>{$('#edit-popover').hidden=true;});
$('#replacement').addEventListener('input',()=>{
  const item=review?.items.find(i=>i.id===currentEditId);if(!item||exclusiveWrite)return;
  item.replacement=$('#replacement').value;item.decision='pending';updateParagraph(item.paragraph_id);dirtyReview();positionEditor();
});
$('#confirm-edit').addEventListener('click',()=>{
  const item=review?.items.find(i=>i.id===currentEditId);if(!item||exclusiveWrite)return;
  item.replacement=$('#replacement').value;item.decision=item.replacement===item.original?'reject':'accept';
  updateParagraph(item.paragraph_id);dirtyReview();nextReview(item.id);
});
$('#replacement').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();$('#confirm-edit').click();}});
$('#document-body').addEventListener('click',event=>{const mark=event.target.closest('[data-issue-id]');if(mark)openReview(mark.dataset.issueId);});
$('#document-body').addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){const mark=event.target.closest('[data-issue-id]');if(mark){event.preventDefault();openReview(mark.dataset.issueId);}}});
$('.viewer-panel').addEventListener('scroll',positionEditor);
window.addEventListener('resize',positionEditor);
$('#reload-review').addEventListener('click', reloadReview);
window.addEventListener('beforeunload', event => { if (reviewDirty || reviewSaving) { event.preventDefault(); event.returnValue = ''; } });
document.querySelectorAll('.compact-nav button').forEach(button => button.addEventListener('click', () => pane(button.dataset.pane)));
const drop = $('#drop-zone');
drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragging'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('dragging'); addFiles(event.dataTransfer.files); });
async function retryJob(job, button) {
  button.disabled = true;
  try {
    const next = await (await api(`/api/jobs/${job.id}/retry`, {method: 'POST'})).json();
    jobs.unshift(next); await selectJob(next.id); renderJobs();
  } catch (error) { showState('无法重新排队', error.message, true); }
  finally { button.disabled = false; }
}
const tooltip = $('#hover-info');
let helpTimer, helpTarget;
function hideHelp() { clearTimeout(helpTimer); tooltip.hidden = true; helpTarget?.removeAttribute('aria-describedby'); helpTarget = null; }
function showHelp(target) {
  if (!target?.dataset.help) return;
  helpTarget?.removeAttribute('aria-describedby'); helpTarget = target; target.setAttribute('aria-describedby', 'hover-info');
  tooltip.textContent = target.dataset.help; tooltip.hidden = false;
  const rect = target.getBoundingClientRect();
  tooltip.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - tooltip.offsetWidth - 8))}px`;
  tooltip.style.top = `${rect.bottom + tooltip.offsetHeight + 12 > innerHeight ? Math.max(8, rect.top - tooltip.offsetHeight - 8) : rect.bottom + 8}px`;
}
document.addEventListener('pointerover', event => { const target = event.target.closest('[data-help]'); clearTimeout(helpTimer); if (target) helpTimer = setTimeout(() => showHelp(target), 500); });
document.addEventListener('pointerout', hideHelp);
document.addEventListener('focusin', event => showHelp(event.target.closest('[data-help]')));
document.addEventListener('focusout', hideHelp);
document.addEventListener('click', event => { if (event.target.closest('.help-button')) showHelp(event.target.closest('[data-help]')); else hideHelp(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') { hideHelp(); $('#document-more').open = false;$('#edit-popover').hidden=true; } });
document.addEventListener('scroll', hideHelp, true);
document.addEventListener('click', event => { if (!event.target.closest('#document-more')) $('#document-more').open = false; });
await loadConfig(); await refreshJobs();
