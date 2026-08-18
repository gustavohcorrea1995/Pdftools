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
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const bytes = fs.readFileSync(inputPath);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pageCount = src.getPageCount();

    // Renderiza todas as páginas para a pré-visualização.
    await run('pdftoppm', [
      '-png', '-r', '120',
      inputPath,
      path.join(workDir, 'p')
    ]);

    const files = fs.readdirSync(workDir)
      .filter(f => /^p-\d+\.png$/i.test(f))
      .sort((a,b) => {
        const na = parseInt(a.match(/\d+/)[0],10);
        const nb = parseInt(b.match(/\d+/)[0],10);
        return na - nb;
      });

    if(files.length !== pageCount){
      throw new Error(`A pré-visualização gerou ${files.length} página(s), mas o PDF possui ${pageCount}.`);
    }

    const finalName = id + '.pdf';
    fs.copyFileSync(inputPath, path.join(UP, finalName));

    const pageSizes = src.getPages().map(p => {
      const { width, height } = p.getSize();
      return { width, height };
    });

    // Extrai cada palavra com bounding box em pontos, origem no topo.
    let textBoxes = [];
    const bboxPath = path.join(workDir, 'bbox.html');

    try{
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
          const clean = w[5].replace(/<[^>]+>/g,'').trim();
          if(!clean) return;

          const pdfX = parseFloat(w[1]);
          const pdfY = parseFloat(w[2]);
          const pdfXMax = parseFloat(w[3]);
          const pdfYMax = parseFloat(w[4]);

          textBoxes.push({
            id:`p${pageIndex+1}-w${wordIndex+1}`,
            page:pageIndex+1,
            // 120 DPI = 120/72 pixels per PDF point.
            x:pdfX * (120/72),
            y:pdfY * (120/72),
            width:Math.max(1,(pdfXMax-pdfX) * (120/72)),
            height:Math.max(1,(pdfYMax-pdfY) * (120/72)),
            pdfX,
            pdfY,
            pdfWidth:Math.max(1,pdfXMax-pdfX),
            pdfHeight:Math.max(1,pdfYMax-pdfY),
            text:clean,
            fontSize:Math.max(6,pdfYMax-pdfY)
          });
        });
      });
    }catch(extractErr){
      console.log('Falha ao extrair caixas de texto:', extractErr.message);
    }

    res.json({
      fileId:finalName,
      pageCount,
      pageSizes,
      thumbnails:files.map((_,i) => `/api/preview/${id}/${i+1}`),
      textBoxes
    });

  }catch(e){
    cleanup(inputPath, workDir, path.join(UP, id + '.pdf'));
    res.status(500).json({ error:e.message });
  }finally{
    cleanup(inputPath);
  }
});

app.get('/api/preview/:id/:page', (req,res)=>{
  const id = String(req.params.id).replace(/\.pdf$/i,'');
  const page = Number(req.params.page);

  if(!Number.isInteger(page) || page < 1){
    return res.status(400).send('Página inválida.');
  }

  const filePath = path.join(UP, 'thumbs_' + id, `p-${page}.png`);
  if(!fs.existsSync(filePath)){
    return res.status(404).send('Pré-visualização não encontrada.');
  }

  res.set('Cache-Control','no-store');
  res.type('png').sendFile(path.resolve(filePath));
});


app.use('/uploads', express.static(UP));

// ---------- EDIT: add text / image overlay ----------
app.post('/api/edit/annotate', async (req,res)=>{
  const { fileId } = req.body;

  try{
    const annotations = JSON.parse(req.body.annotations || '[]');
    const filePath = path.join(UP, path.basename(fileId || ''));

    if(!fileId || !fs.existsSync(filePath)){
      return res.status(400).json({
        error:'Arquivo não encontrado. Reenvie o PDF.'
      });
    }

    if(!annotations.length){
      return res.status(400).json({
        error:'Nenhuma alteração foi informada.'
      });
    }

    // MuPDF faz a remoção destrutiva do conteúdo original.
    const mupdf = require('mupdf');
    const originalBytes = fs.readFileSync(filePath);

    const mupdfDoc = mupdf.Document.openDocument(
      originalBytes,
      'application/pdf'
    );

    // Agrupa as alterações por página.
    const byPage = new Map();

    for(const a of annotations){
      const p = Number(a.page);
      if(!Number.isInteger(p) || p < 1) continue;

      if(!byPage.has(p)) byPage.set(p, []);
      byPage.get(p).push(a);
    }

    for(const [pageNumber, items] of byPage.entries()){
      const page = mupdfDoc.loadPage(pageNumber - 1);

      for(const a of items){
        const x = Number(a.x);
        const y = Number(a.y);
        const w = Number(a.width);
        const h = Number(a.height);

        if(!Number.isFinite(x) || !Number.isFinite(y) ||
           !Number.isFinite(w) || !Number.isFinite(h)) continue;

        // Pequena margem para garantir que todos os glifos da palavra
        // sejam atingidos pela redação.
        const padX = 1.5;
        const padY = 1.5;

        const rect = [
          Math.max(0, x - padX),
          Math.max(0, y - padY),
          x + w + padX,
          y + h + padY
        ];

        page.addRedaction({
          x:rect[0],
          y:rect[1],
          width:rect[2]-rect[0],
          height:rect[3]-rect[1]
        });
      }

      // Sem caixa preta: remove o conteúdo e preserva a aparência do fundo.
      page.applyRedactions(
        false,
        mupdf.PDFPage.REDACT_IMAGE_NONE,
        mupdf.PDFPage.REDACT_LINE_ART_NONE,
        mupdf.PDFPage.REDACT_TEXT_REMOVE
      );
    }

    const redactedBuffer = mupdfDoc.saveToBuffer('garbage=2,compress=yes');
    const redactedBytes = redactedBuffer.asUint8Array
      ? redactedBuffer.asUint8Array()
      : redactedBuffer;

    // Reabre a versão já redigida para desenhar os textos substitutos.
    const doc = await PDFDocument.load(
      Buffer.from(redactedBytes),
      { ignoreEncryption:true }
    );

    const font = await doc.embedFont(StandardFonts.Helvetica);

    for(const a of annotations){
      if(a.deleted) continue;

      const text = String(a.text ?? '');
      if(!text) continue;

      const page = doc.getPage(Number(a.page) - 1);
      if(!page) continue;

      const { height } = page.getSize();
      const size = Number(a.fontSize || a.size || 10);

      // MuPDF/pdftotext usam origem no topo; pdf-lib usa origem embaixo.
      const x = Number(a.x);
      const topY = Number(a.y);
      const h = Number(a.height || size);
      const y = height - topY - Math.max(h, size);

      page.drawText(text, {
        x,
        y,
        size,
        font,
        color:rgb(0.1,0.1,0.1)
      });
    }

    const outBytes = await doc.save();
    const outPath = path.join(TMP, uuid() + '.pdf');
    fs.writeFileSync(outPath, outBytes);

    sendFileAndCleanup(
      res,
      outPath,
      'editado.pdf'
    );

  }catch(e){
    console.error('EDIT/ANNOTATE:', e);
    if(!res.headersSent){
      res.status(500).json({ error:e.message });
    }
  }
});


app.listen(PORT, () => console.log(`PDFTools rodando em http://localhost:${PORT}`));
