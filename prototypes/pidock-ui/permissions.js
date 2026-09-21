/* THROWAWAY — session permission selection; no runtime or OS sandbox. */
const permissionModes=[
  {id:'read',name:'只读',icon:'book',description:'阅读任务文件、分析和回答问题；不修改文件，不执行命令或浏览器操作。'},
  {id:'default',name:'默认权限',icon:'shield',description:'允许任务内文件读写；执行命令或操作浏览器前询问。'},
  {id:'auto',name:'自动执行',icon:'play',description:'允许任务内文件读写、命令和浏览器操作，无需逐次询问。'}
];
function sessionPermission(t=task(),index=t?.session){return t?.permissionsBySession?.[index]||(index===1?'read':'default')}
function sessionReadonly(t=task(),index=t?.session){return sessionPermission(t,index)==='read'}
function permissionDetail(){return permissionModes.find(mode=>mode.id===sessionPermission())}
function permissionControl(){const mode=permissionDetail();return `<button class="permission-trigger ${mode.id==='auto'?'automatic':''}" data-action="permissions" aria-label="选择权限：${mode.name}" aria-haspopup="dialog" aria-expanded="false" title="当前会话权限">${icon(mode.icon)}<span>${mode.name}</span>${icon('down')}</button>`}
function permissionDialog(){
  composerPopover('permissions','会话权限',`<p class="popover-help">${esc(task().sessions[task().session])} · 仅当前会话</p><div class="permission-options">${permissionModes.map(mode=>`<button class="picker-choice permission-choice" data-action="set-permission:${mode.id}" aria-pressed="${sessionPermission()===mode.id}">${icon(mode.icon)}<span class="permission-description"><strong>${mode.name}</strong><small>${mode.description}</small></span>${sessionPermission()===mode.id?icon('check'):''}</button>`).join('')}</div><div class="popover-footer"><p class="popover-help">所有档位均遵循任务范围与共享模板变更确认规则。选择用于后续请求，已启动的 Subagent 保留启动时权限。</p></div>`);
}
function permissionAction(action,value){
  if(action==='permissions'){permissionDialog();return true}
  if(action!=='set-permission')return false;
  if(!permissionModes.some(mode=>mode.id===value))return true;
  task().permissionsBySession??={};task().permissionsBySession[task().session]=value;
  closeComposerPopover();render();
  document.querySelector('[data-action="permissions"]')?.focus();
  toast('当前会话已选择'+permissionDetail().name+'，用于后续请求');
  return true;
}
