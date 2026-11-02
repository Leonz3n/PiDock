// THROWAWAY: all interactions stay in memory and never contact the Pi runtime.
const roots = [...document.querySelectorAll('.variant-container')];
const streams = ['.chat-stream', '.terminal-chat-stream', '.fusion-stream'];
const defaultTitles = ['对账单详情·本地联调', 'MISSION: 对账单详情·跨仓联调与修复', '对账单详情·本地联调'];
const serviceState = { A: true, B: true, C: true };
let toastTimer;
function toast(message) {
  const node = document.querySelector('.review-toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
}

const notification = document.createElement('div');
notification.className = 'review-toast';
notification.setAttribute('role', 'status');
notification.hidden = true;
document.body.append(notification);

// Keep review controls clear of the composer, even in the narrow side browser.
const switcher = document.querySelector('.prototype-switcher');
const prototypeLabel = document.createElement('span');
prototypeLabel.className = 'review-prototype-label';
prototypeLabel.textContent = 'UI 原型 · 模拟数据';
switcher.prepend(prototypeLabel);
const fullApple = document.createElement('a');
fullApple.href = 'apple.html';
fullApple.textContent = 'Apple 功能版 ↗';
fullApple.style.cssText = 'color:#d7e7ff;font-size:11px;padding:5px 8px;text-decoration:none;border-left:1px solid #ffffff20';
switcher.append(fullApple);
['A · Apple 原生', 'B · 二次元机能', 'C · 融合分屏'].forEach((label, index) => {
  const button = document.getElementById(`btn-${VARIANTS[index].toLowerCase()}`);
  button.setAttribute('aria-label', label);
  button.innerHTML = `<span class="variant-full">${label}</span><span class="variant-short">${['A · Apple', 'B · 机能', 'C · 融合'][index]}</span>`;
});
switcher.querySelector('.tag-info').textContent = '← → 切换';

const baseApplyVariant = applyVariant;
applyVariant = function (variant, updateUrl) {
  baseApplyVariant(variant, updateUrl);
  roots.forEach((root, index) => {
    root.inert = VARIANTS[index] !== variant;
    document.getElementById(`btn-${VARIANTS[index].toLowerCase()}`).setAttribute('aria-pressed', String(VARIANTS[index] === variant));
  });
};
applyVariant(currentVariant, false);
window.addEventListener('popstate', initVariant);

function panelIsOverlay(variant) {
  return window.matchMedia(variant === 'C' ? '(max-width: 760px)' : '(max-width: 1180px)').matches;
}
function syncPanel(root) {
  const variant = root.dataset.variant;
  const panel = root.querySelector(`#panel-${variant.toLowerCase()}`);
  const visible = getComputedStyle(panel).display !== 'none';
  if (variant === 'C') root.classList.toggle('evidence-closed', !visible);
  root.querySelectorAll('[data-panel-toggle]').forEach(button => button.setAttribute('aria-expanded', String(visible)));
  const backdrop = root.querySelector('.panel-backdrop');
  backdrop.hidden = !(visible && panelIsOverlay(variant));
}
toggleRightPanel = function (variant) {
  const root = document.getElementById(`variant-${variant.toLowerCase()}-root`);
  const panel = root.querySelector(`#panel-${variant.toLowerCase()}`);
  if (panelIsOverlay(variant.toUpperCase())) {
    panel.style.display = '';
    panel.classList.toggle('panel-open');
  } else {
    panel.style.display = getComputedStyle(panel).display === 'none' ? '' : 'none';
  }
  syncPanel(root);
};
const responsivePanels = [window.matchMedia('(max-width: 1180px)'), window.matchMedia('(max-width: 760px)')];
responsivePanels.forEach(query => query.addEventListener('change', () => {
  roots.forEach(root => {
    const panel = root.querySelector('[id^="panel-"]');
    panel.style.display = '';
    panel.classList.remove('panel-open');
    root.classList.remove('sidebar-open');
    const sidebar = root.querySelector('.sidebar, .cyber-sidebar');
    if (sidebar) sidebar.hidden = false;
    const sidebarButton = root.querySelector('[aria-label="切换任务列表"]');
    if (sidebarButton) sidebarButton.setAttribute('aria-expanded', String(!window.matchMedia('(max-width: 760px)').matches));
    syncPanel(root);
  });
}));

roots.forEach((root, index) => {
  const variant = VARIANTS[index];
  root.dataset.variant = variant;
  const panel = root.querySelector('[id^="panel-"]');
  const panelButton = root.querySelector('button[onclick^="toggleRightPanel"]');
  panelButton.dataset.panelToggle = '';
  panelButton.setAttribute('aria-controls', panel.id);

  const backdrop = document.createElement('button');
  backdrop.className = 'panel-backdrop';
  backdrop.setAttribute('aria-label', '关闭侧面板');
  backdrop.hidden = true;
  backdrop.onclick = () => toggleRightPanel(variant);
  root.append(backdrop);

  if (index < 2) {
    const sidebarButton = document.createElement('button');
    sidebarButton.className = 'panel-toggle';
    sidebarButton.textContent = '☰';
    sidebarButton.setAttribute('aria-label', '切换任务列表');
    sidebarButton.setAttribute('aria-expanded', String(!window.matchMedia('(max-width: 760px)').matches));
    sidebarButton.onclick = () => {
      const sidebar = root.querySelector(index === 0 ? '.sidebar' : '.cyber-sidebar');
      if (window.matchMedia('(max-width: 760px)').matches) root.classList.toggle('sidebar-open');
      else sidebar.hidden = !sidebar.hidden;
      sidebarButton.setAttribute('aria-expanded', String(getComputedStyle(sidebar).display !== 'none'));
    };
    root.firstElementChild.prepend(sidebarButton);
    const service = document.createElement('div');
    service.className = 'demo-service';
    service.innerHTML = '<span class="service-light">●</span> payment-core <small>:8090 · 健康检查通过</small>';
    panel.append(service);
    const liveDescriptions = ['端口冲突已自动改址并向前端注入', 'Vite HMR 已连通 · 页面正常', 'PID 98214 · FLUX STABLE', 'VITE HMR ONLINE', ':8090 · 健康检查通过'];
    panel.querySelectorAll('div, small').forEach(node => {
      if (liveDescriptions.includes(node.textContent)) {
        node.dataset.serviceDetail = '';
        node.dataset.runningLabel = node.textContent;
      }
    });
    const bar = document.createElement('div');
    bar.className = 'demo-service-bar';
    bar.innerHTML = '<span class="service-summary">● 3/3 服务运行中</span><button class="review-action" data-toggle-services>停止服务</button>';
    panel.append(bar);
    const caption = document.createElement('p');
    caption.className = 'review-caption';
    caption.textContent = 'UI 原型 · 服务、变更和浏览器结果均为模拟数据';
    panel.prepend(caption);
  }

  const stream = root.querySelector(streams[index]);
  stream.setAttribute('role', 'log');
  stream.setAttribute('aria-label', '任务对话');
  const textarea = root.querySelector('textarea');
  textarea.setAttribute('aria-label', '发送给 Pi 的消息');
  const send = textarea.parentElement.querySelector('button');
  send.setAttribute('aria-label', '发送消息');
  function sendMessage() {
    const text = textarea.value.trim();
    if (!text) { textarea.focus(); return; }
    const user = document.createElement('div');
    user.className = 'review-message review-user';
    user.textContent = text;
    const agent = document.createElement('div');
    agent.className = 'review-message review-agent';
    const label = document.createElement('strong');
    label.textContent = 'π Pi · 演示回复';
    const response = document.createElement('p');
    response.textContent = '已收到。这个位置会展示 Pi 的执行进度、工具调用和结果，你可以继续检查侧面的验证工作台。';
    const note = document.createElement('small');
    note.textContent = '此原型仅模拟消息交互，未执行命令。';
    agent.append(label, response, note);
    stream.append(user, agent);
    textarea.value = '';
    stream.scrollTop = stream.scrollHeight;
    textarea.focus();
  }
  send.onclick = sendMessage;
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); }
  });

  const newTask = index === 2 ? root.querySelector('[data-new-task]') : root.firstElementChild.querySelector('div:last-child button:last-child');
  newTask.onclick = () => openTaskDialog(root, index);
  root.querySelectorAll('[data-toggle-services]').forEach(button => button.onclick = () => toggleServices(variant));
  syncPanel(root);
});

function toggleServices(variant) {
  const root = roots[VARIANTS.indexOf(variant)];
  serviceState[variant] = !serviceState[variant];
  const running = serviceState[variant];
  root.classList.toggle('services-stopped', !running);
  root.querySelectorAll('[data-toggle-services]').forEach(button => { button.textContent = running ? '停止服务' : '启动服务'; });
  root.querySelectorAll('.service-summary').forEach(node => { node.textContent = running ? '● 3/3 服务运行中' : '○ 0/3 服务运行中'; });
  root.querySelectorAll('.neo-service small, [data-service-detail]').forEach(node => {
    if (!node.dataset.runningLabel) node.dataset.runningLabel = node.textContent;
    node.textContent = running ? node.dataset.runningLabel : '已停止 · 演示状态';
  });
  if (variant === 'A') {
    const badges = root.querySelector('.task-header > div:last-child');
    badges.firstElementChild.textContent = running ? '● 3/3 本地服务运行中' : '○ 0/3 本地服务运行中';
    root.querySelector('.task-header button').textContent = running ? '停止本任务服务' : '启动本任务服务';
  }
  toast(running ? '演示：3 个本地服务已启动' : '演示：3 个本地服务已停止，验证快照已保留');
}
roots[0].querySelector('.task-header button').onclick = () => toggleServices('A');

const thinking = roots[0].querySelector('.thinking-box');
thinking.innerHTML = '<details class="review-details"><summary>执行摘要 <span>3 步 · 12s</span></summary><ol><li>对比上游字段与 BFF 映射。</li><li>补充 trackingNo 的兼容映射。</li><li>启动服务并检查详情页。</li></ol></details>';
thinking.style.border = '0';

function selectEvidence(name, focusTab = false) {
  roots[2].querySelectorAll('[data-evidence]').forEach(button => {
    const selected = button.dataset.evidence === name;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focusTab) button.focus();
  });
  roots[2].querySelectorAll('.evidence-pane').forEach(pane => { pane.hidden = pane.id !== `evidence-${name}`; });
}
roots[2].querySelectorAll('[data-evidence]').forEach((button, index, buttons) => {
  button.onclick = () => selectEvidence(button.dataset.evidence);
  button.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : -1) + 3) % 3;
    selectEvidence(buttons[next].dataset.evidence, true);
  });
});
roots[2].querySelectorAll('[data-open-evidence]').forEach(button => {
  button.onclick = () => {
    const panel = roots[2].querySelector('#panel-c');
    if (getComputedStyle(panel).display === 'none') toggleRightPanel('C');
    selectEvidence(button.dataset.openEvidence);
  };
});

const dialog = document.createElement('dialog');
dialog.className = 'review-dialog';
dialog.setAttribute('aria-labelledby', 'review-dialog-title');
dialog.innerHTML = '<form><h2 id="review-dialog-title">新建演示任务</h2><p>体验任务创建和对话布局。所有内容仅保留在当前页面内存中。</p><label for="review-task-name">任务名称</label><input id="review-task-name" placeholder="例如：优化订单详情页" maxlength="70" required><footer><button type="button" data-cancel>取消</button><button class="dialog-primary" type="submit">创建演示任务</button></footer></form>';
document.body.append(dialog);
dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
let dialogRoot;
let dialogIndex;
function openTaskDialog(root, index) {
  dialogRoot = root;
  dialogIndex = index;
  dialog.querySelector('input').value = '';
  dialog.showModal();
}
dialog.querySelector('form').onsubmit = event => {
  event.preventDefault();
  const name = dialog.querySelector('input').value.trim();
  if (!name) return;
  const root = dialogRoot;
  const index = dialogIndex;
  const title = index === 0 ? root.querySelector('h1') : index === 1 ? root.querySelector('.war-room-center > div:first-child > div:first-child') : root.querySelector('h1');
  title.textContent = name;
  const stream = root.querySelector(streams[index]);
  if (!root._originalStream) root._originalStream = [...stream.childNodes];
  stream.replaceChildren();
  const welcome = document.createElement('div');
  welcome.className = 'review-message review-agent';
  const heading = document.createElement('strong');
  heading.textContent = name;
  const description = document.createElement('p');
  description.textContent = '任务已创建。描述目标，开始与 Pi 协作。';
  const note = document.createElement('small');
  note.textContent = '演示模式 · 右侧保留上一个任务的示例快照';
  const reset = document.createElement('button');
  reset.className = 'review-action';
  reset.textContent = '返回示例任务';
  reset.onclick = () => {
    title.textContent = defaultTitles[index];
    stream.replaceChildren(...root._originalStream);
    root._originalStream = null;
  };
  welcome.append(heading, description, note, reset);
  stream.append(welcome);
  dialog.close();
  root.querySelector('textarea').focus();
};

// Lightweight navigation previews keep the mock UI honest about its scope.
roots[0].querySelectorAll('.sidebar-item').forEach((item, index) => {
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.onclick = () => {
    if (index === 1) {
      if (getComputedStyle(roots[0].querySelector('#panel-a')).display === 'none') toggleRightPanel('A');
    } else toast(index === 0 ? '演示项目：Atlas Web · 3 个仓库 · 2 个任务' : '演示用量：本次任务 12.4k tokens · 3 次工具调用');
  };
  item.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); item.click(); } };
});
roots[0].querySelectorAll('.task-card-item').forEach((item, index) => {
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.onclick = () => {
    if (index === 1) toast('此轮演示聚焦「对账单详情·本地联调」，其他任务为导航示例。');
  };
  item.onkeydown = event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); item.click(); } };
});
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  const root = roots[VARIANTS.indexOf(currentVariant)];
  const panel = root.querySelector('[id^="panel-"]');
  if (panelIsOverlay(currentVariant) && panel.classList.contains('panel-open')) toggleRightPanel(currentVariant);
  root.classList.remove('sidebar-open');
});
