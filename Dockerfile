FROM node:20-bookworm-slim

# Dependências de sistema necessárias pelo server.js:
# - ghostscript  -> compressão de PDF (gs)
# - poppler-utils -> pdf -> imagens / miniaturas (pdftoppm)
# - libreoffice  -> conversão office <-> pdf (soffice)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript \
    poppler-utils \
    libreoffice \
    fonts-liberation \
    fonts-dejavu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Instala dependências Node primeiro (aproveita cache de camada)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copia o restante do projeto
COPY . .

# Pastas usadas pelo server.js em tempo de execução
RUN mkdir -p uploads tmp

# Render injeta a variável PORT automaticamente; server.js já lê process.env.PORT
ENV NODE_ENV=production
# Evita erro de permissão do LibreOffice ao criar seu perfil de usuário
ENV HOME=/tmp
EXPOSE 3000

CMD ["node", "server.js"]
