/* THROWAWAY: Apple functional review. Reuses the existing memory-only prototype.
 * References: GitHub #1 (current spec, including #95), product-design-closure.
 * No Host, model, process, Git, network or filesystem execution is connected.
 */
state.variant = 'A';
toolItems.splice(toolItems.findIndex(item => item[0] === 'terminal'), 1);
state.tasks.forEach(t => { t.openTools = []; t.activeTool = null; });
state.remote.permissions.terminal = false;

const appleBaseRender = render;
const appleBaseDispatch = dispatch;
const appleBaseModal = modal;
const appleBaseFiles = filesView;
const appleBaseComposer = composer;
const appleBasePermission = remotePermission;
const appleBaseSubagents = sessionSubagentList;
const appleBaseConversation = conversation;
const appleBaseLogs = logsView;
const appleInitialTasks = new Set(state.tasks);
let appleSidebarOpen = false;
sessionSubagentList = function() {
  const agents=sessionSubagents();
  if (!agents.length) return '';
  return `<details class="apple-subagent-summary"><summary>Subagent <span class="badge">${agents.length}</span><small>${agents.filter(a=>a.status==='running').length} 个运行中 · 示例</small></summary>${appleBaseSubagents()}</details>`;
};
conversation = function() {
  const html=appleBaseConversation(), t=task();
  if (appleInitialTasks.has(t) && t.session===0) return html;
  const template=document.createElement('template');
  template.innerHTML=html;
  const messages=template.content.querySelector('.messages');
  if (messages) {
    const ownMessages=t.messages.filter(m=>m.session===t.session);
    const review=appleInitialTasks.has(t)&&t.session===1;
    messages.innerHTML=`${review?'<div class="message"><div class="message-head"><span class="brandmark">π</span><strong>Pi</strong><small>代码审查 · 示例历史</small></div><div class="agentbody"><p>当前会话从代码审查开始。请重点检查账号缺失时的回退逻辑，以及新增验证是否覆盖该分支。</p><p>文件和服务沿用当前任务；此会话使用独立上下文与只读权限。</p></div></div>':!ownMessages.length?'<div class="apple-empty-conversation"><span class="brandmark">π</span><h2>从这个会话开始</h2><p>描述目标，引用文件，或选择一个技能。<br>同任务会话共享代码与服务，对话上下文分别保留。</p></div>':''}${ownMessages.map(m=>`<div class="message"><div class="message-head"><span class="${m.role==='user'?'avatar':'brandmark'}">${m.role==='user'?'你':'π'}</span><strong>${m.role==='user'?'你':'Pi'}</strong><small>刚刚 · 模拟</small></div><div class="${m.role==='user'?'userbubble':'agentbody'}"><p>${esc(m.text).replaceAll('\n','<br>')}</p>${messageAttachments(m)}</div></div>`).join('')}`;
  }
  return template.innerHTML;
};

const appleWindow = document.createElement('header');
appleWindow.className = 'apple-windowbar';
appleWindow.innerHTML = `<span class="apple-traffic" aria-hidden="true"><i></i><i></i><i></i></span><button class="iconbtn" data-action="apple-sidebar" aria-label="显示或隐藏项目与任务导航" title="项目与任务导航">${icon('grid')}</button><span class="apple-window-name">PiDock</span><span class="apple-window-context">Apple · 功能评审版</span><div class="apple-window-actions"><small>页面内存演示</small><button class="btn sm" data-action="apple-map">功能地图</button></div>`;
document.body.prepend(appleWindow);
const appleNavShade = document.createElement('button');
appleNavShade.className = 'apple-nav-shade';
appleNavShade.dataset.action = 'apple-sidebar';
appleNavShade.setAttribute('aria-label', '关闭项目与任务导航');
document.body.append(appleNavShade);
const appleFooter = document.createElement('footer');
appleFooter.className = 'apple-reviewbar';
appleFooter.innerHTML = '<strong>Apple 功能评审版</strong><span class="reviewbar-description">模拟数据 · 刷新重置</span><div class="reviewbar-actions"><a href="redesign.html?variant=A">视觉稿</a><button class="btn" data-action="apple-guide">评审导览</button><button class="btn" data-action="apple-map">功能地图</button></div>';
document.body.append(appleFooter);

function appleCleanLegacyCopy(html) {
  return html.replaceAll('和终端状态', '及浏览器缓存').replaceAll('与终端状态', '与缓存')
    .replaceAll('、终端、', '、').replaceAll('终端／', '').replaceAll('／终端', '');
}
modal = function(title, body, footer) {
  appleBaseModal(title, appleCleanLegacyCopy(body), footer);
  const node = document.querySelector('.modal');
  node?.setAttribute('role', 'dialog');
  node?.setAttribute('aria-modal', 'true');
  node?.setAttribute('aria-label', title);
};
remotePermission = function(key, title, detail) {
  return key === 'terminal' ? '' : appleBasePermission(key, title, detail);
};
// No external QR library: keep pairing explicitly at the UI-review stage.
drawPairingQr = function() {
  const target = document.querySelector('#pair-qr');
  if (target) target.innerHTML = '<div class="qr-fallback">配对二维码占位<br><small>仅评审设备确认流程<br>不创建真实配对链接</small></div>';
  const link = document.querySelector('.pair-link');
  if (link) { link.removeAttribute('href'); link.textContent = '示例短时配对入口 · 不连接远程设备'; }
};

composer = function() {
  return appleBaseComposer().replace('<div class="compose-actions">', `<div class="apple-symbols"><button data-action="symbol:@" aria-label="引用文件或目录" title="引用文件或目录">@</button><button data-action="symbol:$" aria-label="调用技能" title="调用技能">$</button><button data-action="symbol:/" aria-label="打开斜杠命令" title="斜杠命令">/</button></div><div class="compose-actions">`);
};

function applePages(t = task()) {
  t.appleBrowser ??= {
    active: 0, sequence: 2, marking: false, selected: '', revision: 1,
    pages: [{ id: 1, title: '对账单详情', path: '/bills/10023', url: `http://127.0.0.1:${t.services[0]?.port || 5173}/bills/10023` }],
  };
  return t.appleBrowser;
}
browserView = function() {
  const t = task(), b = applePages(), page = b.pages[b.active];
  const owned = t.owner === 'human';
  return `<div class="panel-heading"><strong>任务浏览器</strong><span class="badge">独立登录状态</span></div>
    <div class="browser-owner"><span class="flex"><span class="dot live"></span>${b.marking ? '标记中 · 页面操作已暂停（模拟）' : owned ? '人工接管 · Agent 已暂停' : 'Agent 可控制 · 当前空闲'}</span>${button(owned ? '交还 Agent' : '接管浏览器', 'apple-takeover', 'sm')}</div>
    <div class="apple-browser-tabs" aria-label="任务页面">${b.pages.map((p,i) => `<div class="apple-browser-tab ${i===b.active?'active':''}"><button data-action="apple-page:${i}" aria-current="${i===b.active?'page':'false'}">${esc(p.title)}</button><button class="close-page" data-action="apple-close-page:${i}" aria-label="关闭页面：${esc(p.title)}">×</button></div>`).join('')}<button class="iconbtn" data-action="apple-new-page" aria-label="新建浏览器页面">${icon('plus')}</button></div>
    ${page ? `<div class="browser-shell"><div class="browser-toolbar"><button class="iconbtn" data-action="apple-refresh" aria-label="刷新模拟页面">${icon('refresh')}</button><div class="urlbar">${icon('shield')} ${esc(page.url)}</div></div>
      <div class="browser-content"><div class="mock-appnav between"><span>ATLAS / 财务中心</span><span>示例页面</span></div><div class="invoice"><div class="between"><h3>${esc(page.title)}</h3><span class="badge live">示例快照</span></div><div class="kv"><span>对账单号</span><span>BILL-2026-10023</span></div><button class="apple-page-target ${b.marking?'markable':''} ${b.selected==='tracking'?'selected':''}" data-action="apple-mark-target:tracking"><span>运单号</span><strong>SF142857001</strong></button><button class="apple-page-target ${b.marking?'markable':''} ${b.selected==='amount'?'selected':''}" data-action="apple-mark-target:amount"><span>本期应付金额</span><strong>¥ 12,480.00</strong></button></div></div></div>
      <div class="apple-mark-toolbar"><span>${b.marking?'点选上面的字段，补充说明':'查看页面，或标记问题交给当前会话'}</span><div class="flex">${button(b.marking?'取消标记':'标记问题', 'apple-mark', 'sm')}${button('查看页面证据', 'apple-evidence', 'sm')}</div></div>
      ${b.selected ? `<div class="apple-selection-note">已选中：${b.selected==='tracking'?'运单号':'本期应付金额'}<br>页面 #${page.id} · 快照版本 ${b.revision} · ${esc(t.name)}<br>${button('填写说明并引用', 'apple-annotation', 'sm primary')}</div>` : ''}
      <div class="snapshot"><div>${t.verified?'✓ 模拟验证通过':'○ 等待本次页面验证'}</div><div class="mono">任务 ${esc(t.workspaceKey || t.slug)} · 页面 #${page.id} · 快照 ${b.revision}</div><div>同任务页面共享示例登录状态；不同任务分别保留。</div></div>
      <div class="toolbar-space">${button(t.verified?'重新模拟验证':'模拟页面验证','apple-verify','sm','play')}</div>` : `<div class="empty-browser">当前任务没有打开的页面<br><br>${button('打开示例页面','apple-new-page','primary','plus')}</div>`}
    <div class="note">当前为 HTML 页面示意。点选、快照、网络记录与登录隔离均用于评审，不代表真实浏览器能力已接入。</div>`;
};

filesView = function() {
  const base = appleBaseFiles();
  return `<div class="apple-file-actions">${button('在外部编辑器打开','apple-editor','sm','code')}${button('工作区与来源','apple-sources','sm','folder')}</div>` + base;
};
logsView = function() {
  const t=task();
  t.appleLogService ??= 'all';
  return `<div class="formfield"><label for="apple-log-service">按服务筛选</label><select id="apple-log-service"><option value="all">全部本地服务</option>${t.services.filter(s=>s.mode==='本地').map(s=>`<option value="${esc(s.name)}" ${t.appleLogService===s.name?'selected':''}>${esc(s.name)}</option>`).join('')}</select></div>` + (t.appleLogService==='all' ? appleBaseLogs() : `<div class="panel-heading"><strong>${esc(t.appleLogService)} · 日志</strong><span class="badge">示例记录</span></div><div class="logline">[${esc(t.appleLogService)}] request GET /api/bills/10023</div><div class="logline">[${esc(t.appleLogService)}] response 200 · 24ms</div><div class="note">只筛选示例内存日志，不读取真实进程输出。</div>`);
};
document.addEventListener('change', event=>{
  if (event.target.id==='apple-log-service') { task().appleLogService=event.target.value; render(); }
});

function appleDelivery() {
  const t=task();
  t.appleGit ??= {};
  modal('审阅与交付', `<p class="page-intro">各仓库分别审阅与交付。每个动作需要你明确点击；以下结果仅存在于页面内存中。</p>${t.repos.map(id=>{
    const entry=t.appleGit[id] || { status:'未提交', commit:'', pushed:false, merged:false };
    return `<section class="apple-git-row"><div class="between"><strong>${esc(repos[id])}</strong><span class="badge ${entry.commit?'live':''}">${entry.merged?'已模拟合并':entry.pushed?'已模拟推送':entry.status}</span></div><small>task/${esc(t.slug)} → origin/main · 示例 +18 −4</small><p>${entry.commit?'提交说明：'+esc(entry.commit):'有未提交变更；提交前检查文件与验证记录。'}</p><div class="flex">${button('审阅文件','apple-git-files:'+id,'sm')}${button('提交…','apple-git-review:commit:'+id,'sm')}${button('推送…','apple-git-review:push:'+id,'sm')}${button('合并…','apple-git-review:merge:'+id,'sm')}</div></section>`;
  }).join('')}<div class="preview-note">普通目录不显示 Git 交付操作。真实交付还须接入逐仓库文件选择、冲突检查与失败恢复，本原型不运行 Git。</div>`);
}
function appleGitReview(kind,id) {
  const entry=task().appleGit?.[id];
  if (kind==='push' && !entry?.commit) { toast('请先为这个仓库创建模拟提交'); return; }
  if (kind==='merge' && !entry?.pushed) { toast('请先审阅并模拟推送这个仓库'); return; }
  const labels={commit:'提交',push:'推送',merge:'合并'};
  const target=kind==='push'?`origin/task/${task().slug}`:kind==='merge'?'main（本地，跟踪 origin/main）':`task/${task().slug}`;
  modal('确认'+labels[kind]+' · 演示', `<div class="apple-source-summary">仓库：${esc(repos[id])}<br>任务分支：task/${esc(task().slug)}<br>目标：${esc(target)}<br>范围：示例文件 detail.ts · +18 −4</div>${kind==='commit'?'<div class="formfield toolbar-space"><label for="apple-git-message">提交说明</label><textarea id="apple-git-message" rows="3" placeholder="说明这次变更的目的"></textarea></div>':`<p class="page-intro toolbar-space">${kind==='merge'?'将当前任务分支合并到示例目标分支。':'将该仓库的示例提交推送到远程任务分支。'}仅修改原型内存状态。</p>`}`,button('模拟'+labels[kind],`apple-git-confirm:${kind}:${id}`,'primary'));
}

render = function() {
  state.variant = 'A';
  for (const t of state.tasks) {
    t.openTools = (t.openTools || []).filter(key => key !== 'terminal');
    if (t.activeTool === 'terminal') t.activeTool = t.openTools.at(-1);
  }
  appleBaseRender();
    const body = document.querySelector('.taskbody, .subagent-workspace');
  if (body?.querySelector('.workbench, .subagent-sidebar')) body.insertAdjacentHTML('beforeend', `<button class="apple-tool-shade" data-action="${task().subagentPanelOpen?'close-subagents':'close-tools'}" aria-label="关闭工具浮层"></button>`);
  if (state.view === 'task' && task()) {
    if (execution().status === 'idle') document.querySelector('.execution-panel')?.classList.add('apple-idle');
    document.querySelectorAll('.tool-launcher button').forEach(button => { button.setAttribute('aria-label',button.title || '打开工具'); });
  }
  const url = new URL(location.href);
  url.searchParams.set('page', state.view);
  url.searchParams.set('variant', 'A');
  history.replaceState({}, '', url);
  document.body.classList.toggle('apple-nav-open', appleSidebarOpen);
  document.querySelector('.apple-window-context').textContent = `${currentProject()?.name || 'PiDock'} / ${state.view === 'task' ? task()?.name || '任务' : 'Apple 功能评审版'}`;
};

const appleGroups = [
  { title:'项目与任务', detail:'项目切换与编辑、多仓库和普通目录、逐仓库远程基线、任务根目录、追加资源。', items:[['项目总览','view:project'],['项目管理','projects'],['新建任务','newtask'],['追加仓库 / 目录','addrepo']] },
  { title:'会话与输入', detail:'多会话、归档与搜索、Subagent、权限、附件、@ 文件、$ 技能、/ 命令、模型与推理、上下文。', items:[['全部会话','nav-sessions'],['引用文件','symbol:@'],['调用技能','symbol:$'],['会话权限','permissions'],['选择模型','model']] },
  { title:'环境与服务', detail:'任务覆盖、共享模板、本机私有配置、KEY/VALUE 编辑、来源、版本、本地 / 远程服务。', items:[['环境与服务','view:env'],['运行面板','tab:services'],['生效配置','flow-effective'],['运行日志','tab:logs']] },
  { title:'验证与交付', detail:'页面标签、接管 / 交还、点选问题与引用、文件与差异、外部编辑器、显式 Git 交付。', items:[['任务浏览器','tab:browser'],['文件与差异','tab:files'],['审阅与交付','delivery'],['归档任务','view:archive']] },
  { title:'执行与自动化', detail:'执行中、停止、确认 / 拒绝 / 过期、失败恢复、跨项目关注、定时模板与可续聊历史。', items:[['需要处理','flow-attention'],['定时任务','view:schedules'],['本机设置','workspace-settings']] },
  { title:'模型、能力与访问', detail:'Provider 与模型配置、用量汇总、Skills / Extensions / Packages / MCP、设备授权与移动端示意。', items:[['模型与 Provider','view:providers'],['Token 用量','view:usage'],['能力管理','view:capabilities'],['远程访问','view:remote']] },
];
function appleMap() {
  modal('Apple 版 · 功能地图', `<div class="apple-map-legend">每个入口均通往可操作的原型页面或表单。项目、任务、配置与执行状态只保存在页面内存；真实磁盘、模型、服务、Git 与远程设备均未接入。<br>现行规格 #95 已撤销内置终端；本版不提供终端入口。</div><div class="apple-map-grid">${appleGroups.map(group => `<section class="apple-map-group"><h3>${group.title}</h3><p>${group.detail}</p>${group.items.map(([label,action]) => button(label,`apple-jump:${action}`,'sm')).join('')}</section>`).join('')}</div>`, button('继续评审','close-modal','primary'));
  document.querySelector('.modal').style.width = 'min(820px, 100%)';
}
guide = function() {
  modal('Apple 版 · 评审导览', `<div class="help-list"><p><strong>1. 项目与任务</strong><br>切换左侧项目；用任务列表旁的 + 新建任务，选择仓库 / 普通目录和远程基线。</p><p><strong>2. 会话与输入</strong><br>打开全部会话或新建会话；体验输入框的附件、权限、模型与推理，以及 @、$、/。</p><p><strong>3. 运行与验证</strong><br>顶部按需打开运行、浏览器、文件、日志。浏览器可接管、添加页面，并点选问题引用到对话。</p><p><strong>4. 全局管理</strong><br>查看环境模板与生效来源、定时任务、能力、Provider、用量和远程访问。</p><p><strong>5. 异常与收尾</strong><br>展开会话状态中的演示选项，体验等待确认、失败、停止，再从任务操作中归档。</p><p>原型不创建真实任务、服务、调度或设备，不提交、推送、清理真实代码。刷新重置。</p></div>`, button('查看功能地图','apple-map','primary'));
};

function appleAnnotation() {
  const t = task(), b = applePages(), page = b.pages[b.active];
  if (!page || !b.selected) return;
  b.annotation = { taskKey:t.workspaceKey || t.slug, session:t.session, pageId:page.id, url:page.url, revision:b.revision, target:b.selected };
  modal('将页面问题引用到会话', `<div class="apple-source-summary"><strong>${esc(t.name)} / ${esc(t.sessions[t.session])}</strong><br>${esc(page.url)}<br>页面 #${page.id} · 快照 ${b.revision} · 选区：${b.selected==='tracking'?'运单号':'本期应付金额'}<br><small>选区为示意字段，当前没有真实截图或 DOM 定位数据。</small></div><div class="formfield toolbar-space"><label for="apple-annotation-text">问题说明</label><textarea id="apple-annotation-text" rows="4" placeholder="例如：运单号需要支持复制，文字对比度也需要提高。"></textarea></div><p class="note">引用加入草稿，点击发送后交给当前会话。页面变化后保留原证据并要求重新定位。</p>`, button('加入当前会话草稿','apple-attach-annotation','primary'));
}

function appleAction(action, arg) {
  if (action === 'apple-sidebar') {
    if (window.matchMedia('(max-width: 760px)').matches) {
      appleSidebarOpen = !appleSidebarOpen;
      document.body.classList.toggle('apple-nav-open', appleSidebarOpen);
    } else {
      document.body.classList.toggle('apple-sidebar-collapsed');
    }
  }
  if (action === 'apple-map') appleMap();
  if (action === 'apple-guide') guide();
  if (action === 'apple-jump') {
    closeModal();
    if (!task() && !arg.startsWith('view:') && !['projects','newtask','workspace-settings','flow-attention'].includes(arg)) {
      const index = state.tasks.findIndex(t => t.projectId === state.projectId && !t.archived);
      if (index < 0) { toast('请先为当前项目创建任务'); return; }
      appleBaseDispatch('task:' + index);
    }
    if (arg.startsWith('tab:') || arg === 'nav-sessions' || arg.startsWith('symbol:') || ['permissions','model','delivery'].includes(arg)) state.view = 'task';
    if (arg === 'nav-sessions') { render(); sessionListDialog(); }
    else if (arg === 'flow-effective') effectiveConfigDialog();
    else if (arg === 'flow-attention') attentionDialog();
    else { render(); dispatch(arg); }
  }
  if (!task()) return;
  const b = applePages();
  if (action === 'apple-page') {
    b.active = Number(arg); b.revision++; b.selected = ''; b.marking = false; render();
  }
  if (action === 'apple-new-page') {
    const id=b.sequence++;
    b.pages.push({ id, title:'对账单详情 ' + id, path:'/bills/10023', url:`http://127.0.0.1:${task().services[0]?.port || 5173}/bills/10023` });
    b.active = b.pages.length - 1; b.revision++; b.selected = ''; b.marking = false; render();
  }
  if (action === 'apple-close-page') {
    const index=Number(arg), currentId=b.pages[b.active]?.id;
    b.pages.splice(index,1);
    const next=b.pages.findIndex(page=>page.id===currentId);
    b.active=next>=0?next:Math.max(0,Math.min(index,b.pages.length-1));
    b.revision++; b.selected=''; b.marking=false; render();
  }
  if (action === 'apple-refresh') {
    b.revision++; b.selected=''; b.marking=false; task().verified=false; render();
    toast('模拟页面已刷新；旧标记保留原快照身份，不能直接复用坐标');
  }
  if (action === 'apple-takeover') {
    b.marking=false; b.selected=''; task().owner=task().owner==='human'?'agent':'human'; render();
  }
  if (action === 'apple-mark') { b.marking=!b.marking; b.selected=''; render(); }
  if (action === 'apple-mark-target') {
    if (!b.marking) { toast('先点击「标记问题」，再点选字段'); return; }
    b.selected=arg; render();
  }
  if (action === 'apple-annotation') appleAnnotation();
  if (action === 'apple-attach-annotation') {
    const note=document.querySelector('#apple-annotation-text').value.trim();
    if (!note) { toast('请填写问题说明'); return; }
    const a=b.annotation, page=b.pages[b.active];
    if (!a || a.session!==task().session || page?.id!==a.pageId || b.revision!==a.revision) { toast('页面或会话已变化，请重新标记'); return; }
    const name=`页面标记：${a.target==='tracking'?'运单号':'本期应付金额'}`;
    task().refs.push({ type:'page', name, source:`${a.taskKey} / 页面 #${a.pageId} / 快照 ${a.revision}`, annotation:{...a,note} });
    task().draft += (task().draft?'\n':'') + `${name}：${note}\n来源：${a.url}（页面 #${a.pageId}，示例快照 ${a.revision}）`;
    b.marking=false; b.selected=''; closeModal(); task().openTools=[]; render();
    document.querySelector('#message-input')?.focus(); toast('页面问题已加入当前会话草稿，尚未发送');
  }
  if (action === 'apple-evidence') {
    const page=b.pages[b.active];
    modal('浏览器验证证据', `<div class="apple-source-summary">任务：${esc(task().name)}<br>页面：#${page?.id} · ${esc(page?.url||'无页面')}<br>快照：${b.revision}（HTML 示意，无真实图片）<br>控制台：示例 0 报错<br>网络：示例 GET /api/bills/10023 → 200<br>服务：${running()} / ${localCount()} 本地服务<br>代码：当前任务工作副本，示例版本</div><p class="note">这张卡片展示证据应携带的身份和来源。当前记录为模拟数据，不能证明真实业务通过验证。</p>`);
  }
  if (action === 'apple-verify') {
    if (b.marking) { toast('请先完成或取消标记，再让 Agent 操作页面'); return; }
    if (task().owner==='human') { toast('请先交还 Agent'); return; }
    appleBaseDispatch('verify');
  }
  if (action === 'apple-editor') {
    modal('在外部编辑器打开', `<div class="formfield"><label for="apple-editor-choice">编辑器</label><select id="apple-editor-choice"><option>Visual Studio Code</option><option>Cursor</option><option>系统默认编辑器</option></select></div><div class="apple-source-summary">${esc(repos[state.fileRepo] || '当前目录')}<br>当前任务工作副本 / 示例文件 detail.ts</div><p class="note">确认后仅展示选择，不启动本机应用。</p>`, button('模拟打开','apple-editor-open','primary'));
  }
  if (action === 'apple-editor-open') {
    const editor=document.querySelector('#apple-editor-choice').value; closeModal(); toast('演示：使用 ' + editor + ' 打开当前任务文件');
  }
  if (action === 'apple-sources') {
    modal('任务工作区与来源', `<div class="apple-source-summary">任务目录：${esc(task().workspaceKey || task().slug)}<br>独立 Git worktree：${task().repos.length} 个<br>普通目录：${taskDirectories().length} 个<br>环境：${esc(task().env)} / ${esc(task().version)}</div>${repoList()}<p class="note">Git 工作副本隔离；普通目录通过链接访问原始文件，修改会影响共享目标。路径和来源均为示例。</p>`);
  }
  if (action === 'apple-git-files') {
    state.fileRepo=Number(arg); closeModal(); state.view='task'; openTool('files'); render();
  }
  if (action === 'apple-git-review') {
    const [kind,id]=arg.split(':'); appleGitReview(kind,Number(id));
  }
  if (action === 'apple-git-confirm') {
    const [kind,id]=arg.split(':');
    task().appleGit ??= {};
    const entry=task().appleGit[id] ??= { status:'未提交', commit:'', pushed:false, merged:false };
    if (kind==='commit') {
      const message=document.querySelector('#apple-git-message').value.trim();
      if (!message) { toast('请填写提交说明'); return; }
      entry.commit=message; entry.status='已模拟提交'; entry.pushed=false; entry.merged=false;
    }
    if (kind==='push') { if (!entry.commit) return; entry.pushed=true; }
    if (kind==='merge') { if (!entry.pushed) return; entry.merged=true; }
    appleDelivery(); toast('已更新单个仓库的演示结果，其他仓库保持原状');
  }
}
dispatch = function(value) {
  const [action,...parts]=value.split(':');
  if (action.startsWith('apple-')) { appleAction(action,parts.join(':')); return; }
  if (action==='delivery' || action==='delivery-preview') { appleDelivery(); return; }
  if (value.includes('terminal')) { toast('当前产品范围不提供内置终端'); return; }
  if (action.startsWith('variant')) return;
  if (['view','task'].includes(action)) { appleSidebarOpen=false; document.body.classList.remove('apple-nav-open'); }
  appleBaseDispatch(value);
};

// Prevent the comparison prototype's arrow shortcuts from switching this page.
window.addEventListener('keydown', event => {
  if (['ArrowLeft','ArrowRight'].includes(event.key) && !event.target.closest('input,textarea,select,[contenteditable],.session-tabs,.navigation-menu,[role="tablist"]')) event.stopImmediatePropagation();
  if (event.key==='Escape') {
    appleSidebarOpen=false; document.body.classList.remove('apple-nav-open');
    if (!document.querySelector('.modal') && task()?.openTools.length) { task().openTools=[]; render(); }
  }
}, true);

const applePageParam=new URLSearchParams(location.search).get('page');
if (['task','project','env','providers','usage','schedules','capabilities','remote','archive'].includes(applePageParam)) state.view=applePageParam;
render();
