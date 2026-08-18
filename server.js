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

          const PT_TO_PX = 120 / 72;

          const xPt = parseFloat(w[1]);
          const yPt = parseFloat(w[2]);
          const xMaxPt = parseFloat(w[3]);
          const yMaxPt = parseFloat(w[4]);

          // pdftotext usa pontos; a página é renderizada pelo pdftoppm
          // a 120 DPI. Convertendo aqui, a caixa fica sobre o texto
          // real da imagem, sem precisar "caçar" a informação.
          const x = xPt * PT_TO_PX;
          const y = yPt * PT_TO_PX;
          const width = Math.max(1, (xMaxPt - xPt) * PT_TO_PX);
          const height = Math.max(1, (yMaxPt - yPt) * PT_TO_PX);

          textBoxes.push({
            id: `p${pageIndex + 1}-w${wordIndex + 1}`,
            page: pageIndex + 1,
            x,
            y,
            width,
            height,
            text,
            fontSize: Math.max(6, yMaxPt - yPt)
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

  if (!Number.isInteger(page) || page < 1) {
    return res.status(400).send('Página inválida.');
  }

  const pdfPath = path.join(UP, id + '.pdf');
  const thumbDir = path.join(UP, 'thumbs_' + id);
  const thumbPath = path.join(thumbDir, `p-${page}.png`);

  try {
    if (!fs.existsSync(pdfPath)) {
      return res.status(404).send('PDF temporário não encontrado. Envie o PDF novamente.');
    }

    // Entrega a miniatura existente somente se ela realmente tiver conteúdo.
    if (fs.existsSync(thumbPath)) {
      const stat = await fs.promises.stat(thumbPath);
      if (stat.size > 0) {
        const data = await fs.promises.readFile(thumbPath);
        res.status(200);
        res.set({
          'Content-Type': 'image/png',
          'Content-Length': data.length,
          'Cache-Control': 'no-store'
        });
        return res.end(data);
      }
    }

    // Se a miniatura não existir, renderiza somente a página solicitada.
    const workDir = path.join(TMP, 'preview_' + id);
    fs.mkdirSync(workDir, { recursive: true });

    const outputPrefix = path.join(workDir, `page_${page}`);

    await run('pdftoppm', [
      '-f', String(page),
      '-singlefile',
      '-png',
      '-r', '120',
      pdfPath,
      outputPrefix
    ]);

    const renderedPath = outputPrefix + '.png';

    if (!fs.existsSync(renderedPath)) {
      cleanup(workDir);
      return res.status(500).send('Não foi possível renderizar a página do PDF.');
    }

    const data = await fs.promises.readFile(renderedPath);

    res.status(200);
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': data.length,
      'Cache-Control': 'no-store'
    });
    res.end(data);

    cleanup(workDir);
  } catch (e) {
    console.error('Erro na pré-visualização:', e);
    cleanup(path.join(TMP, 'preview_' + id));
    if (!res.headersSent) {
      return res.status(500).send('Erro ao renderizar a página: ' + e.message);
    }
  }
});

app.use('/uploads', express.static(UP));

// ---------- EDIT: add text / image overlay + REDAÇÃO REAL ----------
app.post('/api/edit/annotate', upload.single('image'), async (req, res) => {
  try {
    const { fileId, annotations } = req.body;
    const filePath = path.join(UP, fileId);

    if(!fs.existsSync(filePath)){
      return res.status(400).json({
        error: 'Arquivo não encontrado. Reenvie o PDF.'
      });
    }

    const anns = JSON.parse(annotations || '[]');

    // ================================================================
    // 1) REDAÇÃO REAL COM MUPDF
    // ================================================================
    // O editor trabalha em pixels porque a prévia é renderizada a 120 DPI.
    // O PDF trabalha em pontos (72 DPI), então convertemos antes de criar
    // a área de redação.
    let mupdf;
    try {
      mupdf = await import('mupdf');
    } catch (err) {
      throw new Error(
        'O módulo mupdf não está instalado. Faça um novo deploy após confirmar que "mupdf": "1.28.0" está no package.json.'
      );
    }

    const originalBytes = fs.readFileSync(filePath);
    const redactionDoc = mupdf.PDFDocument.openDocument(
      originalBytes,
      'application/pdf'
    );

    const redactedPages = new Set();
    const PREVIEW_DPI = 120;
    const PT_PER_PX = 72 / PREVIEW_DPI;

    for(const a of anns){
      if(!a.id || !a.id.startsWith('p')) continue;
      if(a.text === undefined) continue;

      const pageIndex = Number(a.page) - 1;
      if(!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= redactionDoc.countPages()) continue;

      const xPx = Number(a.x);
      const yPx = Number(a.y);
      const wPx = Number(a.width);
      const hPx = Number(a.height);

      if(!Number.isFinite(xPx) || !Number.isFinite(yPx) ||
         !Number.isFinite(wPx) || !Number.isFinite(hPx) ||
         wPx <= 0 || hPx <= 0) continue;

      const page = redactionDoc.loadPage(pageIndex);
      const bounds = page.getBounds();
      const pageHeight = bounds[3] - bounds[1];

      const x = xPx * PT_PER_PX;
      const yTop = yPx * PT_PER_PX;
      const width = wPx * PT_PER_PX;
      const height = hPx * PT_PER_PX;

      // MUDF/PDFPage usa as coordenadas da página com a origem no
      // canto superior esquerdo para as anotações/redações.
      // IMPORTANTE: não inverter o Y aqui. A inversão só é necessária
      // depois, ao desenhar com pdf-lib, que usa origem inferior.
      const pad = 2;
      const x1 = Math.max(0, x - pad);
      const y1 = Math.max(0, yTop - pad);
      const x2 = Math.min(bounds[2], x + width + pad);
      const y2 = Math.min(bounds[3], yTop + height + pad);

      if(x2 > x1 && y2 > y1){
        const redact = page.createAnnotation('Redact');
        redact.setRect([x1, y1, x2, y2]);
        redact.update();
        redactedPages.add(pageIndex);
      }

      page.destroy();
    }

    // IMPORTANTE: aqui o conteúdo original é removido do PDF.
    // Não é uma camada branca por cima. O texto deixa de existir na região.
    for(const pageIndex of redactedPages){
      const page = redactionDoc.loadPage(pageIndex);
      page.applyRedactions(false);
      page.destroy();
    }

    // Garbage collection máximo para remover objetos órfãos deixados pela
    // redação e evitar que o conteúdo original permaneça recuperável no PDF.
    const redactedBytes = Buffer.from(
      redactionDoc.saveToBuffer('garbage=4,compress=yes').asUint8Array()
    );
    redactionDoc.destroy();

    // ================================================================
    // 1.5) A etapa acima é uma REDAÇÃO REAL: o conteúdo atingido deve ser
    // removido do PDF. Não usamos apenas uma caixa branca.
    // ================================================================

    // ================================================================
    // 2) REABRE O PDF JÁ REDIGIDO
    //    Aqui podemos desenhar o branco e, se for edição, o novo texto.
    // ================================================================
    const doc = await PDFDocument.load(redactedBytes, {
      ignoreEncryption: true
    });
    const font = await doc.embedFont(StandardFonts.Helvetica);

    for(const a of anns){
      const page = doc.getPage(Number(a.page) - 1);
      if(!page) continue;

      const { height: pageHeight } = page.getSize();

      // Edição/exclusão de texto existente.
      if(a.id && a.id.startsWith('p') && a.text !== undefined){
        const x = (Number(a.x) || 0) * PT_PER_PX;
        const y = (Number(a.y) || 0) * PT_PER_PX;
        const width = (Number(a.width) || 20) * PT_PER_PX;
        const textHeight = (Number(a.height) || 12) * PT_PER_PX;
        const fontSize = (Number(a.fontSize) || Math.max(7, Number(a.height) || 12)) * PT_PER_PX;

        const pad = 2;

        // Só aparência: a remoção real já aconteceu acima com MuPDF.
        // Esta área branca é para o usuário visualizar o local apagado.
        page.drawRectangle({
          x: Math.max(0, x - pad),
          y: Math.max(0, pageHeight - y - textHeight - pad),
          width: width + pad * 2,
          height: textHeight + pad * 2,
          color: rgb(1, 1, 1),
          borderWidth: 0
        });

        // Se for edição, escreve o novo texto. Se for exclusão, não escreve nada.
        if(!a.deleted && String(a.text || '').length){
          page.drawText(String(a.text), {
            x,
            y: pageHeight - y - fontSize,
            size: fontSize,
            font,
            color: rgb(0.1, 0.1, 0.1)
          });
        }

        continue;
      }

      // Texto novo.
      if(a.type === 'text'){
        page.drawText(a.text || '', {
          x: Number(a.x) || 0,
          y: pageHeight - (Number(a.y) || 0),
          size: Number(a.size) || 16,
          font,
          color: rgb(...(a.color || [0, 0, 0]))
        });
        continue;
      }

      // Imagem/carimbo.
      if(a.type === 'image' && req.file){
        const imgBytes = fs.readFileSync(req.file.path);
        const img = req.file.mimetype.includes('png')
          ? await doc.embedPng(imgBytes)
          : await doc.embedJpg(imgBytes);

        const width = Number(a.width) || 150;
        const imgHeight = (width / img.width) * img.height;

        page.drawImage(img, {
          x: Number(a.x) || 0,
          y: pageHeight - (Number(a.y) || 0) - imgHeight,
          width,
          height: imgHeight
        });
      }
    }

    const outBytes = await doc.save();
    const outPath = path.join(TMP, uuid() + '.pdf');
    fs.writeFileSync(outPath, outBytes);

    sendFileAndCleanup(
      res,
      outPath,
      'editado.pdf',
      req.file ? [req.file.path] : []
    );
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`PDFTools rodando em http://localhost:${PORT}`));
