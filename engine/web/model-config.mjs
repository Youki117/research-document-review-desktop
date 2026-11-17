import {readFile} from 'node:fs/promises';

export async function modelEnvironment(path,base=process.env,kind=null){
 let config;
 try{config=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));}
 catch{throw Error('无法读取模型配置，请检查文件路径、UTF-8 编码和 JSON 格式。');}
 if(!config||typeof config!=='object'||Array.isArray(config))throw Error('模型配置顶层必须是 JSON 对象。');
 const environment={...base,PYTHONUTF8:'1'};
 const section=(name,optional=false)=>{
  const value=config[name];
  if(optional&&value===undefined)return null;
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`配置缺少对象：${name}`);
  return value;
 };
 const text=(values,name,field)=>{
  const value=values[field];
  if(typeof value!=='string'||/[\r\n]/.test(value))throw Error(`${name}的${field}必须是单行字符串。`);
  return value;
 };
 const endpoint=(value,name)=>{
  if(!value)return value;
  let url;try{url=new URL(value);}catch{throw Error(`${name}必须是完整 HTTP(S) 接口地址。`);}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error(`${name}必须是无内嵌凭据或查询参数的 HTTP(S) 接口地址。`);
  return value;
 };
 for(const [name,prefix] of [['文本模型','REVIEW'],['视觉模型','VISION']]){
  const values=section(name,name==='视觉模型');
  for(const [field,suffix] of [['API地址','CHAT_URL'],['模型名称','MODEL'],['API密钥','API_KEY']]){
   const value=values?text(values,name,field):'';
   environment[prefix+'_'+suffix]=field==='API地址'?endpoint(value,name+'的API地址'):value;
  }
 }
 if(['food','pet'].includes(kind))for(const suffix of ['CHAT_URL','MODEL','API_KEY'])environment['REVIEW_'+suffix]=environment['VISION_'+suffix];
 const graph=section('图谱',true);
 if(graph){
  environment.NEO4J_HTTP_URL=endpoint(text(graph,'图谱','HTTP地址'),'图谱HTTP地址');
  environment.NEO4J_USERNAME=text(graph,'图谱','用户名');environment.NEO4J_PASSWORD=text(graph,'图谱','密码');
  if(Boolean(environment.NEO4J_USERNAME)!==Boolean(environment.NEO4J_PASSWORD))throw Error('图谱用户名和密码必须成对配置。');
 }
 const search=section('检索',true);
 if(search){environment.BOCHA_SEARCH_URL=endpoint(text(search,'检索','API地址'),'检索API地址');environment.BOCHA_API_KEY=text(search,'检索','API密钥');}
 return environment;
}
