// Public native-rendered geometry gate for #163. Mutations exist only in the capture process.
/**
 * @param {import('electron').WebContents} wc
 * @param {'conversation'|'management'} surface
 * @param {Array<{name:string,passed:boolean,detail?:unknown}>} results
 */
export async function assertPencilLayout(wc, surface, results) {
  const evaluate = async expression => {
    const reply = await wc.debugger.sendCommand('Runtime.evaluate', { expression, returnByValue:true, awaitPromise:true });
    if (reply.exceptionDetails) throw Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  };
  const measure = () => evaluate(`(() => {
    const box = selector => {const el=document.querySelector(selector);if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};};
    const visible = selector => [...document.querySelectorAll(selector)].filter(el=>el.getBoundingClientRect().width>0 && !el.closest('[hidden]'));
    const page=document.querySelector('[data-testid=desktop-settings-page], [data-testid=desktop-capabilities-page]');
    return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,chromium:navigator.userAgent,font:getComputedStyle(document.body).fontFamily,fontsReady:document.fonts.status,
      rail:box('[data-testid=desktop-sidebar]'),header:box('[data-testid=desktop-breadcrumb]'),column:box('[data-testid=desktop-message-column]'),composer:box('[data-testid=desktop-composer]'),scroll:box('[data-testid=desktop-conversation-scroll]'),input:box('textarea[aria-label=消息]'),facts:visible('[data-testid=desktop-task-facts]').length,
      managementHeaders:page?.querySelectorAll('header').length,managementHeader:page?(()=>{const r=page.querySelector('header').getBoundingClientRect();return {y:r.y,height:r.height};})():null,workspace:visible('[data-testid=desktop-sidebar]').length};
  })()`);
  const failures = m => {
    const near=(a,b)=>Math.abs(a-b)<=2;
    if(surface==='management') return [m.workspace===0,m.managementHeaders===1,m.managementHeader?.y===0,near(m.managementHeader?.height,52)];
    return [m.facts===0,near(m.rail?.width,m.width<960?48:260),near(m.header?.height,m.width<960?42:52),near(m.column?.width,m.width<960?m.width-80:768),m.composer?.bottom<=m.height,m.input?.bottom<=m.height,m.scroll?.height>=180,m.scroll?.bottom<=m.composer?.y];
  };
  const record = (name, passed, detail) => {results.push({name,passed,detail});if(!passed)throw Error(`Pencil geometry: ${name}: ${JSON.stringify(detail)}`);};
  const original = await measure();
  record(`${surface}: actual rendered layout passes independent gate`, failures(original).every(Boolean), original);
  const mutations = surface==='conversation' ? [
    ['old 64px compact rail / wide sidebar', `const el=document.querySelector('[data-testid=desktop-sidebar]');window.__u08Style=el.getAttribute('style');el.style.setProperty('transform','scaleX(1.5)','important');`, `const el=document.querySelector('[data-testid=desktop-sidebar]');window.__u08Style===null?el.removeAttribute('style'):el.setAttribute('style',window.__u08Style);`],
    ['S08 facts stacked into S01', `const el=document.createElement('section');el.dataset.testid='desktop-task-facts';el.textContent='Old stacked facts regression';el.id='u08-mutation';document.body.append(el);`, `document.getElementById('u08-mutation').remove();`],
    ['conversation width regression', `const el=document.querySelector('[data-testid=desktop-message-column]');window.__u08Style=el.getAttribute('style');el.style.setProperty('transform','scaleX(.8)','important');`, `const el=document.querySelector('[data-testid=desktop-message-column]');window.__u08Style===null?el.removeAttribute('style'):el.setAttribute('style',window.__u08Style);`]
  ] : [
    ['old double sidebar', `const el=document.createElement('aside');el.dataset.testid='desktop-sidebar';el.textContent='Old workspace navigation';el.id='u08-mutation';document.body.append(el);`, `document.getElementById('u08-mutation').remove();`],
    ['old duplicate page header', `const page=document.querySelector('[data-testid=desktop-settings-page], [data-testid=desktop-capabilities-page]');const el=page.querySelector('header').cloneNode(true);el.id='u08-mutation';page.append(el);`, `document.getElementById('u08-mutation').remove();`]
  ];
  for(const [name,apply,restore] of mutations){
    let mutated;
    try { await evaluate(`(()=>{${apply}return true})()`); mutated=await measure(); }
    finally {await evaluate(`(()=>{${restore}return true})()`);}
    record(`${surface}: rejects live ${name}`, !failures(mutated).every(Boolean), mutated);
    record(`${surface}: layout restored after ${name}`, failures(await measure()).every(Boolean), null);
  }
}
