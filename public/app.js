const toolGrid = document.getElementById('toolGrid');
const hero = document.getElementById('hero');
const workspace = document.getElementById('workspace');
const toolTitle = document.getElementById('toolTitle');
const toolBody = document.getElementById('toolBody');
const backBtn = document.getElementById('backBtn');
const toastEl = document.getElementById('toast');

function toast(msg, isError=false){
  toastEl.textContent = msg;
  toastEl.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=> toastEl.className='', 3200);
}

const TOOLS = [
  { id:'merge', icon:'🧷', title:'Juntar PDFs', desc:'Combine vários arquivos PDF em um só, na ordem que quiser.', tag:'Organizar' },
  { id:'split', icon:'✂️', title:'Dividir PDF', desc:'Separe páginas em arquivos independentes ou extraia intervalos.', tag:'Organizar' },
  { id:'edit', icon:'🗂️', title:'Organizar páginas', desc:'Exclua, gire e reordene páginas de um PDF.', tag:'Editar' },
  { id:'annotate', icon:'✍️', title:'Adicionar texto/imagem', desc:'Insira texto ou carimbe uma imagem em qualquer página.', tag:'Editar' },
  { id:'compress', icon:'🗜️', title:'Comprimir PDF', desc:'Reduza o tamanho do arquivo mantendo a qualidade legível.', tag:'Otimizar' },
  { id:'images-to-pdf', icon:'🖼️', title:'Imagens → PDF', desc:'Transforme fotos e imagens em um único PDF.', tag:'Converter' },
  { id:'pdf-to-images', icon:'📷', title:'PDF → Imagens', desc:'Exporte cada página como PNG ou JPG.', tag:'Converter' },
  { id:'office-to-pdf', icon:'📝', title:'Word/Excel/PPT → PDF', desc:'Converta documentos do Office para PDF.', tag:'Converter' },
  { id:'pdf-to-office', icon:'📄', title:'PDF → Word', desc:'Converta um PDF de volta para um documento editável.', tag:'Converter' },
];

function renderGrid(){
  toolGrid.innerHTML = '';
  TOOLS.forEach(t=>{
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `<span class="stamp-mark">${t.tag}</span>
      <div class="icon">${t.icon}</div>
      <h3>${t.title}</h3><p>${t.desc}</p>`;
    card.onclick = () => openTool(t.id);
    toolGrid.appendChild(card);
  });
}
renderGrid();

backBtn.onclick = () => {
  workspace.classList.add('hidden');
  hero.classList.remove('hidden');
  toolBody.innerHTML = '';
};

function openTool(id){
  const tool = TOOLS.find(t=>t.id===id);
  hero.classList.add('hidden');
  workspace.classList.remove('hidden');
  toolTitle.textContent = tool.title;
  toolBody.innerHTML = '';
  RENDERERS[id](toolBody);
}

// ---------- generic dropzone ----------
function makeDropzone(container, { accept='*', multiple=true, label='Arraste arquivos aqui ou clique para escolher' }){
  const dz = document.createElement('div');
  dz.className = 'dropzone';
  dz.innerHTML = `<div class="dz-title">${label}</div><p>Seus arquivos ficam só no seu servidor local</p>`;
  const input = document.createElement('input');
  input.type = 'file'; input.accept = accept; input.multiple = multiple; input.style.display='none';
  dz.appendChild(input);
  container.appendChild(dz);

  const list = document.createElement('div');
  list.className = 'file-list';
  container.appendChild(list);

  let files = [];
  function renderList(){
    list.innerHTML = '';
    files.forEach((f,i)=>{
      const row = document.createElement('div');
      row.className='file-row';
      row.innerHTML = `<span class="name">${f.name}</span>`;
      const rm = document.createElement('button');
      rm.textContent = '✕';
      rm.onclick = (e)=>{ e.stopPropagation(); files.splice(i,1); renderList(); dz.onchange && dz.onchange(files); };
      row.appendChild(rm);
      list.appendChild(row);
    });
  }
  dz.onclick = ()=> input.click();
  input.onchange = ()=>{
    files = multiple ? files.concat(Array.from(input.files)) : Array.from(input.files);
    renderList();
    dz.onchange && dz.onchange(files);
    input.value = '';
  };
  ['dragover','dragenter'].forEach(ev => dz.addEventListener(ev, e=>{ e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e=>{ e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e=>{
    const dropped = Array.from(e.dataTransfer.files);
    files = multiple ? files.concat(dropped) : dropped;
    renderList();
    dz.onchange && dz.onchange(files);
  });

  return { getFiles: ()=>files, el: dz };
}

function makeButton(container, text){
  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = text;
  container.appendChild(btn);
  return btn;
}

function setLoading(btn, loading, text){
  btn.disabled = loading;
  btn.innerHTML = loading ? `<span class="spinner"></span>${text||'Processando…'}` : btn.dataset.label;
}

async function postForm(url, formData){
  const res = await fetch(url, { method:'POST', body: formData });
  if(!res.ok){
    let msg = 'Falha ao processar o arquivo.';
    try{ msg = (await res.json()).error || msg; }catch(_){}
    throw new Error(msg);
  }
  return res;
}

function downloadBlob(blob, filename){
  const ext = (filename.match(/\.[^.]+$/)||[''])[0];
  const base = filename.replace(/\.[^.]+$/, '');
  let chosen = window.prompt('Nome do arquivo antes de baixar:', base);
  if(chosen === null) return false;
  chosen = chosen.trim() || base;
  if(!chosen.toLowerCase().endsWith(ext.toLowerCase())) chosen += ext;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = chosen;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
  return true;
}

// ---------- RENDERERS ----------
const RENDERERS = {};

RENDERERS['merge'] = (root)=>{
  const dz = makeDropzone(root, { accept:'.pdf', label:'Arraste 2 ou mais PDFs' });
  const btn = makeButton(root, 'Juntar PDFs');
  btn.dataset.label = btn.textContent;
  btn.onclick = async ()=>{
    const files = dz.getFiles();
    if(files.length < 2) return toast('Selecione pelo menos 2 arquivos PDF.', true);
    const fd = new FormData();
    files.forEach(f=>fd.append('files', f));
    setLoading(btn,true,'Juntando…');
    try{
      const res = await postForm('/api/merge', fd);
      downloadBlob(await res.blob(), 'unido.pdf');
      toast('PDFs unidos com sucesso!');
    }catch(e){ toast(e.message, true); }
    setLoading(btn,false);
  };
};

RENDERERS['split'] = (root)=>{
  const dz = makeDropzone(root, { accept:'.pdf', multiple:false, label:'Arraste um PDF' });
  const field = document.createElement('div');
  field.className='field';
  field.innerHTML = `<label>Intervalos de páginas (ex: 1-3,4,5-6). Deixe em branco para separar todas as páginas.</label>
    <input type="text" id="ranges" placeholder="1-3,4,5-6">`;
  root.appendChild(field);
  const btn = makeButton(root, 'Dividir PDF');
  btn.dataset.label = btn.textContent;
  btn.onclick = async ()=>{
    const files = dz.getFiles();
    if(files.length !== 1) return toast('Selecione um arquivo PDF.', true);
    const fd = new FormData();
    fd.append('file', files[0]);
    fd.append('ranges', document.getElementById('ranges').value);
    setLoading(btn,true,'Dividindo…');
    try{
      const res = await postForm('/api/split', fd);
      downloadBlob(await res.blob(), 'partes.zip');
      toast('PDF dividido com sucesso!');
    }catch(e){ toast(e.message, true); }
    setLoading(btn,false);
  };
};

RENDERERS['compress'] = (root)=>{
  const dz = makeDropzone(root, { accept:'.pdf', multiple:false, label:'Arraste um PDF' });
  const field = document.createElement('div');
  field.className='field';
  field.innerHTML = `<label>Nível de compressão</label>
    <select id="level">
      <option value="screen">Máxima (menor arquivo, qualidade menor)</option>
      <option value="ebook" selected>Equilibrada (recomendado)</option>
      <option value="printer">Leve (qualidade alta)</option>
    </select>`;
  root.appendChild(field);
  const btn = makeButton(root, 'Comprimir PDF');
  btn.dataset.label = btn.textContent;
  btn.onclick = async ()=>{
    const files = dz.getFiles();
    if(files.length !== 1) return toast('Selecione um arquivo PDF.', true);
    const fd = new FormData();
    fd.append('file', files[0]);
    fd.append('level', document.getElementById('level').value);
    setLoading(btn,true,'Comprimindo…');
    try{
      const res = await postForm('/api/compress', fd);
      downloadBlob(await res.blob(), 'comprimido.pdf');
      toast('PDF comprimido com sucesso!');
    }catch(e){ toast(e.message, true); }
    setLoading(btn,false);
  };
};

RENDERERS['images-to-pdf'] = (root)=>{
  const dz = makeDropzone(root, { accept:'image/*', label:'Arraste imagens (JPG, PNG…)' });
  const btn = makeButton(root, 'Converter para PDF');
  btn.dataset.label = btn.textContent;
  btn.onclick = async ()=>{
    const files = dz.getFiles();
    if(files.length < 1) return toast('Selecione pelo menos uma imagem.', true);
    const fd = new FormData();
    files.forEach(f=>fd.append('files', f));
    setLoading(btn,true,'Convertendo…');
    try{
      const res = await postForm('/api/convert/images-to-pdf', fd);
      downloadBlob(await res.blob(), 'imagens.pdf');
      toast('PDF gerado com sucesso!');
    }catch(e){ toast(e.message, true); }
    setLoading(btn,false);
  };
};

RENDERERS['pdf-to-images'] = (root)=>{
  const dz = makeDropzone(root, { accept:'.pdf', multiple:false, label:'Arraste um PDF' });
  const field = document.createElement('div');
  field.className='field';
  field.innerHTML = `<label>Formato de saída</label>
    <select id="fmt"><option value="png">PNG</option><option value="jpg">JPG</option></select>`;
  root.appendChild(field);
  const btn = makeButton(root, 'Exportar páginas');
  btn.dataset.label = btn.textContent;
  btn.onclick = async ()=>{
    const files = dz.getFiles();
    if(files.length !== 1) return toast('Selecione um arquivo PDF.', true);
    const fd = new FormData();
    fd.append('file', files[0]);
    fd.append('format', document.getElementById('fmt').value);
    setLoading(btn,true,'Exportando…');
    try{
      const res = await postForm('/api/convert/pdf-to-images', fd);
      downloadBlob(await res.blob(), 'paginas.zip');
      toast('Imagens exportadas com sucesso!');
    }catch(e){ toast(e.message, true); }
    setLoading(btn,false);
  };
};

RENDERERS['office-to-pdf'] = (root)=>{
  const dz = makeDropzone(root, { accept:'.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt', multiple:false, label:'Arraste um Word, Excel ou PowerPoint' });
  const btn = makeButton(root, 'Converter para PDF');
  btn.dataset.label = btn.textContent;
  btn.onclick = async ()=>{
    const files = dz.getFiles();
    if(files.length !== 1) return toast('Selecione um arquivo.', true);
    const fd = new FormData();
    fd.append('file', files[0]);
    fd.append('target', 'pdf');
    setLoading(btn,true,'Convertendo…');
    try{
      const res = await postForm('/api/convert/office', fd);
      downloadBlob(await res.blob(), 'convertido.pdf');
      toast('Arquivo convertido com sucesso!');
    }catch(e){ toast(e.message, true); }
    setLoading(btn,false);
  };
};

RENDERERS['pdf-to-office'] = (root)=>{
  const dz = makeDropzone(root, { accept:'.pdf', multiple:false, label:'Arraste um PDF' });
  const field = document.createElement('div');
  field.className='field';
  field.innerHTML = `<label>Converter para</label>
    <select id="target">
      <option value="docx">Word (.docx)</option>
      <option value="odt">OpenDocument (.odt)</option>
    </select>`;
  root.appendChild(field);
  const hint = document.createElement('p');
  hint.className='hint';
  hint.textContent = 'A fidelidade do layout depende da complexidade do PDF original — PDFs com texto simples convertem melhor.';
  root.appendChild(hint);
  const btn = makeButton(root, 'Converter');
  btn.dataset.label = btn.textContent;
  btn.onclick = async ()=>{
    const files = dz.getFiles();
    if(files.length !== 1) return toast('Selecione um arquivo PDF.', true);
    const fd = new FormData();
    fd.append('file', files[0]);
    fd.append('target', document.getElementById('target').value);
    setLoading(btn,true,'Convertendo…');
    try{
      const res = await postForm('/api/convert/office', fd);
      downloadBlob(await res.blob(), 'convertido.' + document.getElementById('target').value);
      toast('Arquivo convertido com sucesso!');
    }catch(e){ toast(e.message, true); }
    setLoading(btn,false);
  };
};

// ---------- Organizar páginas (delete/rotate/reorder) ----------
RENDERERS['edit'] = (root)=>{
  const dz = makeDropzone(root, { accept:'.pdf', multiple:false, label:'Arraste um PDF para organizar' });
  const grid = document.createElement('div');
  grid.className = 'pages-grid';
  root.appendChild(grid);

  let state = { pageCount:0, thumbs:[], order:[], rotations:{}, deleted:new Set() };

  dz.onchange = async (files)=>{
    if(files.length !== 1) return;
    grid.innerHTML = '<p class="hint">Carregando páginas…</p>';
    const fd = new FormData();
    fd.append('file', files[0]);
    try{
      const res = await postForm('/api/inspect', fd);
      const data = await res.json();
      state.pageCount = data.pageCount;
      state.thumbs = data.thumbnails;
      state.order = Array.from({length:data.pageCount}, (_,i)=>i+1);
      state.rotations = {};
      state.deleted = new Set();
      renderPages();
    }catch(e){ toast(e.message, true); grid.innerHTML=''; }
  };

  function renderPages(){
    grid.innerHTML = '';
    state.order.forEach((pageNum, idx)=>{
      const div = document.createElement('div');
      div.className = 'page-thumb' + (state.deleted.has(pageNum) ? ' marked' : '');
      const rot = state.rotations[pageNum] || 0;
      div.innerHTML = `
        <img src="${state.thumbs[pageNum-1]}" style="transform:rotate(${rot}deg)">
        <div class="pnum">Pág. ${pageNum}</div>
        <div class="actions">
          <button data-a="left">↺</button>
          <button data-a="right">↻</button>
          <button data-a="up">←</button>
          <button data-a="down">→</button>
          <button data-a="del">${state.deleted.has(pageNum)?'↩':'✕'}</button>
        </div>`;
      div.querySelector('[data-a=left]').onclick = ()=>{ state.rotations[pageNum]=((rot-90)%360+360)%360; renderPages(); };
      div.querySelector('[data-a=right]').onclick = ()=>{ state.rotations[pageNum]=((rot+90)%360+360)%360; renderPages(); };
      div.querySelector('[data-a=up]').onclick = ()=>{ if(idx>0){ [state.order[idx-1],state.order[idx]]=[state.order[idx],state.order[idx-1]]; renderPages(); } };
      div.querySelector('[data-a=down]').onclick = ()=>{ if(idx<state.order.length-1){ [state.order[idx+1],state.order[idx]]=[state.order[idx],state.order[idx+1]]; renderPages(); } };
      div.querySelector('[data-a=del]').onclick = ()=>{ state.deleted.has(pageNum) ? state.deleted.delete(pageNum) : state.deleted.add(pageNum); renderPages(); };
      grid.appendChild(div);
    });
  }

  const btn = makeButton(root, 'Aplicar alterações');
  btn.dataset.label = btn.textContent;
  btn.onclick = async ()=>{
    const files = dz.getFiles();
    if(!state.pageCount) return toast('Envie um PDF primeiro.', true);
    const fd = new FormData();
    fd.append('file', files[files.length-1]);
    fd.append('operations', JSON.stringify({
      keepOrder: state.order,
      delete: Array.from(state.deleted),
      rotations: state.rotations
    }));
    setLoading(btn,true,'Aplicando…');
    try{
      const res = await postForm('/api/pages/edit', fd);
      downloadBlob(await res.blob(), 'editado.pdf');
      toast('Alterações aplicadas com sucesso!');
    }catch(e){ toast(e.message, true); }
    setLoading(btn,false);
  };
};

// ---------- Adicionar texto/imagem (editor visual: clique na página para posicionar) ----------
RENDERERS['annotate'] = (root)=>{
  const dz = makeDropzone(root, { accept:'.pdf', multiple:false, label:'Arraste um PDF para editar' });

  let fileId = null;
  let pageCount = 0;
  let pageSizes = [];
  let thumbs = [];
  let textBoxes = [];
  let currentPage = 1;
  let deleted = new Set();
  let replacements = new Map();
  let markerPt = null;
  let previewBusy = false;

  const info = document.createElement('p');
  info.className='hint';
  root.appendChild(info);

  const toolbar = document.createElement('div');
  toolbar.className='field-row';
  toolbar.innerHTML = `
    <button type="button" class="btn-ghost" id="prevPage">← Página anterior</button>
    <span id="pageIndicator" style="align-self:center"></span>
    <button type="button" class="btn-ghost" id="nextPage">Próxima página →</button>
  `;
  root.appendChild(toolbar);

  const help = document.createElement('p');
  help.className='hint';
  help.innerHTML = '<b>Como editar:</b> clique diretamente em cima do texto. Depois escolha <b>Excluir</b> ou <b>Editar</b>. As alterações já aparecem na pré-visualização antes de salvar.';
  root.appendChild(help);

  const previewWrap = document.createElement('div');
  previewWrap.style.cssText='position:relative;display:block;width:max-content;max-width:100%;border:1px solid var(--line,#3a4552);background:#fff;overflow:auto;';
  root.appendChild(previewWrap);

  const previewImg = document.createElement('img');
  previewImg.style.cssText='display:block;max-width:100%;height:auto;user-select:none;';
  previewWrap.appendChild(previewImg);

  const overlay = document.createElement('div');
  overlay.style.cssText='position:absolute;inset:0;pointer-events:none;';
  previewWrap.appendChild(overlay);

  const selectedBox = document.createElement('div');
  selectedBox.style.cssText='position:absolute;display:none;border:2px solid #d94a31;background:rgba(217,74,49,.10);pointer-events:none;box-sizing:border-box;';
  overlay.appendChild(selectedBox);

  const selectedLabel = document.createElement('div');
  selectedLabel.style.cssText='position:absolute;left:0;top:-28px;background:#d94a31;color:#fff;padding:4px 8px;border-radius:5px;font:12px Arial;white-space:nowrap;';
  selectedBox.appendChild(selectedLabel);

  const controls = document.createElement('div');
  controls.className='field-row';
  controls.style.marginTop='12px';
  controls.innerHTML=`
    <button type="button" class="btn" id="editSelected">Editar texto selecionado</button>
    <button type="button" class="btn" id="deleteSelected">Excluir texto selecionado</button>
    <button type="button" class="btn-ghost" id="clearSelection">Limpar seleção</button>
  `;
  root.appendChild(controls);

  const addTitle = document.createElement('p');
  addTitle.className='hint';
  addTitle.textContent='Adicionar texto/imagem: clique em uma área livre da página.';
  root.appendChild(addTitle);

  const row1=document.createElement('div'); row1.className='field-row';
  row1.innerHTML=`
    <div class="field"><label>Texto novo</label><input type="text" id="newText" placeholder="Digite o texto"></div>
    <div class="field"><label>Tamanho</label><input type="number" id="newSize" value="16" min="4"></div>
  `;
  root.appendChild(row1);

  const imgField=document.createElement('div'); imgField.className='field';
  imgField.innerHTML='<label>Imagem/carimbo (opcional, PNG ou JPG)</label>';
  const imgInput=document.createElement('input'); imgInput.type='file'; imgInput.accept='image/png,image/jpeg';
  imgField.appendChild(imgInput); root.appendChild(imgField);

  const saveBtn=makeButton(root,'Salvar PDF editado');
  saveBtn.dataset.label=saveBtn.textContent;

  let selected = null;

  function setSelected(box){
    selected=box;
    if(!box){ selectedBox.style.display='none'; return; }
    const rect=previewImg.getBoundingClientRect();
    const scaleX=rect.width/pageSizes[currentPage-1].width;
    const scaleY=rect.height/pageSizes[currentPage-1].height;
    selectedBox.style.display='block';
    selectedBox.style.left=(box.x*scaleX)+'px';
    selectedBox.style.top=(box.y*scaleY)+'px';
    selectedBox.style.width=(box.width*scaleX)+'px';
    selectedBox.style.height=(box.height*scaleY)+'px';
    selectedLabel.textContent=box.text || 'texto';
  }

  function renderTextBoxes(){
    overlay.querySelectorAll('.text-hit').forEach(e=>e.remove());
    if(!pageSizes.length) return;
    const rect=previewImg.getBoundingClientRect();
    const size=pageSizes[currentPage-1];
    const sx=rect.width/size.width, sy=rect.height/size.height;
    textBoxes.filter(b=>b.page===currentPage && !deleted.has(b.id)).forEach(box=>{
      const hit=document.createElement('div');
      hit.className='text-hit';
      hit.title='Clique para editar/excluir';
      hit.style.cssText=`position:absolute;left:${box.x*sx}px;top:${box.y*sy}px;width:${Math.max(4,box.width*sx)}px;height:${Math.max(6,box.height*sy)}px;border:1px solid rgba(217,74,49,.28);background:rgba(255,210,180,.08);pointer-events:auto;cursor:pointer;box-sizing:border-box;`;
      hit.onclick=(e)=>{e.stopPropagation(); setSelected(box);};
      overlay.appendChild(hit);
    });
    if(selected && selected.page===currentPage && !deleted.has(selected.id)) setSelected(selected);
    else if(!selected || selected.page!==currentPage || deleted.has(selected.id)) setSelected(null);
  }

  async function refreshPreview(){
    if(!fileId) return;
    const ops=[];
    textBoxes.forEach(b=>{
      if(deleted.has(b.id)) ops.push({type:'redact',id:b.id,page:b.page,x:b.x,y:b.y,width:b.width,height:b.height});
      const replacement=replacements.get(b.id);
      if(replacement!==undefined && !deleted.has(b.id)) ops.push({type:'replace',id:b.id,page:b.page,x:b.x,y:b.y,width:b.width,height:b.height,fontSize:b.fontSize,text:replacement});
    });
    if(!ops.length){ previewImg.src=thumbs[currentPage-1]+'?t='+Date.now(); return; }
    previewBusy=true;
    info.textContent='Renderizando pré-visualização…';
    const fd=new FormData();
    fd.append('fileId',fileId);
    fd.append('page',String(currentPage));
    fd.append('operations',JSON.stringify(ops));
    try{
      const res=await postForm('/api/edit/preview',fd);
      const blob=await res.blob();
      const url=URL.createObjectURL(blob);
      previewImg.onload=()=>{ URL.revokeObjectURL(url); renderTextBoxes(); };
      previewImg.src=url;
      info.textContent='Pré-visualização atualizada. A remoção será aplicada de forma permanente ao salvar.';
    }catch(e){ toast(e.message,true); }
    finally{ previewBusy=false; }
  }

  function renderPage(){
    previewImg.src=thumbs[currentPage-1]+'?t='+Date.now();
    document.getElementById('pageIndicator').textContent=`Página ${currentPage} de ${pageCount}`;
    setSelected(null);
    markerPt=null;
    setTimeout(renderTextBoxes,120);
  }

  dz.onchange=async(files)=>{
    if(files.length!==1) return;
    info.textContent='Carregando PDF…';
    const fd=new FormData(); fd.append('file',files[0]);
    try{
      const res=await postForm('/api/inspect',fd);
      const data=await res.json();
      fileId=data.fileId; pageCount=data.pageCount; pageSizes=data.pageSizes;
      thumbs=data.thumbnails; textBoxes=data.textBoxes||[];
      currentPage=1; deleted=new Set(); replacements=new Map();
      info.textContent=`PDF carregado (${pageCount} página(s)). As caixas ficam sobre o texto encontrado.`;
      renderPage();
    }catch(e){ toast(e.message,true); info.textContent=''; }
  };

  previewImg.onload=()=>renderTextBoxes();

  previewWrap.addEventListener('click',(e)=>{
    if(!fileId || !pageSizes.length) return;
    if(e.target.closest('.text-hit')) return;
    const rect=previewImg.getBoundingClientRect();
    const size=pageSizes[currentPage-1];
    const x=(e.clientX-rect.left)/rect.width*size.width;
    const y=(e.clientY-rect.top)/rect.height*size.height;
    markerPt={x,y};
    const text=document.getElementById('newText').value.trim();
    if(!text && !imgInput.files[0]) return;
    const op={page:currentPage,type:'text',x,y,size:Number(document.getElementById('newSize').value)||16,text,color:[0.1,0.1,0.1]};
    if(imgInput.files[0]) op.type='image';
    // Conteúdo novo fica armazenado para o salvamento. A prévia dele será gerada ao salvar.
    pendingNew.push(op);
    document.getElementById('newText').value='';
    toast('Conteúdo adicionado à edição.');
  });

  const pendingNew=[];

  document.getElementById('prevPage').onclick=()=>{if(currentPage>1){currentPage--;renderPage();}};
  document.getElementById('nextPage').onclick=()=>{if(currentPage<pageCount){currentPage++;renderPage();}};

  document.getElementById('deleteSelected').onclick=async()=>{
    if(!selected) return toast('Clique primeiro no texto que deseja excluir.',true);
    deleted.add(selected.id); replacements.delete(selected.id);
    setSelected(null); renderTextBoxes(); await refreshPreview();
  };

  document.getElementById('editSelected').onclick=async()=>{
    if(!selected) return toast('Clique primeiro no texto que deseja editar.',true);
    const value=window.prompt('Digite o novo texto:',replacements.get(selected.id) ?? selected.text);
    if(value===null) return;
    replacements.set(selected.id,value);
    await refreshPreview();
  };

  document.getElementById('clearSelection').onclick=()=>setSelected(null);

  saveBtn.onclick=async()=>{
    if(!fileId) return toast('Envie um PDF primeiro.',true);
    const ops=[];
    textBoxes.forEach(b=>{
      if(deleted.has(b.id)) ops.push({type:'redact',id:b.id,page:b.page,x:b.x,y:b.y,width:b.width,height:b.height});
      const replacement=replacements.get(b.id);
      if(replacement!==undefined && !deleted.has(b.id)) ops.push({type:'replace',id:b.id,page:b.page,x:b.x,y:b.y,width:b.width,height:b.height,fontSize:b.fontSize,text:replacement});
    });
    ops.push(...pendingNew);
    if(!ops.length) return toast('Nenhuma alteração foi feita.',true);

    const fd=new FormData();
    fd.append('fileId',fileId);
    fd.append('operations',JSON.stringify(ops));
    if(imgInput.files[0]) fd.append('image',imgInput.files[0]);

    setLoading(saveBtn,true,'Salvando…');
    try{
      const res=await postForm('/api/edit/annotate',fd);
      const ok=downloadBlob(await res.blob(),'editado.pdf');
      if(ok) toast('PDF editado e baixado com sucesso!');
    }catch(e){toast(e.message,true);}
    setLoading(saveBtn,false);
  };
};

