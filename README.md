# PDFTools

Ferramenta local para juntar, dividir, comprimir, converter e editar PDFs.

## O que você precisa ter instalado no computador

1. **Node.js** (versão 18 ou mais recente) — https://nodejs.org (baixe a versão "LTS")
2. **LibreOffice** — necessário só para converter Word/Excel/PowerPoint ↔ PDF — https://www.libreoffice.org/download
3. **Poppler** — necessário para PDF → Imagens e para as miniaturas de página
   - Windows: baixe em https://github.com/oschwartz10612/poppler-windows/releases, extraia e adicione a pasta `bin` ao PATH
   - Mac: `brew install poppler`
   - Linux: `sudo apt install poppler-utils`
4. **Ghostscript** — necessário para Comprimir PDF
   - Windows: https://ghostscript.com/releases/gsdnld.html
   - Mac: `brew install ghostscript`
   - Linux: `sudo apt install ghostscript`

Se você não instalar o LibreOffice, o Poppler ou o Ghostscript, o resto do site funciona normalmente — só as funções específicas de cada um ficam indisponíveis.

## Como rodar

1. Extraia o arquivo `pdftools.zip`
2. Abra o Terminal (Mac/Linux) ou Prompt de Comando/PowerShell (Windows) dentro da pasta `pdftools`
3. Rode:
   ```
   npm install
   ```
   (isso baixa as bibliotecas — só precisa fazer uma vez)
4. Rode:
   ```
   npm start
   ```
5. Abra o navegador em **http://localhost:3000**

Para parar o servidor, volte ao terminal e aperte `Ctrl + C`.

## Estrutura do projeto

```
pdftools/
├── server.js        # backend (Node + Express) — toda a lógica de processamento
├── package.json      # dependências do projeto
└── public/
    ├── index.html     # página principal
    ├── style.css      # visual
    └── app.js          # lógica do front-end
```

## Notas

- Os arquivos enviados ficam apenas na sua própria máquina (pasta `uploads/` e `tmp/`), nunca saem para a internet.
- Este projeto roda localmente — para deixá-lo acessível pela internet (para outras pessoas usarem), seria necessário hospedar em um servidor (ex: Railway, Render, VPS) e ajustar limites de tamanho de upload.
