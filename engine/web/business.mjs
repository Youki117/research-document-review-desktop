import {readFile,readdir,stat,realpath,lstat} from 'node:fs/promises';
import {join,resolve,basename,extname,sep} from 'node:path';

export const FILE_BYTES=50*1024*1024,TOTAL_BYTES=100*1024*1024;
export const CATEGORIES=new Set(['candy','probiotic_beverage','plant_beverage','sports_nutrition','lactobacillus_powder','health_food','other_food']);
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIDES=new Set(['party_a','party_b','buyer_or_customer','seller_or_supplier','neutral']);
const IMAGES=['.png','.jpg','.jpeg','.bmp','.tif','.tiff','.pdf'];
const TEXT=['.xlsx','.xlsm','.txt','.md','.csv','.tsv'];
const DOCS=['.docx','.txt','.md'];
const PACKAGING_FILES=['审查报告.md','审查结果.json','审查状态.json'];
export const TOOLS={
  "xiasha": {
    "label": "研发文档校对 · 下沙",
    "skill": "research-document-xiasha",
    "formats": [
      ".docx",
      ".pdf"
    ],
    "maxFiles": 1,
    "requiresKey": true,
    "report": "report.md",
    "files": [
      "report.md",
      "report.json"
    ]
  }
};
export const inputError=(status,message)=>Object.assign(new Error(message),{status});
const jsonFile=async path=>JSON.parse(await readFile(path,'utf8'));
const isProofread=kind=>['proofread','xiasha','shaoxing'].includes(kind);
export const outputDir=(job,dir)=>join(dir,'output',job.kind==='food'||job.kind==='pet'?'deliverables':'');

export function validateForm(form){
 const allowed=new Set(['kind','category','mode','review_date','package','formula','document','review_side','instruction','query','parent_id','batch_name','source_path']);
 for(const [key] of form)if(!allowed.has(key))throw inputError(400,'未知表单字段');
 const field=name=>{
  const values=form.getAll(name);
  if(values.length>1||values.some(v=>typeof v!=='string'))throw inputError(400,'表单字段重复或类型错误');
  return values[0]||'';
 };
 const kind=field('kind'),category=field('category'),mode=field('mode')||'full';
 const batchName=field('batch_name'),sourcePath=field('source_path');
 if((batchName||sourcePath)&&kind!=='xiasha')throw inputError(400,'批次信息仅用于下沙文档任务');
 if(batchName.length>120||/[\x00-\x1f<>:"/\\|?*]/.test(batchName))throw inputError(400,'批次名称无效');
 if(sourcePath.length>1000||/[\x00-\x1f<>:"\\|?*]/.test(sourcePath)||sourcePath.startsWith('/')||sourcePath.split('/').some(part=>part==='.'||part==='..'))throw inputError(400,'文件相对路径无效');
 const instruction=field('instruction').trim(),query=field('query').trim(),reviewSide=field('review_side'),parentId=field('parent_id');
 let reviewDate=field('review_date');
 if(!Object.hasOwn(TOOLS,kind))throw inputError(400,'请选择支持的业务类型');
 const tool=TOOLS[kind],packages=form.getAll('package'),formulas=form.getAll('formula'),documents=form.getAll('document');
 if(kind==='food'&&!CATEGORIES.has(category))throw inputError(400,'请明确选择食品品类');
 if(kind!=='food'&&(category||reviewDate))throw inputError(400,'此业务不接收食品品类或日期');
 if(kind==='pet'&&!['full','formula_only'].includes(mode)||kind!=='pet'&&mode!=='full')throw inputError(400,'审查范围无效');
 if(kind==='food'){
  reviewDate||=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const date=new Date(reviewDate+'T00:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==reviewDate)throw inputError(400,'审查日期必须为有效的 YYYY-MM-DD');
 }
 if(!['food','pet'].includes(kind)&&(packages.length||formulas.length)||['food','pet'].includes(kind)&&documents.length||kind==='food'&&formulas.length)throw inputError(400,'附件类型与所选业务不一致');
 if(['food','pet'].includes(kind)){
  if(mode==='formula_only'?(packages.length||!formulas.length):!packages.length)throw inputError(400,mode==='formula_only'?'仅配方审查请只上传配方':'请上传包装附件');
 }else if(tool.formats){
  if(!documents.length||documents.length>tool.maxFiles)throw inputError(400,`此业务需要1至${tool.maxFiles}份文档`);
 }else if(documents.length)throw inputError(400,'此业务请填写查询需求，无需上传文件');
 if(instruction&& !['consistency','contract'].includes(kind)||instruction.length>4000)throw inputError(400,'审查侧重点仅用于报告一致性或合同审查，最多4000字');
 if(kind==='contract'?!SIDES.has(reviewSide):Boolean(reviewSide))throw inputError(400,'请明确选择合同审查立场；其他业务不接收该选项');
 if(['research','formulation'].includes(kind)?!query||query.length>12000:Boolean(query))throw inputError(400,'科研或组方需求须为1至12000字；其他业务不接收查询需求');
 if(parentId&&(kind!=='formulation'||!UUID.test(parentId)))throw inputError(400,'追问仅支持已有组方任务');
 let total=0;
 for(const [files,formats] of [[packages,IMAGES],[formulas,[...IMAGES,...TEXT]],[documents,tool.formats||[]]]){
  if(files.length>10)throw inputError(400,'每类附件最多10份');
  const names=new Set();
  for(const file of files){
   if(typeof file==='string'||!formats.includes(extname(file.name).toLowerCase()))throw inputError(400,'附件格式不支持');
   if(!file.size||file.size>FILE_BYTES)throw inputError(413,'附件必须非空，且每份不超过50 MiB');
   if(file.name.length>160||/[\x00-\x1f<>:"/\\|?*]/.test(file.name)||/[. ]$/.test(file.name))throw inputError(400,'附件名称含不支持的字符或过长');
   const name=file.name.toLowerCase();if(names.has(name))throw inputError(400,'同一类附件名称不能重复');names.add(name);total+=file.size;
  }
 }
 if(total>TOTAL_BYTES)throw inputError(413,'附件总大小不能超过100 MiB');
 return {kind,batch_name:batchName,source_path:sourcePath,category:kind==='food'?category:null,mode,review_date:kind==='food'?reviewDate:null,review_side:reviewSide||null,instruction:instruction||null,query:query||null,parent_id:parentId||null,packages,formulas,documents,needsVision:packages.length>0||formulas.some(f=>!TEXT.includes(extname(f.name).toLowerCase()))};
}

export function commandArgs(job,dir){
 const args=[TOOLS[job.kind].skill,'run','--output-dir',join(dir,'output')];
 const paths=group=>(job[group+'_names']||[]).map((name,i)=>join(dir,'uploads',`${group}-${i+1}-${name}`));
 switch(job.kind){
  case 'food':args.push('--category',job.category,'--review-date',job.review_date);for(const path of paths('package'))args.push('--input',path);break;
  case 'pet':args.push('--mode',job.mode);for(const group of ['package','formula'])for(const path of paths(group))args.push('--'+group,path);break;
  case 'consistency':args.push('--input',paths('document')[0]);if(job.instruction)args.push('--instruction',job.instruction);break;
  case 'contract':args.push('--input',paths('document')[0],'--review-side',job.review_side);if(job.instruction)args.push('--query',job.instruction);break;
  case 'research':case 'formulation':
   args.push('--query',job.query,'--state',join(dir,'private','state.json'));
   if(job.parent_id)args.push('--history',join(dir,'private','history.json'));break;
  default:args.push(...paths('document'));if(job.kind==='xiasha'&&job.retry_of)args.push('--checkpoint',join(dir,'private','discovery-checkpoint.json'));
 }
 return args;
}

async function safeArtifact(dir,name){
 if(typeof name!=='string'||!name||name!==basename(name)||/[\x00-\x1f<>:"/\\|?*]/.test(name))throw Error('非法成果文件名');
 const path=join(dir,name),info=await lstat(path),real=await realpath(path),root=await realpath(dir);
 if(!info.isFile()||info.isSymbolicLink()||!real.startsWith(root+sep))throw Error('成果路径超出任务目录');
 return name;
}

export async function collectOutput(job,dir){
 const tool=TOOLS[job.kind],out=outputDir(job,dir),names=[...tool.files];
 let status;
 if(isProofread(job.kind)){
  const report=await jsonFile(join(out,'report.json'));
  if(!Array.isArray(report.files)||report.files.length!==job.document_names.length||report.files.every(f=>f.status==='failed'))throw Error('未完成任何文档');
  if(report.files.some(f=>!['complete','partial','failed'].includes(f.status)))throw Error('文档结果状态无效');
  status=report.files.every(f=>f.status==='complete')?'complete':'partial';
  for(const file of report.files)if(file.status!=='failed'){
   if(!['.docx','.pdf'].includes(extname(file.output||'').toLowerCase())||!/^F\d{3}-/.test(file.output||''))throw Error('标注文档无效');
   names.push(file.output);
  }
 }else{
  const resultFile=job.kind==='consistency'?'result.json':job.kind==='research'?'research-report.json':job.kind==='formulation'?'组方结果.json':job.kind==='food'||job.kind==='pet'?'审查状态.json':'report.json';
  const result=await jsonFile(join(out,resultFile));status=typeof result.status==='object'?result.status?.status:result.status;
  const accepted=job.kind==='consistency'?['completed_text_review','partial']:job.kind==='contract'?['complete','partial']:['research','formulation'].includes(job.kind)?['complete','incomplete']:['complete','complete_with_pending'];
  if(!accepted.includes(status))throw Error('结果未达到可交付状态');
 }
 if(new Set(names).size!==names.length)throw Error('成果文件名重复');
 for(const name of names)await safeArtifact(out,name);
 return {status,names};
}

export async function progress(job,dir){
 if(job.status==='completed')return {stage:['food','pet','contract'].includes(job.kind)?'ready':'complete',round:null,completed_stages:job.completed_stages||0};
 try{
  let state;
  if(job.kind==='xiasha'){
   const detail=await jsonFile(join(dir,'output','progress.json'));
   return {stage:detail.stage,round:null,completed_stages:detail.completed_chunks||0,total_chunks:detail.total_chunks||0,model_requests:detail.requests||0,completed_verification_batches:detail.completed_verification_batches||0,total_verification_batches:detail.total_verification_batches||0};
  }
  if(job.kind==='food'||job.kind==='pet')state=await jsonFile(join(dir,'output','private','state.json'));
  else if(job.kind==='contract'){
   const folder=join(dir,'output','private'),files=(await readdir(folder)).filter(name=>/^state-\d+\.json$/.test(name)).sort();
   if(files.length)state=await jsonFile(join(folder,files.at(-1)));
  }else if(['research','formulation'].includes(job.kind))state=await jsonFile(join(dir,'private','state.json'));
  else if(job.kind==='consistency'){
   let count=0;for(const stage of ['cross','residue','merge']){try{await stat(join(dir,'output',stage+'.json'));count++;}catch(e){if(e.code!=='ENOENT')throw e;}}
   return {stage:['cross','residue','merge','finalize'][count],round:null,completed_stages:count};
  }
  return {stage:state?.stage||state?.phase||(isProofread(job.kind)&&job.status==='running'?'discovery':null),round:state?.stage==='package_ocr'?state.round+1:null,completed_stages:state?.completed_stages?.length||0};
 }catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return {stage:null,round:null,completed_stages:0};throw e;}
}

export async function historyFor(parent,dir){
 const state=await jsonFile(join(dir,'private','state.json'));
 const result=await jsonFile(join(outputDir(parent,dir),'组方结果.json'));
 const history=[...(state.history||[]),{role:'user',content:parent.query},{role:'assistant',content:result.answer}].slice(-12);
 if(history.some(item=>!['user','assistant'].includes(item.role)||typeof item.content!=='string'||item.content.length>30000))throw inputError(409,'上轮内容超出追问上下文限制，请新建任务并明确概括需求');
 return history;
}
