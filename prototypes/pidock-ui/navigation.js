/* THROWAWAY: bounded session tabs, searchable history, task/session context menus. */
function sessionNavigation(){
  const t=task(),active=t.sessions.map((_,i)=>i).filter(i=>!t.archivedSessions.includes(i));
  let visible=active.slice(0,4);
  if(!visible.includes(t.session))visible=[...visible.slice(0,3),t.session].sort((a,b)=>a-b);
  return `<div class="sessions compact-sessions"><button class="btn sm" data-action="nav-sessions">全部会话 ${t.sessions.length} ${icon('down')}</button><div class="session-tabs">${visible.map(i=>`<button class="session-tab ${t.session===i?'active':''}" data-action="session:${i}" title="${esc(t.sessions[i])} · 右键操作">${esc(t.sessions[i])}${t.archivedSessions.includes(i)?'<span class="badge">已归档</span>':sessionReadonly(t,i)?'<span class="badge">只读</span>':''}</button>`).join('')}</div><button class="iconbtn" data-action="newsession" aria-label="新建会话">${icon('plus')}</button></div>`;
}
function sessionListDialog(filter='active'){
  const t=task();
  modal('全部会话',`<div class="formfield"><label for="session-search">搜索会话</label><input id="session-search" placeholder="按会话名称查找"></div><div class="segmented"><button data-action="nav-filter:active" class="${filter==='active'?'active':''}">未归档 ${t.sessions.length-t.archivedSessions.length}</button><button data-action="nav-filter:archived" class="${filter==='archived'?'active':''}">已归档 ${t.archivedSessions.length}</button></div><p class="page-intro">归档保留历史和草稿。打开可继续对话，恢复后重新加入未归档列表。</p><div class="session-results">${t.sessions.map((name,i)=>t.archivedSessions.includes(i)===(filter==='archived')?`<div class="session-result" data-session-search="${esc(name.toLowerCase())}"><button data-action="nav-open:${i}"><strong>${esc(name)}</strong><small>${i===t.session?'当前会话 · ':''}${t.archivedSessions.includes(i)?'已归档':'未归档'} · ${sessionPermission(t,i)==='read'?'只读':'可对话'} · ${executionMeta(t,i)}</small></button><button class="iconbtn" data-action="nav-session-menu:${i}" aria-label="会话操作：${esc(name)}">${icon('more')}</button></div>`:'').join('')}<div class="empty session-no-results" hidden>没有匹配的会话</div></div>`);
  updateSessionSearch();document.querySelector('#session-search').focus();
}
function updateSessionSearch(){const query=document.querySelector('#session-search')?.value.trim().toLowerCase()||'';let count=0;document.querySelectorAll('[data-session-search]').forEach(row=>{row.hidden=!row.dataset.sessionSearch.includes(query);if(!row.hidden)count++});const empty=document.querySelector('.session-no-results');if(empty)empty.hidden=count>0}
let navigationMenuOrigin=null;
function dismissNavigationMenu(restore=false){document.querySelector('#navigation-menu')?.remove();if(restore&&navigationMenuOrigin?.isConnected)navigationMenuOrigin.focus()}
function navigationMenu(kind,index,origin,x,y){
  dismissNavigationMenu();navigationMenuOrigin=origin;
  const t=kind==='task'?state.tasks[index]:task();
  const items=kind==='task'?[['打开任务',`nav-task-open:${index}`],['重命名',`nav-task-rename:${index}`],['新建会话',`nav-task-new:${index}`],['查看全部会话',`nav-task-sessions:${index}`],['归档任务…',`nav-task-archive:${index}`]]:[['打开会话',`nav-open:${index}`],['重命名',`nav-session-rename:${index}`],['新建会话','nav-new'],[t.archivedSessions.includes(index)?'恢复会话':'归档会话',`${t.archivedSessions.includes(index)?'nav-restore':'nav-archive'}:${index}`]];
  const menu=document.createElement('div');menu.id='navigation-menu';menu.className='navigation-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label',kind==='task'?'任务菜单':'会话菜单');menu.innerHTML=items.map(([label,action])=>`<button role="menuitem" data-action="${action}">${label}</button>`).join('');document.body.append(menu);
  const rect=origin.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(x??rect.left,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(y??rect.bottom,innerHeight-menu.offsetHeight-8))+'px';menu.querySelector('button').focus();
}
function navigationTask(index){state.task=index;state.projectId=task().projectId;state.envId=task().envId;state.env=task().env;state.view='task'}
function navigationAction(action,arg,origin){
  const i=+arg;
  if(action==='nav-sessions'||action==='nav-filter'){sessionListDialog(arg||'active');return}
  if(action==='nav-session-menu'){navigationMenu('session',i,origin);return}
  dismissNavigationMenu();
  if(action==='nav-open'){task().session=i;closeModal();render()}
  if(action==='nav-new'){closeModal();dispatch('newsession')}
  if(action==='nav-archive'){
    const t=task();if(['running','waiting'].includes(execution(t,i).status)){toast('请先停止会话执行，再归档');return}
    if(!t.archivedSessions.includes(i))t.archivedSessions.push(i);
    if(t.session===i){const next=t.sessions.findIndex((_,n)=>!t.archivedSessions.includes(n));if(next>=0)t.session=next}
    closeModal();render();toast('会话已归档，可在全部会话中查看或恢复');
  }
  if(action==='nav-restore'){task().archivedSessions=task().archivedSessions.filter(n=>n!==i);task().session=i;closeModal();render();toast('会话已恢复')}
  if(action==='nav-task-open'){navigationTask(i);render()}
  if(action==='nav-task-new'){navigationTask(i);dispatch('newsession')}
  if(action==='nav-task-sessions'){navigationTask(i);render();sessionListDialog()}
  if(action==='nav-task-archive'){const t=state.tasks[i];modal('归档任务',`<p>归档「${esc(t.name)}」将停止本任务的运行并保留代码、会话与草稿。${t.taskType==='scheduled'?'同时暂停后续定时触发。':''}</p>`,button('归档任务','nav-task-confirm:'+i,'primary'))}
  if(action==='nav-task-confirm'){const t=state.tasks[i];t.archived=true;t.services.forEach(s=>s.running=false);const s=state.schedules?.find(s=>s.id===t.scheduleId);if(s){s.enabled=false;s.next='已暂停'}closeModal();state.view='archive';render();toast('已模拟归档任务，历史保留')}
  if(action==='nav-task-rename'||action==='nav-session-rename'){const kind=action==='nav-task-rename'?'task':'session',name=kind==='task'?state.tasks[i].name:task().sessions[i];modal('重命名'+(kind==='task'?'任务':'会话'),`<div class="formfield"><label for="navigation-name">名称</label><input id="navigation-name" value="${esc(name)}"></div>`,button('保存',`nav-save-${kind}:${i}`,'primary'));document.querySelector('#navigation-name').focus()}
  if(action==='nav-save-task'||action==='nav-save-session'){const name=document.querySelector('#navigation-name').value.trim();if(!name){toast('请输入名称');return}if(action==='nav-save-task'){state.tasks[i].name=name;const s=state.schedules?.find(s=>s.id===state.tasks[i].scheduleId);if(s)s.name=name}else task().sessions[i]=name;closeModal();render()}
}
document.addEventListener('click',event=>{const origin=event.target.closest('[data-action]');if(origin?.dataset.action==='taskmenu'){event.preventDefault();event.stopImmediatePropagation();navigationMenu('task',state.task,origin);return}if(origin?.dataset.action.startsWith('nav-')){event.preventDefault();event.stopImmediatePropagation();const [action,...args]=origin.dataset.action.split(':');navigationAction(action,args.join(':'),origin)}else dismissNavigationMenu()},true);
document.addEventListener('contextmenu',event=>{const origin=event.target.closest('.tasknav,.session-tab');if(!origin)return;event.preventDefault();const [kind,index]=origin.dataset.action.split(':');navigationMenu(kind,+index,origin,event.clientX,event.clientY)});
document.addEventListener('input',event=>{if(event.target.id==='session-search')updateSessionSearch()});
document.addEventListener('keydown',event=>{
  const menu=document.querySelector('#navigation-menu');
  if(menu){if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();dismissNavigationMenu(true)}else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();const items=[...menu.querySelectorAll('button')],i=items.indexOf(document.activeElement);items[event.key==='Home'?0:event.key==='End'?items.length-1:(i+(event.key==='ArrowDown'?1:items.length-1))%items.length].focus()}else if(event.key==='Tab')dismissNavigationMenu();return}
  const origin=event.target.closest('.tasknav,.session-tab');if(origin&&(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')){event.preventDefault();event.stopImmediatePropagation();const [kind,index]=origin.dataset.action.split(':');navigationMenu(kind,+index,origin)}
},true);
