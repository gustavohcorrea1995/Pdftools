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

function sendFileAndCleanup(res, filePath, downloadName, extraFiles = []) {
  res.download(filePath, downloadName, (err) => {
    cleanup(filePath, ...extraFiles);
  });
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

  try {
    fs.mkdirSync(workDir, { recursive: true });

    // O PDF é copiado imediatamente. Não renderizamos todas as páginas aqui:
    // isso deixa o primeiro carregamento muito mais rápido.
    const bytes = fs.readFileSync(inputPath);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageCount = src.getPageCount();
    const finalName = id + '.pdf';
    fs.copyFileSync(inputPath, path.join(UP, finalName));

    const pageSizes = src.getPages().map(p => {
      const { width, height } = p.getSize();
      return { width, height };
    });

    // Extração de texto é feita uma única vez.
    let textBoxes = [];
    const bboxPath = path.join(workDir, 'bbox.html');

    try {
      await run('pdftotext', [
        '-bbox',
        '-enc', 'UTF-8',
        inputPath,
        bboxPath
      ]);

      const html = fs.readFileSync(bboxPath, 'utf8');
      const pages = [...html.matchAll(/<page[^>]*>([\s\S]*?)<\/page>/gi)];

      pages.forEach((pm, pageIndex) => {
        const words = [...pm[1].matchAll(
          /<word[^>]*xMin="([0-9.]+)"[^>]*yMin="([0-9.]+)"[^>]*xMax="([0-9.]+)"[^>]*yMax="([0-9.]+)"[^>]*>([\s\S]*?)<\/word>/gi
        )];

        words.forEach((w, wordIndex) => {
          const clean = w[5].replace(/<[^>]+>/g, '').trim();
          if(!clean) return;

          const pdfX = parseFloat(w[1]);
          const pdfY = parseFloat(w[2]);
          const pdfXMax = parseFloat(w[3]);
          const pdfYMax = parseFloat(w[4]);

          // A prévia agora é 90 DPI para carregar mais rápido.
          const scale90 = 90 / 72;

          textBoxes.push({
            id:`p${pageIndex+1}-w${wordIndex+1}`,
            page:pageIndex+1,
            x:pdfX * scale90,
            y:pdfY * scale90,
            width:Math.max(1,(pdfXMax-pdfX) * scale90),
            height:Math.max(1,(pdfYMax-pdfY) * scale90),
            pdfX,
            pdfY,
            pdfWidth:Math.max(1,pdfXMax-pdfX),
            pdfHeight:Math.max(1,pdfYMax-pdfY),
            text:clean,
            originalText:clean,
            fontSize:Math.max(6,pdfYMax-pdfY)
          });
        });
      });
    } catch(extractErr) {
      console.log('Falha ao extrair caixas de texto:', extractErr.message);
    }

    res.json({
      fileId:finalName,
      pageCount,
      pageSizes,
      // A imagem só é criada quando o navegador realmente pede a página.
      thumbnails:Array.from(
        {length:pageCount},
        (_,i) => `/api/preview/${id}/${i+1}`
      ),
      textBoxes
    });

  } catch(e) {
    cleanup(inputPath, workDir, path.join(UP, id + '.pdf'));
    res.status(500).json({ error:e.message });
  } finally {
    cleanup(inputPath);
  }
});

// Renderização sob demanda: só renderiza a página que o usuário está vendo.
// Isso elimina o atraso de renderizar um PDF inteiro antes de mostrar a primeira página.
app.get('/api/preview/:id/:page', async (req,res)=>{
  const id = String(req.params.id).replace(/\.pdf$/i,'');
  const page = Number(req.params.page);

  if(!Number.isInteger(page) || page < 1){
    return res.status(400).send('Página inválida.');
  }

  const pdfPath = path.join(UP, id + '.pdf');
  const workDir = path.join(UP, 'thumbs_' + id);
  const pngPath = path.join(workDir, `p-${page}.png`);

  try {
    if(!fs.existsSync(pdfPath)){
      return res.status(404).send('PDF não encontrado.');
    }

    fs.mkdirSync(workDir, { recursive:true });

    // Se já existe, entrega imediatamente.
    if(!fs.existsSync(pngPath)){
      await run('pdftoppm', [
        '-png',
        '-r', '90',
        '-f', String(page),
        '-singlefile',
        pdfPath,
        path.join(workDir, `p-${page}`)
      ]);
    }

    if(!fs.existsSync(pngPath)){
      return res.status(500).send('Não foi possível renderizar esta página.');
    }

    res.set('Cache-Control','public, max-age=3600');
    res.type('png').sendFile(path.resolve(pngPath));

  } catch(e) {
    console.error('PREVIEW:', e);
    if(!res.headersSent) res.status(500).send(e.message);
  }
});


app.use('/uploads', express.static(UP));

// ---------- EDIT: add text / image overlay ----------
app.post('/api/edit/annotate', upload.single('image'), async (req, res) => {
  try {
    const { fileId, annotations } = req.body;
    const filePath = path.join(UP, path.basename(fileId || ''));

    if(!fileId || !fs.existsSync(filePath)){
      return res.status(400).json({ error:'Arquivo não encontrado. Reenvie o PDF.' });
    }

    const anns = JSON.parse(annotations || '[]');

    let mupdf;
    try {
      mupdf = await import('mupdf');
    } catch (err) {
      throw new Error(
        'O módulo mupdf não está instalado. Confirme "mupdf": "1.28.0" no package.json e faça novo deploy.'
      );
    }

    const originalBytes = fs.readFileSync(filePath);
    const redactionDoc = mupdf.PDFDocument.openDocument(
      originalBytes,
      'application/pdf'
    );

    // O editor já envia x/y/width/height em PONTOS do PDF (não pixels).
    // Isso é importante: a prévia é 90 DPI, mas a anotação usa as
    // coordenadas PDF originais.
    const redactionPages = new Map();

    for(const a of anns){
      if(!a.id || !a.id.startsWith('p')) continue;
      if(a.text === undefined) continue;

      const pageIndex = Number(a.page) - 1;
      if(!Number.isInteger(pageIndex) ||
         pageIndex < 0 ||
         pageIndex >= redactionDoc.countPages()) continue;

      const page = redactionDoc.loadPage(pageIndex);
      const bounds = page.getBounds();

      let rect = null;

      // 1) MÉTODO PRINCIPAL: procura o texto ORIGINAL no próprio PDF.
      // Isso é muito mais seguro que depender apenas da posição da imagem.
      const originalText = String(a.originalText ?? '').trim();

      if(originalText){
        try {
          const hits = page.search(originalText);

          if(hits && hits.length){
            const expectedX = Number(a.x) || 0;
            const expectedY = Number(a.y) || 0;

            // Escolhe a ocorrência mais próxima da caixa clicada.
            let best = null;
            let bestDist = Infinity;

            for(const q of hits){
              const pts = Array.isArray(q) ? q : [];
              if(pts.length < 8) continue;

              const xs = [pts[0],pts[2],pts[4],pts[6]];
              const ys = [pts[1],pts[3],pts[5],pts[7]];

              const x1 = Math.min(...xs);
              const y1 = Math.min(...ys);
              const x2 = Math.max(...xs);
              const y2 = Math.max(...ys);

              const cx = (x1+x2)/2;
              const cy = (y1+y2)/2;
              const ecx = expectedX + (Number(a.width)||0)/2;
              const ecy = expectedY + (Number(a.height)||0)/2;
              const dist = Math.hypot(cx-ecx, cy-ecy);

              if(dist < bestDist){
                bestDist = dist;
                best = [x1,y1,x2,y2];
              }
            }

            if(best) rect = best;
          }
        } catch(searchErr) {
          console.log('Busca para redação falhou:', searchErr.message);
        }
      }

      // 2) FALLBACK: usa a caixa original do texto em pontos PDF.
      // Também funciona para PDFs que não permitem busca normal.
      if(!rect){
        const x = Number(a.x);
        const y = Number(a.y);
        const w = Number(a.width);
        const h = Number(a.height);

        if(Number.isFinite(x) && Number.isFinite(y) &&
           Number.isFinite(w) && Number.isFinite(h) &&
           w > 0 && h > 0){
          rect = [
            x,
            y,
            x + w,
            y + h
          ];
        }
      }

      if(rect){
        const pad = 1.5;
        const x1 = Math.max(bounds[0], rect[0] - pad);
        const y1 = Math.max(bounds[1], rect[1] - pad);
        const x2 = Math.min(bounds[2], rect[2] + pad);
        const y2 = Math.min(bounds[3], rect[3] + pad);

        if(x2 > x1 && y2 > y1){
          if(!redactionPages.has(pageIndex)){
            redactionPages.set(pageIndex, []);
          }

          redactionPages.get(pageIndex).push({
            rect:[x1,y1,x2,y2],
            page
          });
        }
      }

      // Não destrói a page aqui porque os objetos ficam necessários
      // enquanto as redações são criadas.
    }

    // APLICA REDAÇÃO REAL.
    // REDACT_TEXT_REMOVE remove o texto e REDACT_IMAGE_PIXELS permite
    // que a mesma área seja tratada quando o conteúdo é uma imagem/scanned PDF.
    for(const [pageIndex, items] of redactionPages.entries()){
      const page = redactionDoc.loadPage(pageIndex);

      for(const item of items){
        const [x1,y1,x2,y2] = item.rect;

        const redact = page.createAnnotation('Redact');
        redact.setRect([x1,y1,x2,y2]);
        redact.update();

        // Sem caixa preta: a interface desenha o branco depois.
        // A remoção acontece aqui, de forma irreversível.
        redact.applyRedaction(
          false,
          mupdf.PDFPage.REDACT_IMAGE_PIXELS
        );
      }

      page.destroy();
    }

    // Garbage collection para eliminar objetos não referenciados
    // que poderiam manter conteúdo antigo no arquivo.
    const redactedBytes = Buffer.from(
      redactionDoc.saveToBuffer('garbage=4,compress=yes').asUint8Array()
    );

    redactionDoc.destroy();

    // Reabre o PDF já redigido para desenhar o resultado visual:
    // - branco sobre a área removida
    // - novo texto, quando for edição
    const doc = await PDFDocument.load(redactedBytes, {
      ignoreEncryption: true
    });

    const font = await doc.embedFont(StandardFonts.Helvetica);

    for(const a of anns){
      const page = doc.getPage(Number(a.page) - 1);
      if(!page) continue;

      const { height: pageHeight } = page.getSize();

      if(a.id && a.id.startsWith('p') && a.text !== undefined){
        const x = Number(a.x) || 0;
        const yTop = Number(a.y) || 0;
        const width = Number(a.width) || 20;
        const textHeight = Number(a.height) || 12;
        const fontSize = Number(a.fontSize) || Math.max(7, textHeight);

        const pad = 1.5;

        page.drawRectangle({
          x: Math.max(0, x-pad),
          y: Math.max(0, pageHeight-yTop-textHeight-pad),
          width: width + pad*2,
          height: textHeight + pad*2,
          color: rgb(1,1,1),
          borderWidth: 0
        });

        if(!a.deleted && String(a.text || '').length){
          page.drawText(String(a.text), {
            x,
            y: pageHeight-yTop-fontSize,
            size:fontSize,
            font,
            color:rgb(0.1,0.1,0.1)
          });
        }

        continue;
      }

      if(a.type === 'text'){
        page.drawText(a.text || '', {
          x:Number(a.x)||0,
          y:pageHeight-(Number(a.y)||0),
          size:Number(a.size)||16,
          font,
          color:rgb(...(a.color || [0,0,0]))
        });
      }
    }

    const outBytes = await doc.save();
    const outPath = path.join(TMP, uuid()+'.pdf');
    fs.writeFileSync(outPath, outBytes);

    sendFileAndCleanup(res, outPath, 'editado.pdf');

  } catch(e) {
    console.error('EDIT/ANNOTATE:', e);
    if(!res.headersSent){
      res.status(500).json({error:e.message});
    }
  }
});


app.listen(PORT, () => console.log(`PDFTools rodando em http://localhost:${PORT}`));
