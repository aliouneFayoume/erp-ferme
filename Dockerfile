# Image de production pour ERP Ferme Massla.
# Construire depuis la racine erp-ferme/ (contexte = ce dossier), car le serveur sert le dossier
# web/ via un chemin relatif (server/src/index.js -> ../../web) : les deux doivent être copiés
# en conservant cette même structure relative dans l'image.
FROM node:20-alpine

WORKDIR /app

COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev

COPY server ./server
COPY web ./web

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

WORKDIR /app/server
CMD ["node", "src/index.js"]
