const { analyserCouverture, tablesDuPerimetre } = require('../src/rlsAudit');

// Logique de décision de verify-rls.js testée sur des catalogues synthétiques (pg-mem ne sait ni créer de policy ni lire pg_policies).
const policy = (table_name, cmd = 'ALL', extra = {}) => ({ table_name, policyname: 'p', cmd, roles: 'erp_app', qual: 'tenant_id = current_tenant_id()', with_check: null, ...extra });
const codes = (constats) => constats.map((c) => `${c.niveau}:${c.code}:${c.table}`);

describe('rlsAudit — périmètre des tables à isoler', () => {
    test('inclut les tables à tenant_id ET, transitivement, celles qui en dépendent par clé étrangère', () => {
        const { directes, dependantes } = tablesDuPerimetre({
            tables: ['commandes', 'lignes_commande', 'sous_lignes', 'roles', 'schema_migrations'].map((table_name) => ({ table_name, rls: true })),
            tablesAvecTenantId: ['commandes'],
            cles: [
                { enfant: 'lignes_commande', parent: 'commandes' },
                { enfant: 'sous_lignes', parent: 'lignes_commande' }, // dépendance indirecte
                { enfant: 'commandes', parent: 'roles' },
            ],
        });
        expect([...directes]).toEqual(['commandes']);
        expect([...dependantes].sort()).toEqual(['lignes_commande', 'sous_lignes']);
    });
});

describe('rlsAudit — constats', () => {
    const base = {
        tables: [
            { table_name: 'commandes', rls: true },
            { table_name: 'lignes_commande', rls: true },
            { table_name: 'roles', rls: true },
            { table_name: 'schema_migrations', rls: false },
        ],
        tablesAvecTenantId: ['commandes'],
        cles: [{ enfant: 'lignes_commande', parent: 'commandes' }],
        policies: [policy('commandes'), policy('lignes_commande'), policy('roles', 'SELECT', { qual: 'true' })],
        privileges: [],
    };

    test('un catalogue sain ne produit que l’avertissement agrégé « policies valables pour PUBLIC » s’il y en a', () => {
        expect(analyserCouverture(base)).toEqual([]);
        const constats = analyserCouverture({ ...base, policies: base.policies.map((p) => ({ ...p, roles: 'public' })) });
        expect(codes(constats)).toEqual(['AVERTISSEMENT:POLICIES_PUBLIC:null']);
    });

    test('table à tenant_id sans RLS : ERREUR ; table dépendante sans RLS : ERREUR ; table globale sans RLS : simple avertissement', () => {
        const constats = analyserCouverture({
            ...base,
            tables: [
                { table_name: 'commandes', rls: false },
                { table_name: 'lignes_commande', rls: false },
                { table_name: 'roles', rls: false },
                { table_name: 'schema_migrations', rls: false },
            ],
        });
        expect(codes(constats)).toEqual([
            'ERREUR:RLS_ABSENTE:commandes',
            'ERREUR:RLS_ABSENTE:lignes_commande',
            'AVERTISSEMENT:RLS_ABSENTE_GLOBALE:roles',
        ]);
    });

    test('RLS activée mais aucune policy sur une table de ferme : ERREUR', () => {
        const constats = analyserCouverture({ ...base, policies: [policy('commandes'), policy('roles', 'SELECT', { qual: 'true' })] });
        expect(codes(constats)).toEqual(['ERREUR:AUCUNE_POLICY:lignes_commande']);
    });

    test('« current_tenant_id() IS NULL » : avertissement en lecture, ERREUR dans une policy d’écriture (insensible à la casse et aux espaces)', () => {
        const lecture = policy('commandes', 'SELECT', { qual: '(tenant_id = current_tenant_id()) OR (current_tenant_id() IS NULL)' });
        const ecriture = policy('commandes', 'UPDATE', { qual: 'tenant_id = current_tenant_id() OR CURRENT_TENANT_ID( )  is   null' });
        const dansWithCheck = policy('lignes_commande', 'INSERT', { qual: null, with_check: 'current_tenant_id() IS NULL' });
        const constats = analyserCouverture({ ...base, policies: [lecture, ecriture, dansWithCheck, policy('roles', 'SELECT', { qual: 'true' })] });
        expect(codes(constats)).toEqual([
            'AVERTISSEMENT:ECHAPPATOIRE_LECTURE:commandes',
            'ERREUR:ECHAPPATOIRE_ECRITURE:commandes',
            'ERREUR:ECHAPPATOIRE_ECRITURE:lignes_commande',
        ]);
    });

    test('droits résiduels de anon / authenticated : ERREUR par table, rôle applicatif ignoré', () => {
        const constats = analyserCouverture({
            ...base,
            privileges: [
                { role: 'anon', table_name: 'commandes', priv: 'SELECT' },
                { role: 'authenticated', table_name: 'commandes', priv: 'INSERT' },
                { role: 'erp_app', table_name: 'roles', priv: 'SELECT' },
            ],
        });
        expect(codes(constats)).toEqual(['ERREUR:DROITS_ROLE_PUBLIC:commandes']);
        expect(constats[0].message).toMatch(/anon:SELECT.*authenticated:INSERT/);
    });
});
