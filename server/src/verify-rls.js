const { Pool } = require('pg');

/**
 * Vérifie que les policies RLS (rls-policies.sql) filtrent réellement les lignes pour le rôle
 * applicatif (provision-role.sql), contre la vraie base — pg-mem ne sait pas exécuter CREATE POLICY
 * (voir db.js), donc rien de tout ça n'est couvert par `npm test`. C'est la preuve manuelle
 * complémentaire, à relancer avant toute bascule de DATABASE_URL et à chaque modification de policy.
 *
 * Usage :
 *   DATABASE_URL=<connexion rôle propriétaire> ERP_APP_DATABASE_URL=<connexion erp_app> node src/verify-rls.js
 *
 * DATABASE_URL (rôle propriétaire, contourne RLS) sert uniquement à créer/nettoyer les données de
 * test : c'est le même rôle que celui qui crée une organisation aujourd'hui (SQL Editor Supabase),
 * pas un raccourci pour éviter RLS pendant la vérification elle-même.
 * ERP_APP_DATABASE_URL (le rôle non-propriétaire) est celui dont on vérifie l'isolation.
 */

const resultats = [];
function verifier(nom, condition) {
    resultats.push({ nom, ok: !!condition });
}

async function poserContexte(client, tenantId) {
    await client.query('SELECT set_config($1, $2, false)', ['app.current_tenant_id', tenantId === null ? '' : String(tenantId)]);
}

async function poserPlateforme(client, actif) {
    await client.query("SELECT set_config('app.is_plateforme_admin', $1, false)", [actif ? 'true' : '']);
}

async function main() {
    if (!process.env.DATABASE_URL || !process.env.ERP_APP_DATABASE_URL) {
        console.error('DATABASE_URL (rôle propriétaire) ET ERP_APP_DATABASE_URL (rôle erp_app) sont requis — jamais contre pg-mem.');
        process.exit(1);
    }

    const admin = new Pool({ connectionString: process.env.DATABASE_URL });
    const app = new Pool({ connectionString: process.env.ERP_APP_DATABASE_URL });

    let tenantA, tenantB, secteurA, secteurB, lotA, lotB, clientA, clientB, ticketA, ticketB;

    try {
        // --- Fixtures : créées avec le rôle propriétaire, exactement comme un onboarding réel. ---
        tenantA = (await admin.query(`INSERT INTO organisations (nom) VALUES ('verify-rls Tenant A') RETURNING id`)).rows[0].id;
        tenantB = (await admin.query(`INSERT INTO organisations (nom) VALUES ('verify-rls Tenant B') RETURNING id`)).rows[0].id;
        secteurA = (await admin.query(`INSERT INTO secteurs (tenant_id, nom) VALUES ($1, 'Secteur A') RETURNING id`, [tenantA])).rows[0].id;
        secteurB = (await admin.query(`INSERT INTO secteurs (tenant_id, nom) VALUES ($1, 'Secteur B') RETURNING id`, [tenantB])).rows[0].id;
        lotA = (await admin.query(
            `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut) VALUES ($1, $2, 'VRLS-A', 10, CURRENT_DATE, 'EN_COURS') RETURNING id`,
            [tenantA, secteurA]
        )).rows[0].id;
        lotB = (await admin.query(
            `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut) VALUES ($1, $2, 'VRLS-B', 10, CURRENT_DATE, 'EN_COURS') RETURNING id`,
            [tenantB, secteurB]
        )).rows[0].id;
        clientA = (await admin.query(
            `INSERT INTO clients (tenant_id, nom, type_client, categorie_tarifaire, telephone, limite_credit, solde_encours) VALUES ($1, 'Client Verify A', 'B2C', 'standard', '+221700000901', 0, 0) RETURNING id`,
            [tenantA]
        )).rows[0].id;
        clientB = (await admin.query(
            `INSERT INTO clients (tenant_id, nom, type_client, categorie_tarifaire, telephone, limite_credit, solde_encours) VALUES ($1, 'Client Verify B', 'B2C', 'standard', '+221700000902', 0, 0) RETURNING id`,
            [tenantB]
        )).rows[0].id;
        ticketA = (await admin.query(`INSERT INTO tickets (tenant_id, client_id, sujet) VALUES ($1, $2, 'Ticket A') RETURNING id`, [tenantA, clientA])).rows[0].id;
        ticketB = (await admin.query(`INSERT INTO tickets (tenant_id, client_id, sujet) VALUES ($1, $2, 'Ticket B') RETURNING id`, [tenantB, clientB])).rows[0].id;
        await admin.query(`INSERT INTO ticket_messages (ticket_id, auteur_client_id, message) VALUES ($1, $2, 'Message A')`, [ticketA, clientA]);
        await admin.query(`INSERT INTO ticket_messages (ticket_id, auteur_client_id, message) VALUES ($1, $2, 'Message B')`, [ticketB, clientB]);

        // --- Vérifications avec le rôle applicatif (erp_app). ---
        const client = await app.connect();
        try {
            // 1. Table stricte, tenant_id direct : contexte A ne voit jamais les lignes de B, même
            //    sans WHERE explicite (c'est tout l'intérêt du filet RLS).
            await poserContexte(client, tenantA);
            const lots = await client.query(`SELECT id, code_lot FROM lots_production`);
            verifier('lots_production : contexte A voit son propre lot', lots.rows.some((r) => r.id === lotA));
            verifier('lots_production : contexte A ne voit jamais le lot de B', !lots.rows.some((r) => r.id === lotB));

            // 2. Table stricte : aucun contexte posé => zéro ligne (fail closed), pas une erreur qui
            //    passerait inaperçue.
            await poserContexte(client, null);
            const lotsSansContexte = await client.query(`SELECT id FROM lots_production`);
            verifier('lots_production : sans contexte tenant, zéro ligne visible', lotsSansContexte.rows.length === 0);

            // 3. Table enfant sans tenant_id propre (filtrage par sous-requête vers le parent).
            await poserContexte(client, tenantA);
            const messages = await client.query(`SELECT message FROM ticket_messages`);
            verifier('ticket_messages : contexte A voit son propre message', messages.rows.some((r) => r.message === 'Message A'));
            verifier('ticket_messages : contexte A ne voit jamais le message de B', !messages.rows.some((r) => r.message === 'Message B'));

            // 4. Table avec échappatoire ciblée en lecture (login) : sans contexte, les DEUX clients
            //    restent visibles (comportement voulu, pas une fuite — voir rls-policies.sql).
            await poserContexte(client, null);
            const clientsSansContexte = await client.query(`SELECT id FROM clients WHERE id IN ($1, $2)`, [clientA, clientB]);
            verifier('clients : sans contexte tenant, les deux restent lisibles (login)', clientsSansContexte.rows.length === 2);

            // 5. Mais l'écriture reste stricte même sur une table à échappatoire : impossible d'insérer
            //    sous le tenant de A un client qu'on prétend appartenir à B.
            await poserContexte(client, tenantA);
            let insertionRejetee = false;
            try {
                await client.query(
                    `INSERT INTO clients (tenant_id, nom, type_client, categorie_tarifaire, telephone, limite_credit, solde_encours) VALUES ($1, 'Client Suspect', 'B2C', 'standard', '+221700000903', 0, 0)`,
                    [tenantB]
                );
            } catch (err) {
                insertionRejetee = true;
            }
            verifier("clients : impossible d'insérer une ligne pour un autre tenant que celui du contexte courant", insertionRejetee);

            // 6. Vue plateforme (is_plateforme_admin) : contexte A + flag actif voit AUSSI les
            //    tickets de B — l'échappatoire de lecture cross-tenant fonctionne.
            await poserContexte(client, tenantA);
            await poserPlateforme(client, true);
            const ticketsPlateforme = await client.query(`SELECT id FROM tickets WHERE id IN ($1, $2)`, [ticketA, ticketB]);
            verifier('tickets : avec is_plateforme_admin, contexte A voit aussi le ticket de B', ticketsPlateforme.rows.length === 2);

            // 7. Mais l'échappatoire est UNIQUEMENT en lecture : impossible de modifier le ticket de
            //    B depuis le contexte de A, même avec is_plateforme_admin actif.
            const updateTicketB = await client.query(`UPDATE tickets SET sujet = 'Modifié par erreur' WHERE id = $1 RETURNING id`, [ticketB]);
            verifier("tickets : is_plateforme_admin ne permet jamais d'écrire sur le ticket d'un autre tenant", updateTicketB.rows.length === 0);

            // 8. audit_logs a la seule échappatoire d'ÉCRITURE de tout le fichier (nécessaire pour
            //    journaliser une connexion support dans le tenant CIBLE, pas celui du superviseur).
            //    Jamais de RETURNING ici (ni dans le vrai code, audit.js:logAudit) : RETURNING
            //    déclenche EN PLUS une vérification via la policy SELECT — stricte, sans échappatoire
            //    — de la ligne qu'on vient d'insérer, ce qui ferait échouer ce test pour une raison
            //    sans rapport avec ce qu'il vérifie réellement (déjà rencontré en vérifiant ceci).
            let auditInsereSousAutreTenant = false;
            try {
                await client.query(`INSERT INTO audit_logs (tenant_id, table_name, action) VALUES ($1, 'utilisateurs', 'VERIFY_RLS_TEST')`, [tenantB]);
                const verif = await admin.query(`SELECT id FROM audit_logs WHERE tenant_id = $1 AND action = 'VERIFY_RLS_TEST'`, [tenantB]);
                auditInsereSousAutreTenant = verif.rows.length === 1;
                await admin.query(`DELETE FROM audit_logs WHERE tenant_id = $1 AND action = 'VERIFY_RLS_TEST'`, [tenantB]);
            } catch (err) {
                auditInsereSousAutreTenant = false;
            }
            verifier('audit_logs : is_plateforme_admin permet de journaliser dans le tenant cible (connexion support)', auditInsereSousAutreTenant);

            // 8bis. Facturation SaaS (organisation_abonnement_saas / factures_saas) : accès
            //    UNIQUEMENT via is_plateforme_admin(), jamais via current_tenant_id() — même son
            //    PROPRE abonnement doit rester invisible à un admin de ferme normal.
            await poserContexte(client, tenantA);
            await poserPlateforme(client, false);
            let ecritureAbonnementRejetee = false;
            try {
                await client.query(`INSERT INTO organisation_abonnement_saas (tenant_id, montant_mensuel) VALUES ($1, 10000)`, [tenantA]);
            } catch (err) {
                ecritureAbonnementRejetee = true;
            }
            verifier("organisation_abonnement_saas : un admin de ferme (sans is_plateforme_admin) ne peut pas écrire, même pour SA PROPRE organisation", ecritureAbonnementRejetee);

            await admin.query(`INSERT INTO organisation_abonnement_saas (tenant_id, montant_mensuel) VALUES ($1, 10000)`, [tenantA]);
            const abonnementLectureSansFlag = await client.query(`SELECT tenant_id FROM organisation_abonnement_saas WHERE tenant_id = $1`, [tenantA]);
            verifier("organisation_abonnement_saas : un admin de ferme (sans is_plateforme_admin) ne peut pas lire SON PROPRE abonnement", abonnementLectureSansFlag.rows.length === 0);

            await poserPlateforme(client, true);
            const abonnementLectureAvecFlag = await client.query(`SELECT tenant_id FROM organisation_abonnement_saas WHERE tenant_id = $1`, [tenantA]);
            verifier('organisation_abonnement_saas : is_plateforme_admin donne accès normalement', abonnementLectureAvecFlag.rows.length === 1);
            await poserPlateforme(client, false);

            // 9. Une fois le flag retiré, plus aucun accès cross-tenant — pas de fuite résiduelle.
            await poserPlateforme(client, false);
            const ticketsSansPlateforme = await client.query(`SELECT id FROM tickets WHERE id IN ($1, $2)`, [ticketA, ticketB]);
            verifier('tickets : is_plateforme_admin retiré, contexte A ne voit plus le ticket de B', ticketsSansPlateforme.rows.length === 1 && ticketsSansPlateforme.rows[0].id === ticketA);
        } finally {
            client.release();
        }
    } finally {
        // --- Nettoyage (rôle propriétaire, ordre inverse des FK). ---
        await admin.query(`DELETE FROM factures_saas WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]).catch(() => {});
        await admin.query(`DELETE FROM organisation_abonnement_saas WHERE tenant_id IN ($1, $2)`, [tenantA, tenantB]).catch(() => {});
        await admin.query(`DELETE FROM ticket_messages WHERE ticket_id IN ($1, $2)`, [ticketA, ticketB]).catch(() => {});
        await admin.query(`DELETE FROM tickets WHERE id IN ($1, $2)`, [ticketA, ticketB]).catch(() => {});
        await admin.query(`DELETE FROM clients WHERE id IN ($1, $2)`, [clientA, clientB]).catch(() => {});
        await admin.query(`DELETE FROM lots_production WHERE id IN ($1, $2)`, [lotA, lotB]).catch(() => {});
        await admin.query(`DELETE FROM secteurs WHERE id IN ($1, $2)`, [secteurA, secteurB]).catch(() => {});
        await admin.query(`DELETE FROM organisations WHERE id IN ($1, $2)`, [tenantA, tenantB]).catch(() => {});
        await admin.end();
        await app.end();
    }

    console.log('\nRésultat de la vérification RLS :\n');
    let echecs = 0;
    for (const r of resultats) {
        console.log(`  ${r.ok ? '✓' : '✗'} ${r.nom}`);
        if (!r.ok) echecs += 1;
    }
    console.log(`\n${resultats.length - echecs}/${resultats.length} vérifications passées.`);
    if (echecs > 0) {
        console.error('\nDes policies RLS ne se comportent pas comme attendu — NE PAS basculer DATABASE_URL vers erp_app avant correction.');
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Échec de la vérification RLS:', err.message);
    process.exit(1);
});
