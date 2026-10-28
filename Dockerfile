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

# Durcissement 2026-10 : exécution en utilisateur non-root. L'analyse du code montre que l'app n'écrit
# AUCUN fichier (fs n'est utilisé qu'en lecture : schema.sql ; PDF de facture générés en mémoire ;
# pas de logs fichier ni d'uploads ; aucun volume monté sur le conteneur app). Les fichiers de
# l'image restent donc propriété de root, en lecture seule pour "node" : en cas de compromission,
# l'attaquant ne peut pas modifier le code de l'application. Aucun chown de volume hôte requis.
USER node

# Sonde de santé Docker (sans curl, absent d'alpine) : /api/health interroge réellement la base.
# start-period large : le démarrage applique schéma/migrations avant d'écouter.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/server
CMD ["node", "src/index.js"]
