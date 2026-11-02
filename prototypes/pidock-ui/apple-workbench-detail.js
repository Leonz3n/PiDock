/* THROWAWAY: task-workbench review. All files, diffs and commands below are fixtures.
 * User confirmed: Agent command history only; no embedded terminal (#95).
 */
toolItems.push(['commands', 'code', '命令记录']);
const appleDetailPanel = panel;
const appleDetailDispatch = dispatch;
const appleDetailComposerRefs = composerAttachments;
const appleDetailMessageRefs = messageAttachments;
const appleDetailSend = send;
const appleDetailConversation = conversation;

directoryHeader = function() {
  return `<header class="taskheader"><div class="between"><div><div class="view-label">TASK WORKSPACE</div><h1>${esc(task().name)}</h1></div><div class="actionset">${toolLauncher()}${button('添加目录','addrepo','','plus')}<button class="iconbtn" data-action="taskmenu" aria-label="任务操作">${icon('more')}</button></div></div><div class="meta">${taskDirectories().length} 个普通目录 · 链接到原目录，文件共享</div></header>`;
};

function appleRoots() {
  return task().repos.map(id=>({ key:'repo'+id, name:repos[id], repo:id, path:workspacePath(task().workspaceRoot,task().workspaceKey,repos[id]) }))
    .concat(taskDirectories().map((d,i)=>({ key:'dir'+i, name:d.name, path:directoryLinkPath(d), target:d.path })));
}
function appleFileState() {
  const roots=appleRoots();
  task().appleFiles ??= { root:roots[0]?.key, tabs:[], active:null, mode:'source', query:'', start:1, end:1 };
  const f=task().appleFiles;
  if (!roots.some(r=>r.key===f.root)) f.root=roots[0]?.key;
  return f;
}
function appleFixtureFiles(root) {
  if (!root) return [];
  const files=root.target ? [
    { path:'README.md', lines:['# 项目资料（演示）','','此目录通过链接加入任务。','多个任务访问的是同一份原始文件。','','修改前核对影响范围。'] },
    { path:'notes/review.md', lines:['# 评审记录（演示）','','- 运单号支持复制','- 金额展示保持清晰','- 保存验证证据'] },
  ] : [
    { path:'src/detail.ts', lines:['// 演示代码，不是实际业务源码','import { loadAccount } from "./account";','','export async function loadDetail(id: string) {','  const response = await fetchDetail(id);','  const account = response.account','    ?? await loadAccount(id);','','  return {','    ...response,','    shipmentAccount: account','  };','}'], additions:[7,11], before:{6:'  const account = response.account;'} },
    { path:'src/detail.test.ts', lines:['// 演示验证用例','describe("对账单详情", () => {','  it("补全缺失的运单账号", async () => {','    const detail = await loadDetail("10023");','    expect(detail.shipmentAccount).toBeDefined();','  });','});'], additions:[3,4,5] },
    { path:'configs/local.json', lines:['{','  "environment": "testing",','  "accountService": "remote-test",','  "port": 5173','}'] },
    { path:'README.md', lines:['# '+root.name+'（演示）','','本任务在独立 Git worktree 中工作。','','## 验证','pnpm test -- detail.test.ts'] },
  ];
  return files.map(file=>({...file, root:root.key, rootName:root.name, rootPath:root.path.replace(/\/$/,''), shared:!!root.target, target:root.target, id:root.key+'~'+file.path}));
}
function appleAllFiles() { return appleRoots().flatMap(appleFixtureFiles); }
function appleActiveFile() { return appleAllFiles().find(file=>file.id===appleFileState().active); }
function appleTreeMarkup() {
  const f=appleFileState(), root=appleRoots().find(r=>r.key===f.root);
  const list=appleFixtureFiles(root).filter(file=>file.path.toLowerCase().includes(f.query.toLowerCase()));
  const groups=Object.groupBy(list,file=>file.path.includes('/')?file.path.split('/')[0]:'/');
  return Object.entries(groups).map(([folder,files])=>`<details open class="apple-tree-group"><summary>${folder==='/'?'根目录':esc(folder)}</summary>${files.map(file=>`<button class="apple-tree-file ${file.id===f.active?'active':''}" data-action="af-open:${esc(file.id)}" title="${esc(file.path)}">${icon('file')}<span>${esc(file.path.split('/').at(-1))}</span><small>${file.additions?'M':''}</small></button>`).join('')}</details>`).join('') || '<p class="note">没有匹配文件</p>';
}
function appleFileCode(file,f) {
  return file.lines.map((line,i)=>{
    const n=i+1, diff=f.mode==='diff', add=diff&&file.additions?.includes(n), old=diff&&file.before?.[n];
    return (old?`<div class="apple-code-deleted"><span>−</span><code>${esc(old)}</code></div>`:'')+`<button class="apple-code-line ${n>=Math.min(f.start,f.end)&&n<=Math.max(f.start,f.end)?'selected':''} ${add||old?'added':''}" data-action="af-line:${n}" aria-label="选择第 ${n} 行" aria-pressed="${n>=Math.min(f.start,f.end)&&n<=Math.max(f.start,f.end)}"><span class="apple-line-number">${n}</span><span class="apple-line-marker">${diff&&(add||old)?'+':''}</span><code>${esc(line)||' '}</code></button>`;
  }).join('');
}
filesView = function() {
  const f=appleFileState(), root=appleRoots().find(r=>r.key===f.root), file=appleActiveFile();
  return `<div class="apple-file-workspace"><div class="panel-heading"><strong>文件工作区</strong><span class="badge">示例文件</span></div>
    <div class="formfield apple-root-field"><label for="af-root">仓库 / 目录</label><select id="af-root">${appleRoots().map(r=>`<option value="${r.key}" ${f.root===r.key?'selected':''}>${esc(r.name)} · ${r.target?'共享目录':'独立 worktree'}</option>`).join('')}</select></div>
    ${root?`<details class="apple-file-origin"><summary>${root.target?'共享原文件 · 修改影响原目录':'Git worktree · 当前任务独立副本'}</summary><code>${esc(root.path)}</code>${root.target?`<br>→ ${esc(root.target)}`:''}</details>`:''}
    <input id="af-search" class="apple-file-search" aria-label="搜索当前目录的文件" placeholder="搜索文件路径…" value="${esc(f.query)}">
    <div class="apple-files-layout"><aside class="apple-file-tree" aria-label="文件目录">${appleTreeMarkup()}</aside><section class="apple-file-editor" aria-label="文件内容">
      <div class="apple-file-tabs" aria-label="已打开文件">${f.tabs.map(id=>appleAllFiles().find(x=>x.id===id)).filter(Boolean).map(x=>`<div class="apple-file-tab ${x.id===f.active?'active':''}"><button data-action="af-open:${esc(x.id)}" title="${esc(x.rootName+'/'+x.path)}">${esc(x.path.split('/').at(-1))}${f.tabs.filter(id=>id.endsWith('~'+x.path)).length>1?` <small>${esc(x.rootName)}</small>`:''}</button><button data-action="af-close:${esc(x.id)}" aria-label="关闭文件 ${esc(x.rootName+'/'+x.path)}">×</button></div>`).join('')}</div>
      ${file?`<div class="apple-file-breadcrumb">${esc(file.rootName)} / ${esc(file.path)}</div><div class="apple-file-modes"><button data-action="af-mode:source" aria-pressed="${f.mode==='source'}">源码</button>${!file.shared?`<button data-action="af-mode:diff" aria-pressed="${f.mode==='diff'}">工作区差异</button>`:''}<span>${file.lines.length} 行 · 只读预览</span></div>
        ${f.mode==='diff'?`<div class="apple-diff-legend">− 基线版本　 + 当前版本 · 示例差异</div>`:''}<div class="apple-code-view" aria-label="示例代码">${appleFileCode(file,f)}</div>
        <div class="apple-line-selection"><label>起始行 <input id="af-start" aria-label="引用起始行" type="number" min="1" max="${file.lines.length}" value="${f.start}"></label><label>结束行 <input id="af-end" aria-label="引用结束行" type="number" min="1" max="${file.lines.length}" value="${f.end}"></label>${button('引用所选代码','af-quote','sm primary')}</div>
        <div class="apple-file-actions">${button('在外部编辑器打开','af-editor','sm','code')}${button('工作区与来源','apple-sources','sm','folder')}</div>`:'<div class="apple-file-empty">从左侧选择文件<br><small>源码、差异与选行引用在这里打开</small></div>'}
    </section></div><p class="note">文件、版本与内容均为演示数据。点击行号选择单行；也可用起止行设置引用范围。</p></div>`;
};

function appleCommandRows() {
  task().appleCommands ??= appleInitialTasks.has(task()) ? appleCommandFixtures().map(row=>({...row,env:task().env,version:task().version})) : [];
  return task().appleCommands;
}
function appleCommandFixtures() {
  const root=appleRoots()[0], cwd=root?.path || '示例任务目录';
  return [
    { id:'cmd-1', session:0, command:'pnpm test -- detail.test.ts', cwd, status:'已完成', exit:0, duration:'1.8 s', time:'10:25:03', output:'PASS src/detail.test.ts\nTests: 1 passed, 1 total', error:'' },
    { id:'cmd-2', session:0, command:'pnpm typecheck', cwd, status:'失败', exit:2, duration:'2.4 s', time:'10:25:06', output:'TypeScript checking…', error:'src/detail.ts:11 — TS2322\nAccount | undefined is not assignable to Account.' },
    { id:'cmd-3', session:1, command:'git diff --stat', cwd, status:'已完成', exit:0, duration:'0.1 s', time:'10:26:10', output:'src/detail.ts       | 3 ++-\nsrc/detail.test.ts  | 3 +++\n2 files changed', error:'' },
  ];
}
function appleCommandsView() {
  const t=task(), scope=t.appleCommandScope||'session';
  const rows=appleCommandRows().filter(row=>scope==='all'||row.session===t.session);
  return `<div class="panel-heading"><strong>Agent 命令记录</strong><span class="badge">只读 · 示例</span></div><p class="note">查看 Agent 的命令、工作目录与输出。服务进程的持续输出位于「日志」。</p>
    <div class="formfield toolbar-space"><label for="ac-scope">记录范围</label><select id="ac-scope"><option value="session" ${scope==='session'?'selected':''}>当前会话 · ${esc(t.sessions[t.session])}</option><option value="all" ${scope==='all'?'selected':''}>当前任务 · 全部会话</option></select></div>
    <div class="apple-command-list">${rows.map(row=>`<details class="apple-command" ${row.exit!==0?'open':''}><summary><span class="apple-command-status ${row.exit?'failed':''}">${row.exit?'!':'✓'}</span><span><code>${esc(row.command)}</code><small>${esc(t.sessions[row.session]||'已归档会话')} · ${row.time} · ${row.duration}</small></span><span class="badge">${row.status}</span></summary><div class="apple-command-body"><dl><dt>工作目录</dt><dd>${esc(row.cwd)}</dd><dt>执行环境</dt><dd>${esc(row.env)} · ${esc(row.version)}（示例）</dd><dt>退出码</dt><dd>${row.exit}</dd></dl><span class="section-label">标准输出</span><pre>${esc(row.output)}</pre>${row.error?`<span class="section-label">标准错误</span><pre class="apple-command-error">${esc(row.error)}</pre>`:''}${button('引用这条记录','ac-quote:'+row.id,'sm')}</div></details>`).join('')||`<div class="apple-file-empty">当前会话还没有命令记录<br><small>后续 Agent 执行记录会出现在这里</small></div>`}</div><p class="note">以上为预设记录；切换会话只筛选示例数据，不会执行命令。</p>`;
}
panel = function() {
  if(state.tab==='files')return filesView();
  if(state.tab==='commands')return appleCommandsView();
  if(state.tab==='browser')return browserView();
  return appleDetailPanel();
};

conversation = function() {
  const html=appleDetailConversation(), t=task();
  const draftCount=Object.values(t.sessionData).filter(d=>d.draft||d.refs?.length).length;
  return html.replace('<div class="messages">', `<div class="apple-session-context"><span>${esc(t.sessions[t.session])} · 独立上下文</span><button data-action="ad-session-map">${draftCount} 份会话草稿 · 查看归属</button></div><div class="messages">`);
};
function appleRefCard(ref,index) {
  return `<div class="apple-context-reference"><button data-action="ad-ref:${ref.id}">${icon(ref.type==='command'?'code':'file')}<span>${esc(ref.name)}<small>${esc(ref.source)}</small></span></button>${index!==undefined?`<button data-action="ref:${index}" aria-label="移除 ${esc(ref.name)}">×</button>`:''}</div>`;
}
composerAttachments = function() {
  const html=appleDetailComposerRefs();
  const template=document.createElement('template'); template.innerHTML=html;
  template.content.querySelectorAll('.refchip').forEach(node=>{
    const i=Number(node.dataset.action.split(':')[1]),ref=task().refs[i];
    if(ref?.type==='code'||ref?.type==='command')node.outerHTML=appleRefCard(ref,i);
  });
  return template.innerHTML;
};
messageAttachments = function(message) {
  return appleDetailMessageRefs(message)+(message.references||[]).map(ref=>appleRefCard(ref)).join('');
};
send = function() {
  const t=task(), index=t.messages.length, refs=t.refs.filter(r=>r.type==='code'||r.type==='command');
  appleDetailSend();
  if(t.messages.length>index)t.messages[index].references=structuredClone(refs);
  if(t.messages.length>index)render();
};

function appleDetailAction(action,arg) {
  if(!task())return;
  const f=appleFileState();
  if(action==='af-open') {
    const file=appleAllFiles().find(x=>x.id===arg); if(!file)return;
    if(!f.tabs.includes(arg))f.tabs.push(arg);
    if(f.active!==arg){f.start=1;f.end=1;}
    if(f.root!==file.root)f.query='';
    f.active=arg;f.root=file.root;if(file.shared)f.mode='source';render();
  }
  if(action==='af-close') { f.tabs=f.tabs.filter(x=>x!==arg); if(f.active===arg){f.active=null;f.start=f.end=1;const next=appleAllFiles().find(x=>x.id===f.tabs.at(-1));if(next){f.active=next.id;f.root=next.root;if(next.shared)f.mode='source';}}render(); }
  if(action==='af-mode'){f.mode=arg;render();}
  if(action==='af-line'){f.start=Number(arg);f.end=Number(arg);render();}
  if(action==='af-quote') {
    const file=appleActiveFile();if(!file)return;
    const start=Math.min(f.start,f.end),end=Math.max(f.start,f.end);
    task().applePendingCode={id:crypto.randomUUID(),type:'code',name:`${file.path}:${start}–${end}`,source:`${file.rootName} · ${file.shared?'共享目录':'task/'+task().slug} · 当前版本（示例）`,taskKey:task().workspaceKey,session:task().session,path:file.rootPath+'/'+file.path,start,end,snippet:file.lines.slice(start-1,end).join('\n')};
    const ref=task().applePendingCode;
    modal('引用代码到当前会话',`<div class="apple-source-summary">${esc(task().sessions[task().session])}<br>${esc(ref.path)}<br>当前版本 · 第 ${start}–${end} 行（示例内容）</div><pre class="apple-reference-snippet">${esc(ref.snippet)}</pre><div class="formfield"><label for="af-note">补充说明（可选）</label><textarea id="af-note" rows="2" placeholder="希望 Agent 关注什么？"></textarea></div>`,button('加入当前会话草稿','af-attach','primary'));
  }
  if(action==='af-attach') {
    const ref=task().applePendingCode;if(!ref||ref.session!==task().session)return;
    ref.note=document.querySelector('#af-note').value.trim();task().refs.push(ref);
    if(ref.note)task().draft+=(task().draft?'\n':'')+ref.note;
    task().applePendingCode=null;closeModal();task().openTools=[];task().activeTool=null;render();toast('代码引用已加入当前会话草稿，尚未发送');
  }
  if(action==='af-editor') {
    const file=appleActiveFile();if(!file)return;
    modal('在外部编辑器打开',`<div class="formfield"><label for="apple-editor-choice">编辑器</label><select id="apple-editor-choice"><option>Visual Studio Code</option><option>Cursor</option><option>系统默认编辑器</option></select></div><div class="apple-source-summary">${esc(file.rootPath+'/'+file.path)}<br>${file.shared?'共享原文件':'当前任务独立工作副本'}</div><p class="note">演示选择；不启动本机应用。</p>`,button('模拟打开','apple-editor-open','primary'));
  }
  if(action==='ac-quote') {
    const row=appleCommandRows().find(x=>x.id===arg);if(!row)return;
    task().refs.push({id:crypto.randomUUID(),type:'command',name:row.command,source:`${task().sessions[row.session]} · 退出码 ${row.exit} · 示例记录`,snippet:`工作目录：${row.cwd}\n命令：${row.command}\n退出码：${row.exit}\n${row.output}\n${row.error}`});
    task().openTools=[];task().activeTool=null;render();toast('命令记录已引用到当前会话草稿，尚未发送');
  }
  if(action==='ad-ref') {
    const ref=[...task().refs,...task().messages.filter(m=>m.session===task().session).flatMap(m=>m.references||[])].find(r=>r.id===arg);if(!ref)return;
    modal(ref.type==='code'?'代码引用':'命令记录引用',`<div class="apple-source-summary">${esc(ref.name)}<br>${esc(ref.source)}${ref.path?'<br>'+esc(ref.path):''}</div><pre class="apple-reference-snippet">${esc(ref.snippet)}</pre>${ref.note?`<p>${esc(ref.note)}</p>`:''}`);
  }
  if(action==='ad-session-map') {
    modal('会话与共享工作区',`<p class="page-intro">同任务共享文件、服务与浏览器。草稿、引用、模型、权限和对话上下文按会话保留。</p>${task().sessions.map((name,i)=>{const d=task().sessionData[i];return `<section class="apple-session-row"><strong>${esc(name)} ${i===task().session?'· 当前':''}</strong><small>${esc(d?.model||task().model)} · ${esc(permissionModes.find(m=>m.id===sessionPermission(task(),i))?.name||'默认权限')} · ${d?.refs?.length||0} 个引用</small><p>${d?.draft?esc(d.draft.slice(0,90)):'无文字草稿'}</p>${button('切换到此会话','ad-session:'+i,'sm')}</section>`;}).join('')}`);
  }
  if(action==='ad-session'){closeModal();appleDetailDispatch('session:'+arg);}
}
function appleChooseRoot(key) {
  const f=appleFileState();f.root=key;f.query='';f.start=f.end=1;
  const next=appleAllFiles().find(file=>file.root===key&&file.id===f.tabs.findLast(id=>id.startsWith(key+'~')));
  f.active=next?.id||null;if(next?.shared)f.mode='source';
}
dispatch = function(value) {
  const [action,...rest]=value.split(':');
  if(/^(af-|ac-|ad-)/.test(action)){appleDetailAction(action,rest.join(':'));return;}
  if(action==='apple-git-files'||action==='repo') {
    const id=Number(rest.join(':'));if(task())appleChooseRoot('repo'+id);
  }
  if(['apple-page','apple-new-page','apple-close-page'].includes(action)&&task())task().verified=false;
  appleDetailDispatch(value);
};
document.addEventListener('input',event=>{
  if(event.target.id==='af-search') {
    appleFileState().query=event.target.value;
    document.querySelector('.apple-file-tree').innerHTML=appleTreeMarkup();
  }
  if(['af-start','af-end'].includes(event.target.id)) {
    const f=appleFileState(), file=appleActiveFile();if(!file)return;
    f[event.target.id==='af-start'?'start':'end']=Math.max(1,Math.min(file.lines.length,Number(event.target.value)||1));
    document.querySelectorAll('.apple-code-line').forEach(line=>{
      const n=Number(line.dataset.action.split(':')[1]),selected=n>=Math.min(f.start,f.end)&&n<=Math.max(f.start,f.end);
      line.classList.toggle('selected',selected);line.setAttribute('aria-pressed',String(selected));
    });
  }
});
document.addEventListener('change',event=>{
  if(event.target.id==='af-root'){appleChooseRoot(event.target.value);render();}
  if(event.target.id==='ac-scope'){task().appleCommandScope=event.target.value;render();}
});
appleGroups[1].items.push(['草稿与共享范围','ad-session-map']);
appleGroups[3].items.push(['Agent 命令记录','tab:commands']);
render();
