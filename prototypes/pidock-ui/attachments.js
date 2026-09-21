/* THROWAWAY — explicit file selection / paste only; local previews, no upload. */
function addComposerAttachments(files, pasted=false){
  for(const file of files){
    const id=crypto.randomUUID();
    const isImage=file.type.startsWith('image/');
    const name=pasted?`粘贴图片-${id.slice(0,4)}.${file.type.split('/')[1]||'png'}`:file.name;
    task().refs.push({id,type:'attachment',name,file,previewUrl:isImage?URL.createObjectURL(file):null,source:(pasted?'剪贴板图片':'本机所选文件')+' · '+Math.max(1,Math.ceil(file.size/1024))+' KB · 仅本页保留'});
  }
}
function composerAttachments(){
  return `<div class="image-attachments">${task().refs.map((r,i)=>r.previewUrl?`<div class="image-attachment"><button class="image-preview-button" data-action="preview-image:${r.id}" aria-label="预览 ${esc(r.name)}" title="${esc(r.source)}"><img src="${esc(r.previewUrl)}" alt="${esc(r.name)}"><span>${esc(r.name)}</span></button><button class="image-remove" data-action="ref:${i}" aria-label="移除 ${esc(r.name)}" title="移除图片">${icon('close')}</button></div>`:'').join('')}</div><div class="ref-list">${task().refs.map((r,i)=>!r.previewUrl?`<button class="refchip" title="${esc(r.source)}" data-action="ref:${i}">${icon(r.type==='skill'?'book':'file')}${esc(r.name)} ×</button>`:'').join('')}</div>`;
}
function messageAttachments(message){
  return `<div class="message-images">${(message.attachments||[]).map(r=>`<button data-action="preview-image:${r.id}" aria-label="预览 ${esc(r.name)}"><img src="${esc(r.previewUrl)}" alt="${esc(r.name)}"></button>`).join('')}</div>`;
}
function removeAttachment(index){
  const [removed]=task().refs.splice(index,1);
  if(removed?.previewUrl)URL.revokeObjectURL(removed.previewUrl);
  render();document.querySelector('#message-input')?.focus();
}
function attachmentAction(action,id){
  if(action!=='preview-image')return false;
  const r=[...task().refs,...task().messages.filter(m=>m.session===task().session).flatMap(m=>m.attachments||[])].find(r=>r.id===id);
  if(r?.previewUrl)modal(r.name,`<div class="image-lightbox"><img src="${esc(r.previewUrl)}" alt="${esc(r.name)}"></div><p class="note">${esc(r.source)}</p>`);
  return true;
}
document.addEventListener('paste',event=>{
  if(event.target.id!=='message-input'||!event.clipboardData)return;
  const data=event.clipboardData;
  let images=[...data.items].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
  if(!images.length)images=[...data.files].filter(file=>file.type.startsWith('image/'));
  if(!images.length)return; // Keep normal text paste (including its undo behavior).
  event.preventDefault();
  const input=event.target, text=data.getData('text/plain');
  if(text)input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');
  task().draft=input.value;
  const start=input.selectionStart,end=input.selectionEnd;
  addComposerAttachments(images,true);
  state.completion=[];render();
  const next=document.querySelector('#message-input');
  next.focus();next.setSelectionRange(start,end);
  toast(`已粘贴 ${images.length} 张图片，可附上文字后发送`);
});
