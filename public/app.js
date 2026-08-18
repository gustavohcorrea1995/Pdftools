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
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
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
  const dz = makeDropzone(root, {
    accept:'.pdf',
    multiple:false,
    label:'Arraste um PDF para editar'
  });

  let fileId = null;
  let pageCount = 0;
  let pageSizes = [];
  let thumbs = [];
  let textBoxes = [];
  let currentPage = 1;
  let selectedId = null;
  const edits = new Map();

  const info = document.createElement('p');
  info.className = 'hint';
  root.appendChild(info);

  const pageNav = document.createElement('div');
  pageNav.className = 'field-row hidden';
  pageNav.innerHTML = `
    <button type="button" id="prevPage">← Página anterior</button>
    <span id="pageIndicator" style="align-self:center"></span>
    <button type="button" id="nextPage">Próxima página →</button>`;
  root.appendChild(pageNav);

  const help = document.createElement('p');
  help.className = 'hint';
  help.textContent =
    'O PDF aparece abaixo. Clique diretamente em qualquer texto para selecionar e editar ou excluir.';
  root.appendChild(help);

  // Container for the real PDF page image.
  const previewWrap = document.createElement('div');
  previewWrap.style.cssText = `
    position:relative;
    display:block;
    width:100%;
    max-width:1100px;
    overflow:auto;
    background:#777;
    border:1px solid rgba(255,255,255,.18);
    padding:10px;
    box-sizing:border-box;
    min-height:120px;
  `;
  root.appendChild(previewWrap);

  const pageCanvas = document.createElement('div');
  pageCanvas.style.cssText = `
    position:relative;
    width:max-content;
    max-width:100%;
    margin:0 auto;
    line-height:0;
  `;
  previewWrap.appendChild(pageCanvas);

  const previewImg = document.createElement('img');
  previewImg.alt = 'Pré-visualização do PDF';
  previewImg.style.cssText = `
    display:block;
    max-width:100%;
    height:auto;
    user-select:none;
    pointer-events:none;
  `;
  pageCanvas.appendChild(previewImg);

  const textLayer = document.createElement('div');
  textLayer.style.cssText = `
    position:absolute;
    inset:0;
    pointer-events:none;
  `;
  pageCanvas.appendChild(textLayer);

  const selected = document.createElement('p');
  selected.className = 'hint';
  selected.textContent = 'Nenhum texto selecionado.';
  root.appendChild(selected);

  const actionRow = document.createElement('div');
  actionRow.className = 'field-row';

  const editBtn = makeButton(actionRow, 'Editar texto selecionado');
  editBtn.disabled = true;
  editBtn.dataset.label = editBtn.textContent;

  const deleteBtn = makeButton(actionRow, 'Excluir texto selecionado');
  deleteBtn.disabled = true;
  deleteBtn.dataset.label = deleteBtn.textContent;

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Limpar seleção';
  actionRow.appendChild(clearBtn);

  root.appendChild(actionRow);

  function scale(){
    if(!previewImg.naturalWidth) return 1;
    return previewImg.clientWidth / previewImg.naturalWidth;
  }

  function selectedBox(){
    return textBoxes.find(t => t.id === selectedId) || null;
  }

  function updateSelection(){
    const t = selectedBox();
    if(!t){
      selected.textContent = 'Nenhum texto selecionado.';
      editBtn.disabled = true;
      deleteBtn.disabled = true;
      return;
    }

    const e = edits.get(t.id);
    selected.textContent =
      `Selecionado: "${e ? (e.deleted ? '[excluir]' : e.text) : t.text}" — página ${t.page}`;
    editBtn.disabled = false;
    deleteBtn.disabled = false;
  }

  function renderTextLayer(){
    textLayer.innerHTML = '';
    const s = scale();

    for(const t of textBoxes){
      if(t.page !== currentPage) continue;

      const e = edits.get(t.id);
      const isDeleted = !!(e && e.deleted);
      const isChanged = !!(e && !e.deleted);
      const value = isDeleted ? '' : (e ? e.text : t.text);

      const box = document.createElement('div');
      box.textContent = value;
      box.title = isDeleted
        ? 'Marcado para exclusão'
        : 'Clique para selecionar este texto';

      box.style.cssText = `
        position:absolute;
        left:${t.x * s}px;
        top:${t.y * s}px;
        width:${Math.max(t.width * s, 5)}px;
        height:${Math.max(t.height * s, 8)}px;
        box-sizing:border-box;
        overflow:hidden;
        white-space:pre-wrap;
        font-family:Arial,sans-serif;
        font-size:${Math.max(t.height * .82 * s, 8)}px;
        line-height:1.05;
        color:${isChanged ? '#111' : 'transparent'};
        background:${isDeleted || isChanged ? '#fff' : 'rgba(255,235,59,.08)'};
        border:${selectedId === t.id
          ? '2px solid #1976d2'
          : (isDeleted ? '2px solid #8b1e1e' : (isChanged ? '1px solid #c1442d' : '1px solid rgba(193,68,45,.22)'))};
        padding:${isChanged ? '1px' : '0'};
        cursor:pointer;
        pointer-events:auto;
        z-index:${selectedId === t.id ? 30 : (isChanged || isDeleted ? 10 : 2)};
      `;

      box.addEventListener('click', (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        selectedId = t.id;
        updateSelection();
        renderTextLayer();
      });

      textLayer.appendChild(box);
    }

    updateSelection();
  }

  function renderPage(){
    if(!thumbs.length) return;

    const url = new URL(thumbs[currentPage - 1], window.location.origin).href;

    previewImg.onload = ()=>{
      previewWrap.style.display = 'block';
      requestAnimationFrame(renderTextLayer);
    };

    previewImg.onerror = ()=>{
      info.textContent =
        'A página não carregou. O servidor não entregou a prévia PNG desta página.';
      textLayer.innerHTML = '';
    };

    previewImg.src = url;

    document.getElementById('pageIndicator').textContent =
      `Página ${currentPage} de ${pageCount}`;
  }

  dz.onchange = async (files)=>{
    if(files.length !== 1) return;

    info.textContent = 'Carregando PDF e preparando a pré-visualização…';
    selectedId = null;
    edits.clear();
    textBoxes = [];
    thumbs = [];

    const fd = new FormData();
    fd.append('file', files[0]);

    try{
      const res = await postForm('/api/inspect', fd);
      if(!res.ok) throw new Error(await res.text());

      const data = await res.json();

      fileId = data.fileId;
      pageCount = data.pageCount;
      pageSizes = data.pageSizes || [];
      thumbs = data.thumbnails || [];
      textBoxes = data.textBoxes || [];
      currentPage = 1;

      if(!thumbs.length){
        throw new Error('O servidor não retornou as páginas do PDF.');
      }

      info.textContent =
        `PDF carregado: ${pageCount} página(s). ${textBoxes.length} texto(s) encontrados.`;

      pageNav.classList.toggle('hidden', pageCount <= 1);
      renderPage();

    }catch(e){
      console.error(e);
      info.textContent = 'Erro ao carregar o PDF.';
      toast(e.message || 'Não foi possível carregar o PDF.', true);
    }
  };

  document.getElementById('prevPage').onclick = ()=>{
    if(currentPage > 1){
      currentPage--;
      selectedId = null;
      renderPage();
    }
  };

  document.getElementById('nextPage').onclick = ()=>{
    if(currentPage < pageCount){
      currentPage++;
      selectedId = null;
      renderPage();
    }
  };

  editBtn.onclick = ()=>{
    const t = selectedBox();
    if(!t) return;

    const old = edits.get(t.id);
    const oldText = old && !old.deleted ? old.text : t.text;

    const value = window.prompt('Digite o novo texto:', oldText);
    if(value === null) return;

    edits.set(t.id, {
      id:t.id,
      page:t.page,
      x:t.pdfX ?? t.x,
      y:t.pdfY ?? t.y,
      width:t.pdfWidth ?? t.width,
      height:t.pdfHeight ?? t.height,
      fontSize:t.fontSize || Math.max(7, t.height),
      text:value,
      deleted:false
    });

    info.textContent =
      'Pré-visualização atualizada. Continue editando ou excluindo outros textos.';
    renderTextLayer();
  };

  deleteBtn.onclick = ()=>{
    const t = selectedBox();
    if(!t) return;

    edits.set(t.id, {
      id:t.id,
      page:t.page,
      x:t.pdfX ?? t.x,
      y:t.pdfY ?? t.y,
      width:t.pdfWidth ?? t.width,
      height:t.pdfHeight ?? t.height,
      fontSize:t.fontSize || Math.max(7, t.height),
      text:'',
      deleted:true
    });

    info.textContent =
      'Texto marcado para exclusão e removido da pré-visualização.';
    renderTextLayer();
  };

  clearBtn.onclick = ()=>{
    selectedId = null;
    renderTextLayer();
  };

  const saveBtn = makeButton(root, 'Salvar PDF editado');
  saveBtn.dataset.label = saveBtn.textContent;

  saveBtn.onclick = async ()=>{
    if(!fileId) return toast('Envie um PDF primeiro.', true);
    if(!edits.size) return toast('Faça pelo menos uma edição ou exclusão.', true);

    const fd = new FormData();
    fd.append('fileId', fileId);
    fd.append('annotations', JSON.stringify([...edits.values()]));

    setLoading(saveBtn, true, 'Gerando PDF…');

    try{
      const res = await postForm('/api/edit/annotate', fd);
      if(!res.ok){
        let msg = 'Falha ao gerar o PDF.';
        try{
          const j = await res.json();
          msg = j.error || msg;
        }catch{}
        throw new Error(msg);
      }

      downloadBlob(await res.blob(), 'editado.pdf');
      toast('PDF editado com sucesso!');
    }catch(e){
      console.error(e);
      toast(e.message, true);
    }

    setLoading(saveBtn, false);
  };
};

