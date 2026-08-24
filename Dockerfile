# Image de production pour ERP Ferme Massla.
# Construire depuis la racine erp-ferme/ (contexte = ce dossier), car le serveur sert le dossier
# web/ via un chemin relatif (server/src/index.js -> ../../web) : les deux doivent être copiés
# en conservant cette même structure relative dans l'image.

# Étape 1 : fusionne+minifie le JS servi au navigateur (web/build.js) — jamais exécutée hors
# build d'image ; les fichiers sources dans web/js/ restent la référence pour éditer/déboguer.
FROM node:20-alpine AS webbuild
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

COPY server ./server
COPY web ./web
# Retire les sources JS brutes de l'image de production : sans cette étape, elles resteraient
# accessibles par URL directe (ex: /js/views/production.js) même si plus aucune page HTML ne les
# référence, ce qui viderait la minification de son intérêt (protection basique contre la copie
# casuelle du frontend). Les bundles minifiés générés à l'étape webbuild les remplacent juste après.
RUN rm -rf ./web/js/views && rm -f ./web/js/*.js
COPY --from=webbuild /build/js/dist ./web/js/dist

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

WORKDIR /app/server
CMD ["node", "src/index.js"]
