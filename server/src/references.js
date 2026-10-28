/**
 * Vérification des identifiants étrangers reçus dans le corps d'une requête.
 *
 * Pourquoi : les clés étrangères PostgreSQL ne passent PAS par la RLS. Une ferme qui envoie l'identifiant d'une ligne d'une
 * AUTRE ferme (client, secteur, lot, fournisseur, utilisateur…) verrait l'INSERT/UPDATE réussir : la ligne serait rattachée à
 * des données qui ne lui appartiennent pas (la RLS ne filtre que les lectures et le tenant_id de la ligne écrite). Chaque route
 * qui accepte un tel identifiant doit donc prouver qu'il appartient au tenant courant avant d'écrire.
 *
 * La liste des tables est fermée (jamais de nom de table venant de l'utilisateur dans le SQL). `actif` ajoute le filtre des
 * lignes supprimées (suppression logique) quand la table en a une.
 */
const TABLES = {
    clients: { supprimable: true },
    produits: { supprimable: true },
    secteurs: { supprimable: false },
    utilisateurs: { supprimable: true },
    lots_production: { supprimable: true },
    fournisseurs: { supprimable: true },
};

/** Vrai si `id` est un entier strictement positif (évite aussi une erreur PostgreSQL 22P02 transformée en 500). */
function identifiantValide(id) {
    const n = Number(id);
    return id !== null && id !== undefined && id !== '' && Number.isInteger(n) && n > 0;
}

/** Vrai si la ligne `id` de `table` existe ET appartient au tenant `tenantId`. */
async function appartientAuTenant(db, table, id, tenantId) {
    const def = TABLES[table];
    if (!def) throw new Error(`Table non autorisée pour la vérification de référence : ${table}`);
    if (!identifiantValide(id)) return false;
    const r = await db.query(
        `SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2${def.supprimable ? ' AND deleted_at IS NULL' : ''}`,
        [Number(id), tenantId]
    );
    return r.rows.length > 0;
}

/**
 * Vérifie plusieurs références facultatives d'un coup. `refs` : [[table, valeur, libellé], ...]. Une valeur absente
 * (undefined, null, '') est ignorée (champ facultatif). Renvoie le message d'erreur (français) de la première référence
 * invalide, ou null si tout est valide.
 */
async function premiereReferenceInvalide(db, tenantId, refs) {
    for (const [table, valeur, libelle] of refs) {
        if (valeur === undefined || valeur === null || valeur === '') continue;
        if (!(await appartientAuTenant(db, table, valeur, tenantId))) return `${libelle} invalide.`;
    }
    return null;
}

module.exports = { appartientAuTenant, premiereReferenceInvalide, identifiantValide };
