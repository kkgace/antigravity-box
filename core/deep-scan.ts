// Ported from Enzoo404/gravitybox (MIT License) v1.1.2 — https://github.com/Enzoo404/gravitybox
// Windows adaptation: AntigravityBox project.
import type { PluginCatalog } from './plugin-catalog.js';
import { bt } from './i18n.js';
export const DEEP_STEPS = [
  {id:'model-open',name:'模型菜单'}, {id:'model-usage',name:'用量子菜单'}, {id:'model-close',name:'关闭模型菜单'},
  {id:'history',name:'历史列表'}, {id:'marketplace',name:'插件市场'}, {id:'installed',name:'已安装插件'},
  {id:'settings-open',name:'打开设置'}, {id:'settings-general',name:'通用设置'}, {id:'settings-app',name:'应用设置'},
  {id:'settings-appearance',name:'外观设置'}, {id:'settings-models',name:'模型与用量'}, {id:'settings-shortcuts',name:'快捷键'},
  {id:'settings-close',name:'关闭设置'}, {id:'automations',name:'自动化列表'}
] as const;
export type DeepStep = { id:string;name:string;state:'visited'|'limited'|'unavailable'|'manual'|'failed';message:string; samples:number };
export type NativeMenus = { state:'read'|'partial'|'permission-required'|'unavailable';labels:string[];unmatched:number;message:string };
export type DeepReport = { schema:1;scope?:'metadata'|'navigation';startedAt:string;finishedAt?:string;state:'running'|'complete'|'partial'|'cancelled'|'failed';steps:DeepStep[];plugins:PluginCatalog;nativeMenus:NativeMenus;restoration?:{routeRestored:boolean;editorsMatch:boolean;scrollRestored:number;userIntervened:boolean;message:string};notes:string[] };
export interface DeepPage {
  invoke(method:string,...args:unknown[]):Promise<any>;
}
export async function traverseDeep(page:DeepPage, signal:AbortSignal, onSample:(view:any)=>Promise<void>, onStep:(step:DeepStep,index:number)=>void,onRestored:(value:any)=>void=()=>{}) {
  const steps:DeepStep[]=[];let restoration:any;
  const ready=await page.invoke('begin');if(!ready?.ok)throw new Error(ready?.message??bt('deep_scan.err.begin_failed'));
  try {
    for(const [index,step]of DEEP_STEPS.entries()) {
      signal.throwIfAborted();const result=await page.invoke('step',step.id);signal.throwIfAborted();
      if(result?.userIntervened)throw new Error(bt('deep_scan.err.user_intervened'));
      const row:DeepStep={...step,name:bt(`deep_scan.step.${step.id}`,undefined,step.name),state:result?.limited?'limited':result?.ok?'visited':'unavailable',message:result?.message??bt('deep_scan.msg.entry_unavailable'),samples:0};
      if(result?.ok){
        for(let scroll=0;scroll<12;scroll++){
          signal.throwIfAborted();const view=await page.invoke('sample');if(view?.userIntervened)throw new Error(bt('deep_scan.err.user_intervened'));await onSample(view);row.samples++;
          if(!['marketplace','installed','history','settings-general','settings-app','settings-appearance','settings-shortcuts','model-usage'].includes(step.id))break;
          const moved=await page.invoke('scroll');if(moved?.userIntervened)throw new Error(bt('deep_scan.err.user_intervened'));if(!moved?.more)break;
          if(scroll===11){row.state='limited';row.message=bt('deep_scan.msg.scroll_limit');}
        }
      }
      steps.push(row);onStep(row,index+1);
    }
    steps.push({id:'conditional',name:bt('deep_scan.step.conditional'),state:'manual',message:bt('deep_scan.msg.conditional_manual'),samples:0});
  } finally { restoration=await page.invoke('finish').catch(()=>({routeRestored:false,editorsMatch:false,scrollRestored:0,userIntervened:false,message:bt('deep_scan.msg.finish_timeout')}));onRestored(restoration); }
  return {steps,restoration};
}
export function sanitizeNativeMenus(data:any, allowed:Set<string>):NativeMenus {
  const states=['read','partial','permission-required','unavailable'];
  if(!states.includes(data?.state))return{state:'unavailable',labels:[],unmatched:0,message:bt('deep_scan.menu.unread')};
  const labels=['read','partial'].includes(data.state)?[...new Set<string>((Array.isArray(data.labels)?data.labels:[]).filter((v:unknown)=>typeof v==='string'&&v.length<=200&&allowed.has(v)).slice(0,400))]:[];
  return{state:data.state,labels,unmatched:Math.max(0,Math.min(10000,Number(data.unmatched)||0)),message:({read:bt('deep_scan.menu.read'),partial:bt('deep_scan.menu.partial'),'permission-required':bt('deep_scan.menu.permission_required'),unavailable:bt('deep_scan.menu.unavailable')})[data.state as NativeMenus['state']]};
}
export function deepMarkdown(report:DeepReport){
 const lines=[bt('deep_scan.md.title'),'',bt('deep_scan.md.started',{startedAt:report.startedAt}),bt('deep_scan.md.finished',{finishedAt:report.finishedAt??bt('deep_scan.md.in_progress')}),bt('deep_scan.md.status',{state:report.state}),'',bt('deep_scan.md.plugins_summary',{entries:report.plugins.entries.length,files:report.plugins.inspectedFiles}), bt('deep_scan.md.menus_summary',{message:report.nativeMenus.message,count:report.nativeMenus.labels.length}),'',bt('deep_scan.md.section_steps'),'', bt('deep_scan.md.table_header'),'| --- | --- | ---: | --- |'];
 const esc=(s:string)=>s.replace(/\\/g,'\\\\').replace(/[\[\]<>!*`_{}()#|]/g,'\\$&').replace(/\n/g,' ');for(const row of report.steps)lines.push(`| ${row.name} | ${row.state} | ${row.samples} | ${esc(row.message)} |`);
 lines.push('',bt('deep_scan.md.section_restoration'),'',report.restoration?.message??bt('deep_scan.md.restoration_unconfirmed'),'',bt('deep_scan.md.section_plugins'),'');
 for(const item of report.plugins.entries)lines.push(`### ${esc(item.name)}`,'',esc(item.description),bt('deep_scan.md.plugin_source',{source:item.source,state:item.truncated?bt('deep_scan.md.plugin_truncated'):bt('deep_scan.md.plugin_read')}),'');
 lines.push(bt('deep_scan.md.section_menus'),'',...report.nativeMenus.labels.map(v=>'- '+esc(v)),'',bt('deep_scan.md.section_notes'),'',...report.notes.map(v=>'- '+v));return lines.join('\n')+'\n';
}
