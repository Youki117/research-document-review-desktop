import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {mkdir,readFile,writeFile,rename,readdir,stat,copyFile} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {parseArgs} from 'node:util';
import {TOOLS,FILE_BYTES,TOTAL_BYTES,UUID,validateForm,commandArgs,outputDir,collectOutput,progress,historyFor,inputError as error} from './business.mjs';
import {modelEnvironment} from './model-config.mjs';
import {documentPreview} from './preview.mjs';
import {getApproval, updateApproval, approvalFile} from './approval.mjs';
import {recordModification} from './modification-log.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const PUBLIC=fileURLToPath(new URL('./public/',import.meta.url));
const execute=promisify(execFile);
const now=()=>new Date().toISOString();
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};

async function readJson(path){return JSON.parse(await readFile(path,'utf8'));}
async function knownReviewFailure(dir){
 try{
  const report=await readJson(join(dir,'output','report.json'));
  if(report.files?.some(file=>/PDF has an empty text page|PDF has no.*text/i.test(file.error||'')))return 'PDF 包含无可提取文字的页面，请先 OCR 后重新提交。';
  if(report.files?.some(file=>/DOCX contains tracked revisions/i.test(file.error||'')))return 'DOCX 包含已有修订，请先在 Word/WPS 中处理修订后重新提交。';
  if(report.model_audit?.some(call=>call.status==='failed'&&/aborted|timeout|timed out/i.test(call.error||'')))return '模型检查超时，未生成完整结果。可点击重新排队，或拆分长文档后重新提交。';
  if(report.model_audit?.some(call=>call.status==='failed'&&/must be valid JSON/i.test(call.error||'')))return '模型返回的数据格式异常，未生成完整结果。请重新排队重试。';
 }catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
 return null;
}
async function saveJob(dir,job){
 const path=join(dir,job.id,'job.json');
 await writeFile(path+'.tmp',JSON.stringify(job,null,2),'utf8');
 await rename(path+'.tmp',path);
 let suggestions;
 if(job.status==='completed'){
  try{const report=await readJson(join(dir,job.id,'output','report.json'));suggestions=report.files?.map(file=>({
   written_issues:file.written_issues, unmatched:file.unmatched, validation_rejected:file.validation_rejected,
   filtered:file.filtered
  }));}catch{suggestions=null;}
 }
 let failure=job.error;
 if(job.kind==='xiasha'&&job.status==='failed'){
  try{failure=await knownReviewFailure(join(dir,job.id))||failure;}catch{ /* Keep the saved failure if diagnostics cannot be read. */ }
 }
 job.log_warning=await recordModification(dir,job,'task_status',{status:job.status,result_status:job.result_status,
  error:failure,
  ...(job.status==='completed'?{ai_suggestions:suggestions}: {})});
}

async function readForm(req){
 if(!/^multipart\/form-data;/.test(req.headers['content-type']||''))throw error(415,'请使用 multipart/form-data 上传附件');
 const limit=TOTAL_BYTES+1024*1024;
 if(Number(req.headers['content-length'])>limit)throw error(413,'上传内容超过100 MiB');
 let size=0;const chunks=[];
 for await(const chunk of req){size+=chunk.length;if(size>limit)throw error(413,'上传内容超过100 MiB');chunks.push(chunk);}
 try{return await new Request('http://localhost/upload',{method:'POST',headers:{'Content-Type':req.headers['content-type']},body:Buffer.concat(chunks)}).formData();}
 catch{throw error(400,'无法解析上传内容');}
}

async function readApprovalRequest(req){
 if(!/^application\/json(?:;|$)/.test(req.headers['content-type']||''))throw error(415,'审批记录须使用 JSON 提交');
 let size=0;const chunks=[];
 for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024)throw error(413,'审批记录超过2 MiB，请减少局部替换文字');chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw error(400,'审批记录不是有效 JSON');}
}

export async function createReviewServer({dataDir=join(ROOT,'packaging-review','data'),configPath=join(ROOT,'模型配置.json'),environment=process.env,python=environment.PACKAGING_PYTHON||(process.platform==='win32'?'python':'python3'),toolKind=null,skillRoot=null,queueLimit=10}={}){
 if(!Number.isInteger(queueLimit)||queueLimit<1||queueLimit>200)throw Error('等待队列上限无效');
 if(toolKind!==null&&!Object.hasOwn(TOOLS,toolKind))throw Error('独立工具类型无效');
 if(skillRoot&&!toolKind)throw Error('独立程序目录需要指定工具类型');
 const tools=toolKind?{[toolKind]:TOOLS[toolKind]}:TOOLS;
 dataDir=resolve(dataDir);configPath=resolve(configPath);
 await mkdir(dataDir,{recursive:true});
 const jobs=new Map(),queue=[];
 let child=null,running=false,stopping=false,uploading=false;
 let activeFinished=Promise.resolve(),uploadFinished=Promise.resolve();
 for(const entry of await readdir(dataDir,{withFileTypes:true})){
  if(!entry.isDirectory()||!UUID.test(entry.name))continue;
  let job;
  try{job=await readJson(join(dataDir,entry.name,'job.json'));}
  catch(e){if(e.code==='ENOENT')continue;throw e;}
  if(job.id!==entry.name)throw Error('任务记录与目录不一致');
  if(!Object.hasOwn(tools,job.kind))continue;
  if(['queued','running'].includes(job.status)){
   job.status='interrupted';job.error='上次服务退出时任务尚未完成。原附件和进度已保留，请核对后重新提交。';job.updated_at=now();
   await saveJob(dataDir,job);
  }
  jobs.set(job.id,job);
 }
 async function configuration(kind=toolKind){
  let result={},configured=environment;
  try{
   configured=await modelEnvironment(configPath,environment,kind);
   result={REVIEW:Boolean(configured.REVIEW_CHAT_URL&&configured.REVIEW_MODEL),VISION:Boolean(configured.VISION_CHAT_URL&&configured.VISION_MODEL),text_key_ready:Boolean(configured.REVIEW_API_KEY)};
  }catch(e){result.error=e.message;}
  let graphReady=false;
  try{const url=new URL(configured.NEO4J_HTTP_URL);graphReady=['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash&&Boolean(configured.NEO4J_USERNAME)===Boolean(configured.NEO4J_PASSWORD);}catch{}
  const formulationMessage=graphReady?(configured.BOCHA_API_KEY?'图谱和检索配置已提供，实际连接需执行验证。':'博查未配置，组方仍可执行，外部资料将标为未完整完成。'):'组方需要配置现有 Neo4j 图谱连接；请参阅使用说明。';
  const readiness=Object.fromEntries(Object.entries(tools).map(([kind,tool])=>{
   const modelReady=['food','pet'].includes(kind)?result.VISION:result.REVIEW;
   const ready=Boolean(modelReady&&(!tool.requiresKey||result.text_key_ready)&&(kind!=='formulation'||graphReady));
   const message=!modelReady?(result.error||(['food','pet'].includes(kind)?'请先配置食品和宠物任务统一使用的视觉模型。':'请先配置文本模型。')):tool.requiresKey&&!result.text_key_ready?'此业务引擎需要文本模型 API 密钥，请在后台配置。':kind==='formulation'?formulationMessage:'执行配置已提供，实际效果需业务验收。';
   return [kind,{ready,message}];
  }));
  return {tool:toolKind?{kind:toolKind,label:tools[toolKind].label}:null,ready:Boolean(result.REVIEW&&result.VISION),text_ready:Boolean(result.REVIEW),vision_ready:Boolean(result.VISION),text_key_ready:Boolean(result.text_key_ready),formulation_ready:Boolean(result.REVIEW&&graphReady),formulation_message:formulationMessage,tools:readiness,message:result.error||(result.REVIEW&&result.VISION?'模型配置已就绪；实际效果以业务验收为准。':'请在模型配置.json中填写所需模型；文档和科研任务只需文本模型。'),limits:{file_bytes:FILE_BYTES,total_bytes:TOTAL_BYTES,files_per_group:10}};
 }
 async function view(job){
  const result={...job,...await progress(job,join(dataDir,job.id)),files:[]};
  if(job.kind==='xiasha'&&job.status==='failed')result.error=await knownReviewFailure(join(dataDir,job.id))||job.error;
  if(job.kind==='xiasha'&&job.status==='completed'){
   try{const approval=await readJson(join(dataDir,job.id,'private','approval.json'));result.approval_status=approval.status;result.approval_revision=approval.revision;}
   catch(e){if(e.code!=='ENOENT')throw e;result.approval_status='not_started';result.approval_revision=0;}
  }
  if(job.status==='completed')result.files=(job.artifact_names||TOOLS[job.kind].files).map(name=>({name,url:`/api/jobs/${job.id}/files/${encodeURIComponent(name)}`}));
  return result;
 }
 async function pump(){
  if(running||stopping||!queue.length)return;
  running=true;
  const job=jobs.get(queue.shift()),dir=join(dataDir,job.id);
  let finishActive;activeFinished=new Promise(done=>{finishActive=done;});
  try{
  job.status='running';job.updated_at=now();await saveJob(dataDir,job);
  if(stopping){job.status='interrupted';job.error='服务关闭时任务尚未开始，请重新提交。';job.updated_at=now();await saveJob(dataDir,job);running=false;finishActive();return;}
  const invocation=commandArgs(job,dir),tool=tools[job.kind],source=skillRoot||join(ROOT,'skills',tool.skill);
  const entry=job.kind==='consistency'?'audit.py':['proofread','xiasha','shaoxing'].includes(job.kind)?'proofread.mjs':job.kind==='research'?'research.mjs':job.kind==='formulation'?'formulate.mjs':'review.mjs';
  const childEnvironment=await modelEnvironment(configPath,environment,job.kind);
  if(stopping){job.status='interrupted';job.error='服务关闭时任务尚未开始，请重新提交。';job.updated_at=now();await saveJob(dataDir,job);running=false;finishActive();return;}
  const args=[join(source,'scripts',entry),...invocation.slice(1)];
  child=spawn(job.kind==='consistency'?python:process.execPath,args,{windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:childEnvironment});
  let stderr='',spawnError=false;
  child.stdout.resume();child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-16384);});
  child.on('error',()=>{spawnError=true;});
  child.once('close',async code=>{
   child=null;job.updated_at=now();
   try{
    if(stopping){job.status='interrupted';job.error='服务已关闭，任务进度已保留。';}
    else if(code===0){
     const output=await collectOutput(job,dir),current=await progress(job,dir);
     job.status='completed';job.result_status=output.status;job.artifact_names=output.names;job.completed_stages=current.completed_stages;job.error=null;
    }else{
     job.status='failed';
     // Never return raw subprocess output: parsers and runtimes may echo uploaded data or secrets.
     const known=stderr.match(/(?:模型接口HTTP \d{3}|模型接口不是JSON|模型正文必须为完整纯JSON对象|模型结果被截断或未正常结束|模型错误或输出被截断|输入必须为非空普通文件且不超过50 MiB|包装OCR未提取到正文|包装OCR失败，禁止生成正常结论|配方CFU每克明细合计 [\d.e+]+ 与表头 [\d.e+]+ 不一致，需核对原文件及列映射|PDF须包含1至8页，禁止静默只审查部分页面|单页图像超过4000万像素|图块超过64块，请按产品拆分任务)/)?.[0];
     job.error=spawnError?'无法启动审查进程，请检查 Python 和 Node.js。':known||'审查未完成，请检查附件清晰度、格式和模型配置。执行记录保存在本机任务目录中。';
    }
   }catch{job.status='failed';job.error='审查结果不完整，未开放成果下载。请检查本机任务记录。';}
   try{await saveJob(dataDir,job);}
   catch(e){server.emit('error',e);}
   finally{running=false;finishActive();pump().catch(e=>server.emit('error',e));}
  });
  }catch(e){
   job.status='failed';job.error='无法准备业务任务，请检查本工具的配置和程序目录。';job.updated_at=now();
   try{await saveJob(dataDir,job);}finally{running=false;finishActive();pump().catch(error=>server.emit('error',error));}
  }
 }
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
   const host=req.headers.host;
   if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host||''))throw error(403,'仅允许本机访问');
   if(req.headers.origin&&req.headers.origin!==`http://${host}`)throw error(403,'不允许跨站请求');
   const url=new URL(req.url,`http://${host}`),path=url.pathname;
   if(req.method==='GET'&&path==='/api/config')return json(res,200,await configuration());
   if(req.method==='GET'&&path==='/api/tools')return json(res,200,Object.entries(tools).map(([kind,tool])=>({kind,label:tool.label})));
   if(req.method==='GET'&&path==='/api/jobs')return json(res,200,await Promise.all([...jobs.values()].sort((a,b)=>b.created_at.localeCompare(a.created_at)).map(view)));
   if(req.method==='POST'&&path==='/api/jobs'){
    if(req.headers['x-review-client']!=='packaging-review')throw error(403,'缺少调用标识 X-Review-Client');
    if(stopping||uploading||queue.length>=queueLimit)throw error(409,'当前有上传或等待任务，请稍后重试');
    uploading=true;
    let finishUpload;uploadFinished=new Promise(done=>{finishUpload=done;});
    try{
     const form=await readForm(req);
     if(toolKind&&form.get('kind')!==toolKind)throw error(400,'请求业务与当前工具不匹配');
     const input=validateForm(form),config=await configuration(input.kind);
     if(stopping)throw error(503,'服务正在关闭，请重新提交。');
     if(!config.tools[input.kind].ready)throw error(503,config.tools[input.kind].message);
     if(input.needsVision&&!config.vision_ready)throw error(503,'当前任务需要视觉模型，请先在后台配置。');
     let history;
     if(input.parent_id){
      const parent=jobs.get(input.parent_id);
      if(!parent||parent.kind!=='formulation'||parent.status!=='completed')throw error(409,'追问需要一个已完成的组方任务');
      history=await historyFor(parent,join(dataDir,parent.id));
     }
     const job={id:randomUUID(),kind:input.kind,category:input.category,mode:input.mode,review_date:input.review_date,review_side:input.review_side,instruction:input.instruction,query:input.query,parent_id:input.parent_id,status:'queued',created_at:now(),updated_at:now(),package_names:input.packages.map(f=>f.name),formula_names:input.formulas.map(f=>f.name),document_names:input.documents.map(f=>f.name),error:null,result_status:null};
     if(input.batch_name)job.batch_name=input.batch_name;
     if(input.source_path)job.source_path=input.source_path;
     const uploads=join(dataDir,job.id,'uploads');await mkdir(uploads,{recursive:true});
     await mkdir(join(dataDir,job.id,'private'));
     if(history)await writeFile(join(dataDir,job.id,'private','history.json'),JSON.stringify(history),'utf8');
     for(const [group,files] of [['package',input.packages],['formula',input.formulas],['document',input.documents]])
      for(const [i,file] of files.entries())await writeFile(join(uploads,`${group}-${i+1}-${file.name}`),Buffer.from(await file.arrayBuffer()),{flag:'wx'});
     await saveJob(dataDir,job);jobs.set(job.id,job);
     if(stopping){job.status='interrupted';job.error='服务关闭时任务尚未开始，请重新提交。';job.updated_at=now();await saveJob(dataDir,job);}
     else queue.push(job.id);
     json(res,202,await view(job));pump().catch(e=>server.emit('error',e));return;
    }finally{uploading=false;finishUpload();}
   }
   const retryRoute=path.match(/^\/api\/jobs\/([^/]+)\/retry$/);
   if(req.method==='POST'&&retryRoute){
    if(req.headers['x-review-client']!=='packaging-review')throw error(403,'缺少调用标识 X-Review-Client');
    const source=jobs.get(retryRoute[1]);
    if(!UUID.test(retryRoute[1])||!source||source.kind!=='xiasha')throw error(404,'未找到原任务');
    if(!['failed','interrupted'].includes(source.status))throw error(409,'仅失败或中断任务可以重新排队');
    if(stopping||uploading||queue.length>=queueLimit)throw error(409,'当前有上传或等待任务，请稍后重试');
    uploading=true;let finishUpload;uploadFinished=new Promise(done=>{finishUpload=done;});
    try{
     const config=await configuration('xiasha');if(!config.tools.xiasha.ready)throw error(503,config.tools.xiasha.message);
     if(source.document_names?.length!==1)throw error(409,'原任务附件不完整，请重新选择文件');
     const name=source.document_names[0];
     if(typeof name!=='string'||/[\x00-\x1f<>:"/\\|?*]/.test(name))throw error(409,'原附件名称无效，请重新选择文件');
     const original=join(dataDir,source.id,'uploads',`document-1-${name}`);
     const info=await stat(original);if(!info.isFile()||!info.size||info.size>FILE_BYTES)throw error(409,'原附件不可用，请重新选择文件');
     const bytes=await readFile(original),form=new FormData();form.set('kind','xiasha');form.set('document',new File([bytes],name));
     if(source.batch_name)form.set('batch_name',source.batch_name);if(source.source_path)form.set('source_path',source.source_path);validateForm(form);
     if(stopping)throw error(503,'服务正在关闭，请稍后重试');
     const job={...source,id:randomUUID(),status:'queued',created_at:now(),updated_at:now(),error:null,result_status:null,retry_of:source.id};
     delete job.artifact_names;delete job.completed_stages;
     const uploads=join(dataDir,job.id,'uploads');await mkdir(uploads,{recursive:true});await mkdir(join(dataDir,job.id,'private'));
     try{await copyFile(join(dataDir,source.id,'output','private','discovery-checkpoint.json'),join(dataDir,job.id,'private','discovery-checkpoint.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
     await writeFile(join(uploads,`document-1-${name}`),bytes,{flag:'wx'});await saveJob(dataDir,job);jobs.set(job.id,job);
     if(stopping){job.status='interrupted';job.error='服务关闭时尚未开始，请重新排队。';await saveJob(dataDir,job);}else queue.push(job.id);
     json(res,202,await view(job));pump().catch(e=>server.emit('error',e));return;
    }catch(e){if(e.code==='ENOENT')throw error(409,'原附件已不存在，请重新选择文件');throw e;}
    finally{uploading=false;finishUpload();}
   }
   const approvalRoute=path.match(/^\/api\/jobs\/([^/]+)\/approval(?:\/files\/(document|record))?$/);
   if(approvalRoute){
    const [,id,kind]=approvalRoute;
    if(!UUID.test(id)||!jobs.has(id)||jobs.get(id).kind!=='xiasha')throw error(404,'未找到审批任务');
    const job=jobs.get(id),directory=outputDir(job,join(dataDir,id));
    if(job.status!=='completed')throw error(409,'机器审查尚未结束，暂不能审批');
    if(req.method==='GET'&&!kind)return json(res,200,await getApproval(job,directory));
    if(req.method==='POST'&&!kind){
     if(req.headers['x-review-client']!=='packaging-review')throw error(403,'缺少调用标识 X-Review-Client');
     return json(res,200,await updateApproval(job,directory,await readApprovalRequest(req)));
    }
    if(req.method==='GET'&&kind){
     const file=await approvalFile(job,directory,kind),info=await stat(file.path);
     res.setHeader('Content-Type',kind==='document'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/json; charset=utf-8');
     res.setHeader('Content-Length',info.size);
     res.setHeader('Content-Disposition',`attachment; filename="approved${extname(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
     const stream=createReadStream(file.path);stream.on('error',()=>res.destroy());stream.pipe(res);return;
    }
    throw error(405,'审批接口不支持此操作');
   }
   const route=path.match(/^\/api\/jobs\/([^/]+)(?:\/(report|files|preview)(?:\/([^/]+))?)?$/);
   if(req.method==='GET'&&route){
    const [,id,action,encodedName]=route;
    if(!UUID.test(id)||!jobs.has(id))throw error(404,'未找到任务');
    const job=jobs.get(id);
    if(!action)return json(res,200,await view(job));
    if(job.status!=='completed')throw error(409,'审查尚未完成，暂不能下载报告');
    if(action==='preview'){
     if(job.kind!=='xiasha'||encodedName)throw error(404,'未找到预览');
     return json(res,200,await documentPreview(job,outputDir(job,join(dataDir,id))));
    }
    const name=action==='report'?TOOLS[job.kind].report:decodeURIComponent(encodedName||'');
    if(!(job.artifact_names||TOOLS[job.kind].files).includes(name))throw error(404,'未找到成果');
    const file=join(outputDir(job,join(dataDir,id)),name),info=await stat(file);
    const type={'.json':'application/json; charset=utf-8','.md':'text/markdown; charset=utf-8','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.pdf':'application/pdf'}[extname(name)]||'application/octet-stream';
    res.setHeader('Content-Type',action==='report'?'text/plain; charset=utf-8':type);
    res.setHeader('Content-Length',info.size);
    if(action==='files')res.setHeader('Content-Disposition',`attachment; filename="report${extname(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    const stream=createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);return;
   }
   const assets={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/style.css':['style.css','text/css'],'/icon.png':['icon.png','image/png']};
   if(req.method==='GET'&&assets[path]){
    const [name,type]=assets[path];res.setHeader('Content-Type',type+(type.startsWith('image/')?'':'; charset=utf-8'));res.end(await readFile(join(PUBLIC,name)));return;
   }
   throw error(404,'未找到页面或接口');
  }catch(e){
   if(res.headersSent){res.destroy();return;}
   // Rejected uploads may have unread bytes; do not reuse their connection for another request.
   res.setHeader('Connection','close');
   json(res,e.status||500,{error:e.status?e.message:'服务处理失败，请检查本机运行目录和文件权限。'});
  }
 });
 server.requestTimeout=120000;
 server.stop=async()=>{
  stopping=true;
  const closed=new Promise(done=>server.close(done));server.closeAllConnections();
  const active=child;
  if(active){
   if(process.platform==='win32')await execute('taskkill',['/PID',String(active.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
   else {try{process.kill(-active.pid,'SIGTERM');}catch{active.kill('SIGTERM');}}
  }
  await activeFinished;await uploadFinished;
  for(const id of queue){const job=jobs.get(id);job.status='interrupted';job.error='服务关闭时任务尚未开始，请重新提交。';job.updated_at=now();await saveJob(dataDir,job);}
  await closed;
 };
 return server;
}

async function main(){
 if(Number(process.versions.node.split('.')[0])<24)throw Error('需要 Node.js 24+');
 let profile=null;
 try{profile=await readJson(new URL('./profile.json',import.meta.url));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(profile&&!Object.hasOwn(TOOLS,profile.kind))throw Error('独立工具类型无效');
 const {values}=parseArgs({options:{port:{type:'string',default:'8765'},config:{type:'string',default:join(ROOT,'模型配置.json')},'data-dir':{type:'string',default:profile?join(ROOT,'data'):join(ROOT,'packaging-review','data')}}});
 const port=Number(values.port);if(!Number.isInteger(port)||port<1||port>65535)throw Error('端口必须为1至65535的整数');
 const server=await createReviewServer({configPath:values.config,dataDir:values['data-dir'],toolKind:profile?.kind||null,skillRoot:profile?ROOT:null});
 server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'端口已被占用，请使用 --port 指定其他端口。':'服务发生错误，请检查运行目录和权限。');process.exitCode=1;});
 server.listen(port,'127.0.0.1',()=>console.log(`${profile?TOOLS[profile.kind].label:'业务工具开发服务'}：http://127.0.0.1:${port}\n关闭窗口或按 Ctrl+C 停止。`));
 let closing=false;
 const stop=()=>{if(closing)return;closing=true;server.stop().catch(()=>{process.exitCode=1;});};
 process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('无法启动，请检查 Node.js 24+、参数和运行目录。');process.exitCode=1;});
