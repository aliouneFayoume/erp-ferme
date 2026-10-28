/**
 * Audit de couverture RLS, en deux temps pour rester testable sans base réelle :
 *   - collecterCatalogue(client) : lit UNIQUEMENT les catalogues PostgreSQL (aucune donnée métier, aucune écriture) ;
 *   - analyserCouverture(catalogue) : logique de décision PURE (tableaux en entrée, constats en sortie), couverte par
 *     tests/rls-audit.test.js avec des catalogues synthétiques.
 * Utilisé par verify-rls.js (jamais lancé contre pg-mem : pg_policies / has_table_privilege n'y existent pas).
 */

// Rôles de l'API REST publique Supabase : l'application n'en utilise aucun, ils ne doivent rien pouvoir lire (migration-43).
const ROLES_PUBLICS = ['anon', 'authenticated'];
// Tables techniques sans donnée de ferme, volontairement hors du périmètre d'isolement.
const TABLES_IGNOREES = new Set(['schema_migrations']);
// « current_tenant_id() IS NULL » dans une policy = échappatoire pré-tenant : toute requête SANS contexte de ferme passe.
const REGEX_ECHAPPATOIRE = /current_tenant_id\s*\(\s*\)\s+is\s+null/i;

/**
 * Tables à isoler par ferme : celles qui ont une colonne tenant_id, plus (transitivement) celles qui n'en ont pas mais
 * référencent par clé étrangère une table à isoler (ex. lignes_commande -> commandes, ticket_messages -> tickets).
 * Renvoie { directes: Set, dependantes: Set }.
 */
function tablesDuPerimetre({ tables, tablesAvecTenantId, cles }) {
    const connues = new Set(tables.map((t) => t.table_name).filter((t) => !TABLES_IGNOREES.has(t)));
    const directes = new Set([...tablesAvecTenantId].filter((t) => connues.has(t)));
    const dependantes = new Set();
    let change = true;
    while (change) {
        change = false;
        for (const { enfant, parent } of cles) {
            if (!connues.has(enfant) || directes.has(enfant) || dependantes.has(enfant)) continue;
            if (directes.has(parent) || dependantes.has(parent)) {
                dependantes.add(enfant);
                change = true;
            }
        }
    }
    return { directes, dependantes };
}

/**
 * Analyse un catalogue et renvoie la liste des constats { niveau: 'ERREUR' | 'AVERTISSEMENT', table, code, message }.
 *   catalogue.tables              [{ table_name, rls }]                     rls = relrowsecurity
 *   catalogue.tablesAvecTenantId  Set / tableau de noms de tables
 *   catalogue.cles                [{ enfant, parent }]                      clés étrangères
 *   catalogue.policies            [{ table_name, policyname, cmd, roles, qual, with_check }]   cmd : SELECT|INSERT|UPDATE|DELETE|ALL
 *   catalogue.privileges          [{ role, table_name, priv }]              droits effectifs des rôles anon / authenticated
 */
function analyserCouverture(catalogue) {
    const constats = [];
    const ajouter = (niveau, table, code, message) => constats.push({ niveau, table, code, message });

    const tables = catalogue.tables || [];
    const policies = catalogue.policies || [];
    const privileges = catalogue.privileges || [];
    const perimetre = tablesDuPerimetre({
        tables,
        tablesAvecTenantId: new Set(catalogue.tablesAvecTenantId || []),
        cles: catalogue.cles || [],
    });
    const dansLePerimetre = (t) => perimetre.directes.has(t) || perimetre.dependantes.has(t);

    for (const { table_name: table, rls } of tables) {
        if (TABLES_IGNOREES.has(table)) continue;
        const nbPolicies = policies.filter((p) => p.table_name === table).length;
        const origine = perimetre.directes.has(table) ? 'colonne tenant_id' : 'dépend d\'une table à tenant_id';
        if (!rls) {
            if (dansLePerimetre(table)) ajouter('ERREUR', table, 'RLS_ABSENTE', `${table} (${origine}) : RLS non activée — les données de toutes les fermes sont lisibles par tout rôle non propriétaire qui a le droit SELECT.`);
            else ajouter('AVERTISSEMENT', table, 'RLS_ABSENTE_GLOBALE', `${table} (table globale) : RLS non activée.`);
        } else if (nbPolicies === 0) {
            if (dansLePerimetre(table)) ajouter('ERREUR', table, 'AUCUNE_POLICY', `${table} (${origine}) : RLS activée mais aucune policy — l'application ne peut ni lire ni écrire (refus total), ou une policy a été oubliée.`);
            else ajouter('AVERTISSEMENT', table, 'AUCUNE_POLICY_GLOBALE', `${table} (table globale) : RLS activée sans policy.`);
        }
    }

    // Échappatoire pré-tenant : lecture seule = tolérée mais à lister (login, IPN) ; en écriture = faille.
    for (const p of policies) {
        const texte = `${p.qual || ''} ${p.with_check || ''}`;
        if (!REGEX_ECHAPPATOIRE.test(texte)) continue;
        const ecritures = ['INSERT', 'UPDATE', 'DELETE', 'ALL'].includes(String(p.cmd).toUpperCase());
        if (ecritures) ajouter('ERREUR', p.table_name, 'ECHAPPATOIRE_ECRITURE', `${p.table_name} : la policy « ${p.policyname} » (${p.cmd}) contient « current_tenant_id() IS NULL » — une requête sans contexte de ferme peut ÉCRIRE.`);
        else ajouter('AVERTISSEMENT', p.table_name, 'ECHAPPATOIRE_LECTURE', `${p.table_name} : la policy « ${p.policyname} » (${p.cmd}) contient « current_tenant_id() IS NULL » — lecture possible sans contexte de ferme (échappatoire pré-tenant : à garder réservée au rôle applicatif).`);
    }

    // Droits résiduels de anon / authenticated : doivent être nuls (migration-43).
    const parTable = new Map();
    for (const { role, table_name: table, priv } of privileges) {
        if (!ROLES_PUBLICS.includes(role)) continue;
        if (!parTable.has(table)) parTable.set(table, []);
        parTable.get(table).push(`${role}:${priv}`);
    }
    for (const [table, droits] of parTable) {
        ajouter('ERREUR', table, 'DROITS_ROLE_PUBLIC', `${table} : droits résiduels pour l'API publique (${droits.join(', ')}) — rejouer migration-43-revoke-anon.sql.`);
    }

    // Policies valables pour PUBLIC (pas de « TO <rôle> ») : une seule ligne agrégée, c'est le sujet de la restriction à erp_app.
    const sansRole = policies.filter((p) => /(^|,)public(,|$)/i.test(String(p.roles || 'public')));
    if (sansRole.length > 0) {
        ajouter('AVERTISSEMENT', null, 'POLICIES_PUBLIC', `${sansRole.length} policy(s) sans « TO <rôle> » (valables pour PUBLIC) : leur sécurité repose sur la révocation des droits de anon/authenticated (migration-43).`);
    }

    return constats;
}

/** Lit les catalogues PostgreSQL (lecture seule) et renvoie l'entrée de analyserCouverture. `client` : pg Pool ou Client. */
async function collecterCatalogue(client) {
    const tables = (await client.query(
        `SELECT c.relname AS table_name, c.relrowsecurity AS rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`
    )).rows;
    const tenant = (await client.query(
        `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id'`
    )).rows.map((r) => r.table_name);
    const cles = (await client.query(
        `SELECT cc.relname AS enfant, pc.relname AS parent
         FROM pg_constraint k
         JOIN pg_class cc ON cc.oid = k.conrelid
         JOIN pg_class pc ON pc.oid = k.confrelid
         JOIN pg_namespace n ON n.oid = cc.relnamespace
         WHERE k.contype = 'f' AND n.nspname = 'public'`
    )).rows;
    // array_to_string : le pilote ne convertit pas toujours le type name[] en tableau JavaScript.
    const policies = (await client.query(
        `SELECT tablename AS table_name, policyname, cmd, array_to_string(roles, ',') AS roles, qual, with_check
         FROM pg_policies WHERE schemaname = 'public'`
    )).rows;
    const privileges = (await client.query(
        `SELECT r.rolname AS role, c.relname AS table_name, p.priv
         FROM pg_roles r
         CROSS JOIN pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
         WHERE r.rolname IN ('anon', 'authenticated') AND n.nspname = 'public' AND c.relkind IN ('r', 'p')
           AND has_table_privilege(r.rolname, c.oid, p.priv)
         ORDER BY r.rolname, c.relname, p.priv`
    )).rows;
    return { tables, tablesAvecTenantId: tenant, cles, policies, privileges };
}

module.exports = { analyserCouverture, collecterCatalogue, tablesDuPerimetre, ROLES_PUBLICS };
