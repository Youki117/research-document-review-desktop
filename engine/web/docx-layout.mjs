import {posix} from 'node:path';

const children = node => (node?.elements || []).filter(n => n.type === 'element');
const child = (node,name) => children(node).find(n=>n.name===name);
const val = (node,name,key='w:val') => child(node,name)?.attributes?.[key];
const number = (value,scale=1) => Number.isFinite(Number(value)) ? Number(value)/scale : undefined;
function descendants(node,name,result=[]) { if(node?.name===name) result.push(node);for(const n of children(node))descendants(n,name,result);return result; }

function properties(node) {
  const style={};
  if(!node)return style;
  for(const [key,tag]of [['fontWeight','w:b'],['fontStyle','w:i']]) {
    const n=child(node,tag);if(n)style[key]=['0','false','off'].includes(n.attributes?.['w:val'])?'normal':key==='fontWeight'?'bold':'italic';
  }
  const size=number(val(node,'w:sz'),2);if(size>=6&&size<=72)style.fontSize=`${size}pt`;
  const font=child(node,'w:rFonts')?.attributes;
  if(font){const families=[...new Set([font['w:ascii'],font['w:eastAsia']].filter(f=>f&&/^[\p{L}\p{N} _-]{1,80}$/u.test(f)))];if(families.length)style.fontFamily=families.map(f=>`"${f}"`).join(',');}
  const color=val(node,'w:color');if(/^[\da-f]{6}$/i.test(color||''))style.color='#'+color;
  const align=val(node,'w:jc');if(['left','right','center','both','distribute'].includes(align))style.textAlign=align==='both'||align==='distribute'?'justify':align;
  const indent=child(node,'w:ind')?.attributes||{};
  for(const [key,attr]of [['paddingLeft','w:left'],['paddingRight','w:right'],['textIndent','w:firstLine']]) {
    const value=number(indent[attr],20);if(value!==undefined&&Math.abs(value)<=300)style[key]=`${value}pt`;
  }
  if(indent['w:hanging'])style.textIndent=`-${Math.min(100,number(indent['w:hanging'],20))}pt`;
  const spacing=child(node,'w:spacing')?.attributes||{};
  for(const [key,attr]of [['marginTop','w:before'],['marginBottom','w:after']])if(spacing[attr]!==undefined)style[key]=`${Math.min(80,number(spacing[attr],20))}pt`;
  if(spacing['w:line'])style.lineHeight=spacing['w:lineRule']==='exact'?`${Math.max(10,number(spacing['w:line'],20))}pt`:Math.max(1,Math.min(3,number(spacing['w:line'],240)));
  if(child(node,'w:pageBreakBefore'))style.breakBefore='page';
  return style;
}

export async function docxLayout(document,parseXml,paragraphRuns) {
  const root=document.parts.get('word/document.xml');
  const body=descendants(root,'w:body')[0];
  const styleMap=new Map();
  const stylesFile=document.archive.file('word/styles.xml');
  if(stylesFile)for(const n of descendants(parseXml(await stylesFile.async('string'),{compact:false}),'w:style'))styleMap.set(n.attributes?.['w:styleId'],n);
  const defaults=stylesFile?descendants(parseXml(await stylesFile.async('string'),{compact:false}),'w:docDefaults')[0]:null;
  function inherited(id,seen=new Set()) {
    if(!id||seen.has(id))return {};seen.add(id);const n=styleMap.get(id);
    return {...inherited(val(n,'w:basedOn'),seen),...properties(child(n,'w:pPr')),...properties(child(n,'w:rPr'))};
  }
  const relFile=document.archive.file('word/_rels/document.xml.rels');
  const rels=new Map();
  if(relFile)for(const n of descendants(parseXml(await relFile.async('string'),{compact:false}),'Relationship'))if(n.attributes?.TargetMode!=='External')rels.set(n.attributes.Id,n.attributes.Target);
  const paragraphIds=new Map(document.paragraphs.map((p,i)=>[p.paragraph,`p-${i}`]));
  const formats={};const images={};let imageBytes=0;
  for(const p of document.paragraphs) {
    const pPr=child(p.paragraph,'w:pPr');
    const style={...properties(descendants(defaults,'w:pPr')[0]),...inherited(val(pPr,'w:pStyle')),...properties(pPr)};
    const runStyles=[];
    for(const run of descendants(p.paragraph,'w:r')) {
      const rPr=child(run,'w:rPr');
      runStyles.push({text:paragraphRuns(run).map(r=>r.text).join(''),style:{...properties(descendants(defaults,'w:rPr')[0]),...inherited(val(rPr,'w:rStyle')),...properties(rPr)}});
    }
    const media=[];
    for(const drawing of descendants(p.paragraph,'w:drawing')) {
      const blip=descendants(drawing,'a:blip')[0],target=rels.get(blip?.attributes?.['r:embed']);
      if(!target)continue;
      const path=posix.normalize(posix.join('word',target));
      if(!path.startsWith('word/'))continue;
      const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif'}[posix.extname(path).toLowerCase()];
      const file=document.archive.file(path);if(!file||!mime)continue;
      if(!images[path]){
        const size=file._data?.uncompressedSize;
        if(size>8*1024*1024||imageBytes+(size||0)>20*1024*1024)continue;
        const data=await file.async('nodebuffer');if(data.length>8*1024*1024||imageBytes+data.length>20*1024*1024)continue;
        imageBytes+=data.length;images[path]=`data:${mime};base64,${data.toString('base64')}`;
      }
      const extent=descendants(drawing,'wp:extent')[0]?.attributes||{};
      media.push({source:path,width:Math.min(1000,number(extent.cx,9525)||600),height:Math.min(1600,number(extent.cy,9525)||400)});
    }
    formats[paragraphIds.get(p.paragraph)]={style,run_styles:runStyles,images:media};
  }
  function blocks(node) {
    const result=[];
    for(const n of children(node)) {
      if(n.name==='w:p'){result.push({type:'paragraph',id:paragraphIds.get(n)});}
      else if(n.name==='w:tbl') {
        const rows=[];
        for(const tr of children(n).filter(x=>x.name==='w:tr')) {
          const cells=[];
          for(const tc of children(tr).filter(x=>x.name==='w:tc')) {
            const pr=child(tc,'w:tcPr'),merge=child(pr,'w:vMerge');
            const span=Math.min(100,Math.max(1,Number(val(pr,'w:gridSpan'))||1));
            if(merge&&merge.attributes?.['w:val']!=='restart'){
              const column=cells.reduce((sum,c)=>sum+c.colspan,0);
              let found=false;
              for(let r=rows.length-1;r>=0&&!found;r--){let col=0;for(const cell of rows[r]){if(col===column&&cell.rowspan>=rows.length-r){cell.rowspan++;found=true;break;}col+=cell.colspan;}}
              cells.push({type:'continuation',colspan:span});continue;
            }
            cells.push({colspan:span,rowspan:1,blocks:blocks(tc)});
          }
          rows.push(cells);
        }
        result.push({type:'table',rows});
      }else if(['w:sdt','w:sdtContent','w:customXml'].includes(n.name))result.push(...blocks(n));
    }
    return result;
  }
  const sect=descendants(body,'w:sectPr').at(-1);
  return {blocks:blocks(body),formats,images,page_width_pt:number(val(sect,'w:pgSz','w:w'),20)||595};
}
