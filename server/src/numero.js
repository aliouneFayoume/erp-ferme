const crypto = require('crypto');

/**
 * Génère un numéro de commande (`CMD-...` / `CMF-...`) unique pour une ferme donnée.
 *
 * Remplace l'ancien générateur `CMD-${Date.now().toString().slice(-6)}` (audit sécurité 2026-08-11,
 * M3) : les 6 derniers chiffres d'un timestamp en millisecondes se répètent toutes les ~16,7
 * minutes, donc deux commandes créées à cet intervalle — dans N'IMPORTE QUELLE ferme, la contrainte
 * étant globale — entraient en collision (violation d'unicité → 500 en pleine prise de commande).
 *
 * Horodatage base36 (ordre de grandeur chronologique conservé, lisible) + suffixe aléatoire 3
 * chiffres + vérification effective d'unicité PAR FERME (même modèle que `genererSlugUnique`,
 * slug.js) plutôt qu'un simple pari sur l'entropie : la boucle élimine complètement le risque de
 * collision au lieu de le rendre seulement improbable. Doit être appelé sur une connexion dédiée
 * (client, pas pool) pour rester cohérent avec la transaction appelante.
 */
async function genererNumeroUnique(client, table, prefixe, tenantId) {
    while (true) {
        const candidat = `${prefixe}-${Date.now().toString(36).toUpperCase()}${String(crypto.randomInt(1000)).padStart(3, '0')}`;
        const existant = await client.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1 AND numero_commande = $2`, [tenantId, candidat]);
        if (existant.rows.length === 0) return candidat;
    }
}

module.exports = { genererNumeroUnique };
