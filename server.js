const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const archiver = require('archiver');
const { execFile } = require('child_process');
const { PDFDocument, degrees, rgb, StandardFonts } = require('pdf-lib');

const app = express();
const PORT = process.env.PORT || 3000;

const UP = path.join(__dirname, 'uploads');
const TMP = path.join(__dirname, 'tmp');
[UP, TMP].forEach(d => fs.mkdirSync(d, { recursive: true }));

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UP),
    filename: (req, file, cb) => cb(null, uuid() + path.extname(file.originalname))
  }),
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB
});

// ---------- helpers ----------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 200 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

function cleanup(...files) {
  files.forEach(f => {
    if (!f) return;
    fs.rm(f, { recursive: true, force: true }, () => {});
  });
}

function parseRanges(str, pageCount) {
  // "1-3,5,7-8" -> array of arrays of 0-indexed page numbers, one group per PDF output
  return str.split(',').map(s => s.trim()).filter(Boolean).map(part => {
    const [a, b] = part.split('-').map(n => parseInt(n, 10));
    const start = Math.max(1, a);
    const end = Math.min(pageCount, b || a);
    const arr = [];
    for (let i = start; i <= end; i++) arr.push(i - 1);
    return arr;
  });
}

async function sendFileAndCleanup(res, filePath, downloadName, extraFiles = []) {
  try {
    // Envia o PDF diretamente na resposta antes de apagar o temporário.
    // Isso evita falhas de download no Render causadas pelo res.download()
    // enquanto o arquivo temporário é removido.
    const data = await fs.promises.readFile(filePath);

    res.status(200);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'Content-Length': data.length,
      'Cache-Control': 'no-store'
    });

    res.end(data);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  } finally {
    cleanup(filePath, ...extraFiles);
  }
}

// ---------- MERGE ----------
app.post('/api/merge', upload.array('files'), async (req, res) => {
  const inputs = req.files.map(f => f.path);
  try {
    const merged = await PDFDocument.create();
    for (const file of req.files) {
      const bytes = fs.readFileSync(file.path);
      const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    const outBytes = await merged.save();
    const outPath = path.join(TMP, uuid() + '.pdf');
    fs.writeFileSync(outPath, outBytes);
    sendFileAndCleanup(res, outPath, 'unido.pdf', inputs);
  } catch (e) {
    cleanup(...inputs);
    res.status(500).json({ error: e.message });
  }
});

// ---------- SPLIT ----------
app.post('/api/split', upload.single('file'), async (req, res) => {
  const inputPath = req.file.path;
  try {
    const bytes = fs.readFileSync(inputPath);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageCount = src.getPageCount();
    const ranges = req.body.ranges
      ? parseRanges(req.body.ranges, pageCount)
      : src.getPageIndices().map(i => [i]); // no ranges = one PDF per page

    const zipPath = path.join(TMP, uuid() + '.zip');
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip');
    archive.pipe(output);

    for (let i = 0; i < ranges.length; i++) {
      const doc = await PDFDocument.create();
      const pages = await doc.copyPages(src, ranges[i]);
      pages.forEach(p => doc.addPage(p));
      const outBytes = await doc.save();
      archive.append(Buffer.from(outBytes), { name: `parte_${i + 1}.pdf` });
    }
    await archive.finalize();
    output.on('close', () => sendFileAndCleanup(res, zipPath, 'partes.zip', [inputPath]));
  } catch (e) {
    cleanup(inputPath);
    res.status(500).json({ error: e.message });
  }
});

// ---------- PAGE OPS: delete / rotate / reorder ----------
app.post('/api/pages/edit', upload.single('file'), async (req, res) => {
  // body: operations = JSON { keepOrder: [1,3,2], rotations: {"1": 90}, delete: [4] }
  const inputPath = req.file.path;
  try {
    const bytes = fs.readFileSync(inputPath);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageCount = src.getPageCount();
    const ops = JSON.parse(req.body.operations || '{}');
    const deleteSet = new Set((ops.delete || []).map(n => n - 1));
    let order = ops.keepOrder ? ops.keepOrder.map(n => n - 1) : src.getPageIndices();
    order = order.filter(i => !deleteSet.has(i));

    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, order);
    pages.forEach((p, idx) => {
      const originalPageNum = order[idx] + 1;
      const rot = ops.rotations && ops.rotations[originalPageNum];
      if (rot) p.setRotation(degrees((p.getRotation().angle + rot) % 360));
      out.addPage(p);
    });
    const outBytes = await out.save();
    const outPath = path.join(TMP, uuid() + '.pdf');
    fs.writeFileSync(outPath, outBytes);
    sendFileAndCleanup(res, outPath, 'editado.pdf', [inputPath]);
  } catch (e) {
    cleanup(inputPath);
    res.status(500).json({ error: e.message });
  }
});

// ---------- COMPRESS (ghostscript) ----------
app.post('/api/compress', upload.single('file'), async (req, res) => {
  const inputPath = req.file.path;
  const level = req.body.level || 'ebook'; // screen | ebook | printer
  const outPath = path.join(TMP, uuid() + '.pdf');
  try {
    await run('gs', [
      '-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4',
      `-dPDFSETTINGS=/${level}`,
      '-dNOPAUSE', '-dQUIET', '-dBATCH',
      `-sOutputFile=${outPath}`, inputPath
    ]);
    sendFileAndCleanup(res, outPath, 'comprimido.pdf', [inputPath]);
  } catch (e) {
    cleanup(inputPath, outPath);
    res.status(500).json({ error: e.message });
  }
});

// ---------- CONVERT: images -> pdf ----------
app.post('/api/convert/images-to-pdf', upload.array('files'), async (req, res) => {
  const inputs = req.files.map(f => f.path);
  try {
    const sharp = require('sharp');
    const doc = await PDFDocument.create();
    for (const file of req.files) {
      const buf = await sharp(file.path).jpeg({ quality: 90 }).toBuffer();
      const img = await doc.embedJpg(buf);
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
    const outBytes = await doc.save();
    const outPath = path.join(TMP, uuid() + '.pdf');
    fs.writeFileSync(outPath, outBytes);
    sendFileAndCleanup(res, outPath, 'imagens.pdf', inputs);
  } catch (e) {
    cleanup(...inputs);
    res.status(500).json({ error: e.message });
  }
});

// ---------- CONVERT: pdf -> images (poppler) ----------
app.post('/api/convert/pdf-to-images', upload.single('file'), async (req, res) => {
  const inputPath = req.file.path;
  const format = (req.body.format || 'png').toLowerCase();
  const workDir = path.join(TMP, uuid());
  fs.mkdirSync(workDir);
  try {
    const flag = format === 'jpg' || format === 'jpeg' ? '-jpeg' : '-png';
    await run('pdftoppm', [flag, '-r', '150', inputPath, path.join(workDir, 'page')]);
    const zipPath = path.join(TMP, uuid() + '.zip');
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip');
    archive.pipe(output);
    fs.readdirSync(workDir).forEach(f => archive.file(path.join(workDir, f), { name: f }));
    await archive.finalize();
    output.on('close', () => sendFileAndCleanup(res, zipPath, 'paginas.zip', [inputPath, workDir]));
  } catch (e) {
    cleanup(inputPath, workDir);
    res.status(500).json({ error: e.message });
  }
});

// ---------- CONVERT: office <-> pdf (LibreOffice headless) ----------
app.post('/api/convert/office', upload.single('file'), async (req, res) => {
  // target: pdf | docx | pptx | xlsx | odt
  const inputPath = req.file.path;
  const target = (req.body.target || 'pdf').toLowerCase();
  const workDir = path.join(TMP, uuid());
  fs.mkdirSync(workDir);
  try {
    const args = ['--headless', '--norestore'];
    // Converting FROM pdf TO an editable format needs an explicit import filter,
    // otherwise LibreOffice can't find an export chain and silently fails.
    if (path.extname(inputPath).toLowerCase() === '.pdf' && target !== 'pdf') {
      args.push('--infilter=writer_pdf_import');
    }
    args.push('--convert-to', target, '--outdir', workDir, inputPath);
    await run('soffice', args);
    const produced = fs.readdirSync(workDir)[0];
    if (!produced) throw new Error('A conversão não gerou saída. Verifique o formato do arquivo.');
    const outPath = path.join(workDir, produced);
    sendFileAndCleanup(res, outPath, produced, [inputPath, workDir]);
  } catch (e) {
    cleanup(inputPath, workDir);
    res.status(500).json({ error: e.message });
  }
});

// ---------- INSPECT: page count + thumbnails for the editor ----------
app.post('/api/inspect', upload.single('file'), async (req, res) => {
  const inputPath = req.file.path;
  const id = uuid();
  const workDir = path.join(UP, 'thumbs_' + id);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const bytes = fs.readFileSync(inputPath);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageCount = src.getPageCount();

    // Renderiza cada página para o editor visual.
    await run('pdftoppm', [
      '-png',
      '-r', '120',
      inputPath,
      path.join(workDir, 'p')
    ]);

    const files = fs.readdirSync(workDir)
      .filter(f => f.toLowerCase().endsWith('.png'))
      .sort();

    const finalName = id + '.pdf';
    fs.copyFileSync(inputPath, path.join(UP, finalName));

    const pageSizes = src.getPages().map(p => {
      const { width, height } = p.getSize();
      return { width, height };
    });

    // Extrai as caixas de texto existentes.
    let textBoxes = [];

    try {
      const bboxPath = path.join(workDir, 'bbox.html');

      await run('pdftotext', [
        '-bbox',
        '-enc', 'UTF-8',
        inputPath,
        bboxPath
      ]);

      const html = fs.readFileSync(bboxPath, 'utf8');

      const pages = [
        ...html.matchAll(/<page[^>]*>([\s\S]*?)<\/page>/gi)
      ];

      pages.forEach((pageMatch, pageIndex) => {
        const words = [
          ...pageMatch[1].matchAll(
            /<word[^>]*xMin="([0-9.]+)"[^>]*yMin="([0-9.]+)"[^>]*xMax="([0-9.]+)"[^>]*yMax="([0-9.]+)"[^>]*>([\s\S]*?)<\/word>/gi
          )
        ];

        words.forEach((w, wordIndex) => {
          const text = w[5]
            .replace(/<[^>]+>/g, '')
            .trim();

          if(!text) return;

          const pdfX = parseFloat(w[1]);
          const pdfY = parseFloat(w[2]);
          const pdfXMax = parseFloat(w[3]);
          const pdfYMax = parseFloat(w[4]);

          // A página é renderizada pelo pdftoppm a 120 DPI.
          // A tela trabalha em pixels; a redação do PDF trabalha em pontos.
          const PT_TO_PX = 120 / 72;

          textBoxes.push({
            id: `p${pageIndex + 1}-w${wordIndex + 1}`,
            page: pageIndex + 1,

            // Coordenadas em pixels para a caixa ficar exatamente sobre o texto.
            x: pdfX * PT_TO_PX,
            y: pdfY * PT_TO_PX,
            width: Math.max(1, (pdfXMax - pdfX) * PT_TO_PX),
            height: Math.max(1, (pdfYMax - pdfY) * PT_TO_PX),

            // Coordenadas originais do PDF para editar/excluir de verdade.
            pdfX,
            pdfY,
            pdfWidth: Math.max(1, pdfXMax - pdfX),
            pdfHeight: Math.max(1, pdfYMax - pdfY),

            text,
            fontSize: Math.max(6, pdfYMax - pdfY)
          });
        });
      });
    } catch(err) {
      console.log('PDF sem camada de texto ou falha no OCR:', err.message);
    }

    res.json({
      fileId: finalName,
      pageCount,
      pageSizes,
      thumbnails: files.map((f, index) =>
        `/api/preview/${finalName}/${index + 1}`
      ),
      textBoxes
    });

  } catch(e) {
    res.status(500).json({ error: e.message });
  } finally {
    cleanup(inputPath);
  }
});


// ---------- PREVIEW: entrega as páginas renderizadas do editor ----------
app.get('/api/preview/:id/:page', async (req, res) => {
  const id = req.params.id.replace(/\.pdf$/i, '');
  const page = Number(req.params.page);

  if(!Number.isInteger(page) || page < 1){
    return res.status(400).send('Página inválida.');
  }

  const pdfPath = path.join(UP, id + '.pdf');
  if(!fs.existsSync(pdfPath)){
    return res.status(404).send('PDF não encontrado. Envie o PDF novamente.');
  }

  const thumbsDir = path.join(UP, 'thumbs_' + id);
  const cachedPath = path.join(thumbsDir, `p-${page}.png`);

  try{
    // Primeiro usa a imagem já criada no /inspect.
    if(fs.existsSync(cachedPath)){
      const data = await fs.promises.readFile(cachedPath);
      res.set({
        'Content-Type':'image/png',
        'Cache-Control':'no-store'
      });
      return res.end(data);
    }

    // Se a imagem não existir (por exemplo, o Render limpou o diretório
    // temporário), renderiza a página novamente a partir do PDF original.
    const tmpPrefix = path.join(TMP, uuid() + '-page');

    try{
      await run('pdftoppm', [
        '-f', String(page),
        '-singlefile',
        '-png',
        '-r', '120',
        pdfPath,
        tmpPrefix
      ]);

      const pngPath = tmpPrefix + '.png';

      if(!fs.existsSync(pngPath)){
        return res.status(500).send('Não foi possível renderizar a página do PDF.');
      }

      const data = await fs.promises.readFile(pngPath);

      res.set({
        'Content-Type':'image/png',
        'Content-Length':data.length,
        'Cache-Control':'no-store'
      });

      res.end(data);
    } finally {
      cleanup(tmpPrefix + '.png');
    }
  }catch(e){
    console.error('Erro ao renderizar preview:', e);
    if(!res.headersSent){
      res.status(500).send('Erro ao renderizar a página: ' + e.message);
    }
  }
});


// ---------- EDITOR VISUAL: redação real + edição + pré-visualização ----------
async function loadMuPDF(){
  const mod = await import('mupdf');
  return mod.default || mod;
}

function normalizeRect(a){
  const x = Math.max(0, Number(a.x) || 0);
  const y = Math.max(0, Number(a.y) || 0);
  const width = Math.max(1, Number(a.width) || 1);
  const height = Math.max(1, Number(a.height) || 1);
  return [x, y, x + width, y + height];
}

async function applyRedactionsToPdf(inputBytes, operations){
  const mupdf = await loadMuPDF();
  const doc = mupdf.Document.openDocument(inputBytes, 'application/pdf');

  try {
    const byPage = new Map();
    for(const op of (operations || [])){
      if(op.type !== 'redact' && op.type !== 'replace') continue;
      const pageNum = Number(op.page);
      if(!Number.isInteger(pageNum) || pageNum < 1 || pageNum > doc.countPages()) continue;
      if(!byPage.has(pageNum)) byPage.set(pageNum, []);
      byPage.get(pageNum).push(op);
    }

    for(const [pageNum, ops] of byPage){
      const page = doc.loadPage(pageNum - 1);
      try{
        for(const op of ops){
          const redact = page.createAnnotation('Redact');
          redact.setRect(normalizeRect(op));
          redact.update();
        }
        // Sem caixa preta: remove o conteúdo atingido sem desenhar uma tarja.
        page.applyRedactions(false);
      } finally {
        page.destroy();
      }
    }

    return Buffer.from(doc.saveToBuffer('').asUint8Array());
  } finally {
    doc.destroy();
  }
}

async function renderPdfPage(pdfBytes, pageNumber){
  const id = uuid();
  const pdfPath = path.join(TMP, id + '.pdf');
  const prefix = path.join(TMP, id + '-page');
  fs.writeFileSync(pdfPath, pdfBytes);
  try{
    await run('pdftoppm', ['-f', String(pageNumber), '-singlefile', '-png', '-r', '120', pdfPath, prefix]);
    const pngPath = prefix + '.png';
    const data = await fs.promises.readFile(pngPath);
    return data;
  } finally {
    cleanup(pdfPath, prefix + '.png');
  }
}

// Pré-visualiza as alterações já aplicadas no PDF real antes de salvar.
app.post('/api/edit/preview', async (req, res) => {
  try{
    const { fileId, operations, page } = req.body;
    const filePath = path.join(UP, fileId);
    if(!fs.existsSync(filePath)) return res.status(400).json({error:'Arquivo não encontrado. Reenvie o PDF.'});

    const original = fs.readFileSync(filePath);
    const ops = JSON.parse(operations || '[]');

    // Remove o conteúdo original primeiro (redaction real).
    let previewBytes = await applyRedactionsToPdf(original, ops);

    // Para a prévia, redesenha somente os textos substituídos.
    const previewDoc = await PDFDocument.load(previewBytes, {ignoreEncryption:true});
    const previewFont = await previewDoc.embedFont(StandardFonts.Helvetica);

    for(const op of ops){
      if(op.type !== 'replace') continue;
      const p = previewDoc.getPage(Number(op.page) - 1);
      if(!p) continue;
      const {height} = p.getSize();
      const x = Number(op.x) || 0;
      const y = Number(op.y) || 0;
      const size = Number(op.fontSize) || Math.max(7, Number(op.height) || 12);
      const text = String(op.text ?? '');
      if(!text) continue;
      p.drawText(text, {
        x,
        y: height - y - size,
        size,
        font: previewFont,
        color: rgb(0.1,0.1,0.1)
      });
    }

    previewBytes = await previewDoc.save();
    const png = await renderPdfPage(previewBytes, Number(page) || 1);
    res.set({'Content-Type':'image/png','Cache-Control':'no-store'});
    res.end(png);
  }catch(e){
    console.error('Falha na pré-visualização:', e);
    res.status(500).json({error:e.message});
  }
});

// Salva as alterações no PDF. A exclusão usa REDACT e remove o conteúdo de verdade.
app.post('/api/edit/annotate', upload.single('image'), async (req, res) => {
  try{
    const { fileId } = req.body;
    const filePath = path.join(UP, fileId);
    if(!fs.existsSync(filePath)) return res.status(400).json({error:'Arquivo não encontrado. Reenvie o PDF.'});

    let rawOps = req.body.operations || req.body.annotations || '[]';
    let parsedOps = typeof rawOps === 'string' ? JSON.parse(rawOps) : rawOps;

    // Aceita o formato usado pelo editor visual: deleted=true para excluir
    // e text alterado para substituir. Mantém compatibilidade com operações
    // já tipadas (redact/replace/text/image).
    const ops = (parsedOps || []).map(a => {
      if(a.type) return a;

      const base = {
        page: Number(a.page),
        x: Number(a.pdfX ?? a.x),
        y: Number(a.pdfY ?? a.y),
        width: Number(a.pdfWidth ?? a.width),
        height: Number(a.pdfHeight ?? a.height),
        fontSize: Number(a.fontSize) || Math.max(7, Number(a.height) || 12)
      };

      if(a.deleted){
        return {...base, type:'redact', text:''};
      }

      return {...base, type:'replace', text:String(a.text ?? '')};
    });
    const original = fs.readFileSync(filePath);

    // Primeiro remove permanentemente o conteúdo selecionado.
    let editedBytes = await applyRedactionsToPdf(original, ops);

    // Depois mantém o suporte a inserir/substituir texto e imagem.
    const doc = await PDFDocument.load(editedBytes, {ignoreEncryption:true});
    const font = await doc.embedFont(StandardFonts.Helvetica);

    for(const a of ops){
      const page = doc.getPage(Number(a.page) - 1);
      if(!page) continue;
      const {height} = page.getSize();

      if(a.type === 'replace'){
        const x = Number(a.x) || 0;
        const y = Number(a.y) || 0;
        const size = Number(a.fontSize) || Math.max(7, Number(a.height) || 12);
        page.drawText(String(a.text || ''), {
          x, y: height - y - size, size, font,
          color: rgb(0.1,0.1,0.1)
        });
        continue;
      }

      if(a.type === 'text'){
        const x = Number(a.x) || 0;
        const y = Number(a.y) || 0;
        page.drawText(String(a.text || ''), {
          x, y: height - y, size: Number(a.size) || 16, font,
          color: rgb(...(a.color || [0,0,0]))
        });
      }

      if(a.type === 'image' && req.file){
        const imgBytes = fs.readFileSync(req.file.path);
        const img = req.file.mimetype.includes('png')
          ? await doc.embedPng(imgBytes)
          : await doc.embedJpg(imgBytes);
        const width = Number(a.width) || 150;
        const imgHeight = (width / img.width) * img.height;
        page.drawImage(img, {
          x: Number(a.x) || 0,
          y: height - (Number(a.y) || 0) - imgHeight,
          width,
          height: imgHeight
        });
      }
    }

    editedBytes = await doc.save();
    const outPath = path.join(TMP, uuid() + '.pdf');
    fs.writeFileSync(outPath, editedBytes);

    sendFileAndCleanup(res, outPath, 'editado.pdf', req.file ? [req.file.path] : []);
  }catch(e){
    console.error('Falha ao editar PDF:', e);
    if(req.file) cleanup(req.file.path);
    if(!res.headersSent) res.status(500).json({error:e.message});
  }
});

app.listen(PORT, () => console.log(`PDFTools rodando em http://localhost:${PORT}`));
