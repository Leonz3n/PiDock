/* THROWAWAY product closure: simulated execution only; no tools, timers or external writes. */
const closureLabels={idle:'空闲',running:'执行中',waiting:'等待确认',failed:'失败',done:'已完成',stopped:'已停止',expired:'确认已过期',rejected:'已拒绝'};
function execution(t=task(),i=t.session){
  t.executions??={};
  if(!t.executions[i]){const run=state.scheduleRuns?.find(r=>r.taskIndex===state.tasks.indexOf(t)&&r.sessionIndex===i);t.executions[i]={status:run?({'待确认':'waiting','失败':'failed','成功':'done','运行中':'running'}[run.status]||'idle'):'idle',updated:run?.started||'尚无新活动',unread:!!run,stage:run?.status==='失败'?'通知步骤失败；摘要已生成':'',attempt:1};}
  return t.executions[i];
}
function executionMeta(t,i){const e=execution(t,i);return `${closureLabels[e.status]} · ${e.updated}${e.unread?' · 未读':''}`}
function setExecution(status){const e=execution();e.status=status;e.attentionDismissed=false;e.updated='刚刚';e.unread=status==='done'||status==='failed'||status==='waiting';const r=state.scheduleRuns?.find(r=>r.taskIndex===state.task&&r.sessionIndex===task().session);if(r){r.status=status==='done'?'成功':closureLabels[status];r.detail=e.stage||closureLabels[status]}task().busySession=['running','waiting'].includes(status)?task().session:null;render()}
function executionPanel(){
  const t=task(),e=execution(),other=t.sessions.findIndex((_,i)=>i!==t.session&&['running','waiting'].includes(execution(t,i).status));
  const controls=e.status==='running'?button('停止执行','flow-stop','sm'):e.status==='waiting'?button('批准本次操作','flow-approve','sm primary')+button('拒绝','flow-reject','sm'):e.status==='failed'?button('检查并重试','flow-retry','sm'):e.status==='expired'?button('标记已处理','flow-dismiss','sm'):'';
  return `<section class="execution-panel" aria-label="会话执行状态"><div class="between"><strong>${closureLabels[e.status]}</strong><div class="flex">${controls}</div></div>${other>=0?`<p>「${esc(t.sessions[other])}」正在执行或等待确认；本会话可编辑草稿，待其结束后再执行。</p>`:''}${e.stage?`<p>${esc(e.stage)}</p>`:''}${e.status==='waiting'?`<div class="approval-preview"><strong>待批准：发送研发周报（模拟）</strong><p>目标：示例研发通知群 · 接收人：该群研发成员</p><p>内容：本次已生成的 Git 改动摘要与提交依据。批准仅授权本次发送，不自动授权未来执行。</p><small>到下次计划时间或等待满 24 小时（取较早者）失效；实际发送前重新核对目标与内容。过期后不发送。</small></div>`:''}${e.status==='failed'?'<small>已完成的步骤保留；外部发送结果不确定时须先核对送达情况。</small>':''}${e.status==='expired'?'<small>旧确认不可继续批准；后续周期可正常触发。需要发送旧结果时重新提出请求。</small>':''}<details class="execution-demo"><summary>原型演示状态</summary><div class="flex">${button('模拟执行中','flow-demo-running','sm')}${button('模拟等待确认','flow-demo-waiting','sm')}${button('模拟失败','flow-demo-failed','sm')}${button('模拟完成','flow-demo-done','sm')}${e.status==='waiting'?button('模拟确认过期','flow-demo-expired','sm'):''}</div><small>仅切换内存状态，不调用模型、Git 或消息工具。</small></details></section>`;
}
function attentionRows(){return state.tasks.flatMap((t,ti)=>t.cleaned||t.archived?[]:t.sessions.map((_,si)=>({t,ti,si,e:execution(t,si)}))).filter(r=>!r.e.attentionDismissed).filter(r=>r.e.status==='waiting'||r.e.status==='failed'||r.e.status==='expired'||r.e.status==='done'&&r.e.unread)}
function attentionDialog(){const rows=attentionRows();modal('需要处理',`<p class="page-intro">所有项目 · 等待确认、失败、确认过期及完成未读</p>${rows.map(r=>`<div class="management-row"><div><strong>${esc(r.t.name)} / ${esc(r.t.sessions[r.si])}</strong><small>${esc(scheduleProject(r.t.projectId)?.name||'项目')} · ${closureLabels[r.e.status]} · ${r.e.updated}</small></div>${button('打开会话',`flow-open:${r.ti}:${r.si}`,'sm')}</div>`).join('')||'<div class="empty">暂时没有需要处理的事项</div>'}`)}
function beginExecution(){
  const t=task(),e=execution();if(t.archived||t.cleaned){toast('请先恢复任务');return false}
  if(t.sessions.some((_,i)=>['running','waiting'].includes(execution(t,i).status))){toast('本任务有执行尚未结束；输入已保留，请先停止或处理确认');return false}
  e.stage='正在准备模型请求（模拟）';return true;
}
function retryDialog(){modal('检查重试范围','<p>保留已经完成的摘要与工具结果，仅重试失败步骤。</p><div class="formfield"><label for="retry-outcome">上一次外部操作的结果</label><select id="retry-outcome"><option value="unknown">尚未核对</option><option value="not-sent">已核对：没有送达 / 请求未发出</option><option value="sent">已核对：已经成功，不应重复</option></select></div><p class="page-intro">不确定时先核对工具记录或接收方，不直接重发。</p>',button('继续','flow-retry-confirm','primary'))}
function cleanupDialog(index){const t=state.tasks[index];modal('清理任务资源',`<h3>${esc(t.name)}</h3><p class="inline-notice">示例：存在未交付代码。首版保留代码副本后才可解除任务登记；本页不删除磁盘文件。</p><div class="formfield"><label for="cleanup-code">任务代码</label><select id="cleanup-code"><option>保留代码与未提交修改到独立副本</option></select></div><label class="check-row"><input id="cleanup-history" type="checkbox" checked> 导出会话、草稿与用量记录</label><p>停止受管理进程，清理任务 worktree 登记与受管理链接、浏览器登录状态和终端状态。普通目录的原始目标始终保留。</p><p>全部保留步骤成功后才解除项目关联；任何一步失败，保留原任务并可重试。</p>`,button('预览清理清单','flow-cleanup-preview:'+index,'primary'))}
function cleanupPreview(index){const history=document.querySelector('#cleanup-history').checked;modal('确认清理清单',`<p>保留：任务代码与未交付修改、普通目录原始文件${history?'、导出的会话／草稿／用量':''}。</p><p>移除：任务登记、任务内链接、受管理工作副本、浏览器登录与终端状态${history?'':'、会话／草稿／用量记录'}。</p><p>这里只模拟保留成功与解除登记，不操作真实文件。</p>`,button('模拟完成清理',`flow-cleanup-confirm:${index}:${history?'keep':'drop'}`,'primary'))}
function effectiveConfigDialog(){
  const t=task();if(!t){toast('请先选择任务');return}
  modal('查看生效配置',`<p>${esc(t.name)} · ${esc(t.env)} · 任务模板 ${esc(t.version)}</p><div class="formfield"><label for="effective-service">服务</label><select id="effective-service">${t.services.map((s,i)=>`<option value="${i}">${esc(s.name)}</option>`).join('')}</select></div><div id="effective-config-rows"></div><p class="note">示例解析，仅展示已保存的应用配置；未保存草稿不参与。业务框架配置优先级与真实进程值需运行时核对。保存修改不代表运行中进程已加载，需显式重启受影响服务。</p>`);renderEffectiveConfig();
}
function renderEffectiveConfig(){
  const t=task(),service=t.services[+document.querySelector('#effective-service').value];
  const resolved=new Map(environmentRows().map(([key,value])=>[key,{value,source:'仓库默认配置 · 示例'}]));
  for(const scope of ['shared','private','task']){const key=[t.projectId,t.envId,scope,scope==='task'?t.workspaceKey:''].join(':');const draft=environmentDrafts.get(key);for(const row of draft?.original||[])resolved.set(row.key,{value:row.value,source:{shared:'共享模板',private:'本机私有配置',task:'任务覆盖'}[scope]})}
  if(service?.port)resolved.set('PORT',{value:String(service.port),source:'运行时端口绑定 · 示例'});
  document.querySelector('#effective-config-rows').innerHTML=`<table class="table"><tr><th>KEY</th><th>最终值</th><th>来源</th></tr>${[...resolved].map(([key,r])=>`<tr><td>${esc(key)}</td><td>${sensitiveEnvKey(key)?'••••••（私有值）':esc(r.value)}</td><td>${esc(r.source)}</td></tr>`).join('')}</table>`;
}
function nextPreview(read){
  const kind=read('kind'),zone=read('timezone');let time=read('time'),days=kind==='weekly'?[+read('weekday')]:null;
  if(kind==='once')return read('date')+' '+time+'（请核对为未来时间）';
  if(kind==='cron'){const match=(read('cron')||'').match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/);if(!match)return '自定义表达式需正式解析器校验（原型未计算）';time=match[2].padStart(2,'0')+':'+match[1].padStart(2,'0');days=match[3]==='*'?null:match[3]==='1-5'?[1,2,3,4,5]:[+match[3]]}
  if(!time)return '请补全时间';
  const format=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}),start=Math.floor(Date.now()/60000)*60000+60000;
  for(let n=0;n<8*24*60;n++){const values=Object.fromEntries(format.formatToParts(new Date(start+n*60000)).map(p=>[p.type,p.value]));if(values.hour+':'+values.minute===time&&(!days||days.includes(['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(values.weekday))))return `${values.year}-${values.month}-${values.day} ${time}`}
  return '时间无效或未来 8 天内无触发';
}
function schedulePreview(prefix){const read=id=>document.querySelector('#'+prefix+id)?.value;const kind=read('kind'),time=read('time'),zone=read('timezone'),cron=read('cron');let rule=kind==='weekly'?'每周'+['日','一','二','三','四','五','六'][+(read('weekday')||0)]+' '+time:kind==='daily'?'每天 '+time:kind==='once'?read('date')+' '+time:cron==='15 9 * * 1-5'?'每周一至周五 09:15':cron==='0 17 * * 1-5'?'每周一至周五 17:00':'自定义周期 '+(cron||'');return `${rule} · ${zone}。下次：${nextPreview(read)}。工作日指周一至周五，不自动调整法定节假日。`}
function updateSchedulePreview(){for(const prefix of ['task-schedule-','schedule-']){const kind=document.querySelector('#'+prefix+'kind');if(!kind)continue;let preview=document.querySelector('#'+prefix+'preview');if(!preview){preview=document.createElement('p');preview.className='note';preview.id=prefix+'preview';document.querySelector('#'+prefix+'rule-fields').after(preview)}preview.textContent=schedulePreview(prefix)}}
function decorateClosure(){
  if(state.view==='task'&&execution().status==='done')execution().unread=false;
  const sidebar=document.querySelector('.sidebar-bottom');if(sidebar)sidebar.insertAdjacentHTML('afterbegin',button('需要处理 '+attentionRows().length,'flow-attention','navbtn','clock'));
  if(state.view==='task'){const messages=document.querySelector('.messages');messages?.insertAdjacentHTML('beforebegin',executionPanel())}
  if(state.view==='env'){document.querySelector('.config-toolbar')?.insertAdjacentHTML('beforeend',button('查看生效配置','flow-effective','sm'))}
  if(state.view==='archive'&&state.cleanupReceipts?.length){document.querySelector('.page')?.insertAdjacentHTML('beforeend','<h2>清理回执</h2>'+state.cleanupReceipts.map(r=>`<div class="note">${esc(r.name)} · 已解除项目关联 · 代码保留${r.history?'，历史与用量已模拟导出':''} · 原型未写入磁盘</div>`).join(''))}
}
function closureAction(a,arg){
  if(a==='flow-dismiss'){execution().attentionDismissed=true;render();toast('已移出关注列表，执行记录保留')}
  if(a==='flow-attention')attentionDialog();
  if(a==='flow-open'){const [ti,si]=arg.split(':').map(Number);navigationTask(ti);task().session=si;execution().unread=false;closeModal();render()}
  if(a==='flow-stop'){execution().stage='已停止当前执行；历史、已完成步骤和输入草稿保留';setExecution('stopped')}
  if(a==='flow-approve'){if(execution().status!=='waiting')return;execution().stage='仅本次发送已获批准，正在模拟执行';setExecution('running')}
  if(a==='flow-reject'){execution().stage='已拒绝本次外部操作，未发送；后续周期不受影响';setExecution('rejected')}
  if(a==='flow-retry')retryDialog();
  if(a==='flow-retry-confirm'){const value=document.querySelector('#retry-outcome').value;if(value==='unknown'){toast('请先核对上一次操作结果');return}if(value==='sent'){closeModal();execution().stage='已核对上次操作成功，不重复执行';setExecution('done');return}if(!beginExecution())return;closeModal();execution().attempt++;execution().stage='仅重试失败步骤 · 第 '+execution().attempt+' 次尝试';setExecution('running')}
  if(a.startsWith('flow-demo-')){const status=a.slice(10);if(['running','waiting'].includes(status)&&task().sessions.some((_,i)=>i!==task().session&&['running','waiting'].includes(execution(task(),i).status))){toast('请先处理本任务其他执行');return}if(status==='failed'&&execution().input){task().draft=execution().input;task().refs=execution().refs||[]}execution().stage={running:'正在生成（模拟）',waiting:'摘要已生成，等待批准发送',failed:'请求失败；输入草稿保留，已完成步骤不重放',done:'本次执行完成，结果与工具记录保留',expired:'旧确认已失效，后续周期可以正常触发'}[status]||'';setExecution(status)}
  if(a==='flow-cleanup-preview')cleanupPreview(+arg);
  if(a==='flow-cleanup-confirm'){const [index,keep]=arg.split(':');const t=state.tasks[+index];state.cleanupReceipts??=[];state.cleanupReceipts.push({name:t.name,history:keep==='keep'});t.cleaned=true;t.archived=true;t.projectId=null;state.schedules=state.schedules.filter(s=>s.taskIndex!==+index);state.scheduleRuns=state.scheduleRuns.filter(r=>r.taskIndex!==+index);if(keep!=='keep'){t.messages=[];t.sessions=[];t.sessionData={}}closeModal();state.view='archive';render();toast('已模拟清理完成；未删除真实文件')}
  if(a==='flow-effective')effectiveConfigDialog();
}
document.addEventListener('click',event=>{
  const target=event.target.closest('[data-action]');if(!target)return;const [a,...parts]=target.dataset.action.split(':'),arg=parts.join(':');
  if(a.startsWith('flow-')){event.preventDefault();event.stopImmediatePropagation();closureAction(a,arg);return}
  if(a==='cleanup'){event.preventDefault();event.stopImmediatePropagation();cleanupDialog(+arg)}
  if(a==='run-schedule'){const s=state.schedules[+arg],t=state.tasks[s.taskIndex];if(t.archived||t.cleaned||t.sessions.some((_,i)=>['running','waiting'].includes(execution(t,i).status))){event.preventDefault();event.stopImmediatePropagation();toast(t.archived?'请先恢复任务，再显式启用调度':'上次执行尚未结束，请先处理确认或停止执行')}}
  if(a==='nav-task-confirm'){const t=state.tasks[+arg];t.sessions.forEach((_,i)=>{const e=execution(t,i);if(['running','waiting'].includes(e.status)){e.status='stopped';e.stage='任务归档，执行停止；未批准的操作不再执行'}const r=state.scheduleRuns.find(r=>r.taskIndex===+arg&&r.sessionIndex===i);if(r&&['运行中','待确认'].includes(r.status)){r.status='已停止';r.detail='任务归档'}});t.busySession=null}
},true);
document.addEventListener('change',event=>{if(event.target.id==='effective-service')renderEffectiveConfig();if(event.target.dataset.scheduleToggle!==undefined){const s=state.schedules[+event.target.dataset.scheduleToggle];if(state.tasks[s.taskIndex].archived){event.preventDefault();event.stopImmediatePropagation();event.target.checked=false;toast('请先恢复归档任务，再显式启用调度')}}},true);
document.addEventListener('change',()=>queueMicrotask(updateSchedulePreview));
document.addEventListener('input',()=>queueMicrotask(updateSchedulePreview));
document.addEventListener('click',()=>queueMicrotask(updateSchedulePreview));
