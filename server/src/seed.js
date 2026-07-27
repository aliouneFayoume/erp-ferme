const bcrypt = require('bcryptjs');

/**
 * Prototype multi-tenant : provisionne DEUX organisations distinctes (au lieu d'un jeu de données
 * global unique) pour pouvoir vérifier concrètement, en local/navigateur, que les données de l'une
 * ne fuitent jamais vers l'autre (clients.js, dashboard.js). roles reste global (RBAC partagé).
 */
async function seed(pool) {
    const motDePasse = await bcrypt.hash('demo1234', 10);

    const roles = ['admin', 'comptable', 'chef_prod', 'livreur'];
    const roleIds = {};
    for (const r of roles) {
        const res = await pool.query(`INSERT INTO roles (nom) VALUES ($1) RETURNING id`, [r]);
        roleIds[r] = res.rows[0].id;
    }

    const orgMassla = await seedOrganisation(pool, {
        nom: 'Ferme Massla',
        emailDomaine: 'massla.sn',
        secteurs: [
            { nom: 'Avicole', suivi_recolte: false },
            { nom: 'Piscicole', suivi_recolte: false },
            { nom: 'Maraîcher', suivi_recolte: true },
        ],
        utilisateurs: [
            { nom: 'Aïssatou Diop', email: 'admin@massla.sn', role: 'admin', secteur: null },
            { nom: 'Moussa Fall', email: 'comptable@massla.sn', role: 'comptable', secteur: null },
            { nom: 'Ibrahima Ndiaye', email: 'chef.avicole@massla.sn', role: 'chef_prod', secteur: 'Avicole' },
            { nom: 'Fatou Sarr', email: 'chef.piscicole@massla.sn', role: 'chef_prod', secteur: 'Piscicole' },
            { nom: 'Cheikh Ba', email: 'chef.maraicher@massla.sn', role: 'chef_prod', secteur: 'Maraîcher' },
            { nom: 'Ousmane Diallo', email: 'livreur1@massla.sn', role: 'livreur', secteur: null },
            { nom: 'Modou Gueye', email: 'livreur2@massla.sn', role: 'livreur', secteur: null },
        ],
        clients: [
            { nom: 'Hôtel Teranga Dakar', type: 'B2B', cat: 'restaurant', tel: '+221771000001', adresse: 'Route de la Corniche, Dakar', lat: 14.6928, lng: -17.4467, credit: 1500000 },
            { nom: 'Restaurant Le Baobab', type: 'B2B', cat: 'restaurant', tel: '+221771000002', adresse: 'Almadies, Dakar', lat: 14.7295, lng: -17.5113, credit: 500000 },
            { nom: 'Grossiste Marché Sandaga', type: 'B2B', cat: 'grossiste', tel: '+221771000003', adresse: 'Sandaga, Dakar', lat: 14.6719, lng: -17.4362, credit: 2000000 },
            { nom: 'Supermarché Diamniadio', type: 'B2B', cat: 'grossiste', tel: '+221771000004', adresse: 'Diamniadio', lat: 14.7247, lng: -17.1875, credit: 800000 },
            { nom: 'Aminata Cissé', type: 'B2C', cat: 'standard', tel: '+221771000005', adresse: 'Sacré-Cœur, Dakar', lat: 14.7011, lng: -17.4677, credit: 0, abonne: true },
            { nom: 'Babacar Ndour', type: 'B2C', cat: 'standard', tel: '+221771000006', adresse: 'Mermoz, Dakar', lat: 14.7127, lng: -17.4779, credit: 0, abonne: false },
            { nom: 'Coumba Diagne', type: 'B2C', cat: 'standard', tel: '+221771000007', adresse: 'Thiès Nord', lat: 14.7910, lng: -16.9256, credit: 0, abonne: true },
        ],
        produits: [
            { secteur: 'Avicole', nom: 'Poulet de chair (vif)', unite: 'TETE', b2b: 2800, b2c: 3500, gros: 2500 },
            { secteur: 'Avicole', nom: 'Œufs (plateau de 30)', unite: 'CAISSE', b2b: 2200, b2c: 2700, gros: 1950 },
            { secteur: 'Piscicole', nom: 'Tilapia frais', unite: 'KG', b2b: 1800, b2c: 2300, gros: 1600 },
            { secteur: 'Piscicole', nom: 'Silure fumé', unite: 'KG', b2b: 2500, b2c: 3200, gros: null },
            { secteur: 'Maraîcher', nom: 'Tomate', unite: 'KG', b2b: 350, b2c: 500, gros: 300 },
            { secteur: 'Maraîcher', nom: 'Chou pommé', unite: 'KG', b2b: 300, b2c: 450, gros: 260 },
            { secteur: 'Maraîcher', nom: 'Bissap (bouquet)', unite: 'BOTTES', b2b: 150, b2c: 250, gros: null },
        ],
        lots: [
            { secteur: 'Avicole', code: 'AVI-2026-05', qte: 850, date: '2026-06-01', cree_par: 'chef.avicole@massla.sn' },
            { secteur: 'Avicole', code: 'AVI-2026-06', qte: 500, date: '2026-06-25', cree_par: 'chef.avicole@massla.sn' },
            { secteur: 'Piscicole', code: 'PIS-2026-03', qte: 3000, date: '2026-04-10', cree_par: 'chef.piscicole@massla.sn' },
            { secteur: 'Maraîcher', code: 'MAR-2026-TOM-1', qte: 400, date: '2026-05-15', culture: 'Tomate', duree: 60, cree_par: 'chef.maraicher@massla.sn' },
            { secteur: 'Maraîcher', code: 'MAR-2026-CHOU-1', qte: 250, date: '2026-06-25', culture: 'Chou pommé', duree: 30, cree_par: 'chef.maraicher@massla.sn' },
        ],
        commandeB2B: { numero: 'CMD-100001', clientIndex: 0, produitIndex: 0, quantite: 30, prixUnitaire: 2800, montant: 84000 },
        commandeB2C: { numero: 'CMD-100002', clientIndex: 4, produitIndex: 2, quantite: 2, prixUnitaire: 2300, montant: 4600, livreurEmail: 'livreur1@massla.sn' },
        caisseLivreurEmail: 'livreur1@massla.sn',
    }, roleIds, motDePasse);

    const orgSahel = await seedOrganisation(pool, {
        nom: 'Ferme Sahel Bio',
        emailDomaine: 'sahelbio.sn',
        secteurs: [
            { nom: 'Élevage bovin', suivi_recolte: false },
            { nom: 'Maraîchage bio', suivi_recolte: true },
        ],
        utilisateurs: [
            { nom: 'Awa Ndoye', email: 'admin@sahelbio.sn', role: 'admin', secteur: null },
            { nom: 'Idrissa Sow', email: 'comptable@sahelbio.sn', role: 'comptable', secteur: null },
            { nom: 'Mariama Kane', email: 'chef.elevage@sahelbio.sn', role: 'chef_prod', secteur: 'Élevage bovin' },
            { nom: 'Lamine Diouf', email: 'livreur1@sahelbio.sn', role: 'livreur', secteur: null },
        ],
        clients: [
            { nom: 'Boucherie Ndar', type: 'B2B', cat: 'restaurant', tel: '+221781000001', adresse: 'Saint-Louis Centre', lat: 16.0179, lng: -16.4896, credit: 900000 },
            { nom: 'Épicerie Fouta Vert', type: 'B2B', cat: 'grossiste', tel: '+221781000002', adresse: 'Podor', lat: 16.6567, lng: -14.9597, credit: 600000 },
            { nom: 'Fatoumata Sy', type: 'B2C', cat: 'standard', tel: '+221781000003', adresse: 'Saint-Louis Nord', lat: 16.0326, lng: -16.4818, credit: 0, abonne: true },
        ],
        produits: [
            { secteur: 'Élevage bovin', nom: 'Bœuf (vif)', unite: 'TETE', b2b: 180000, b2c: 220000, gros: 165000 },
            { secteur: 'Maraîchage bio', nom: 'Oignon bio', unite: 'KG', b2b: 400, b2c: 550, gros: 350 },
        ],
        lots: [
            { secteur: 'Élevage bovin', code: 'BOV-2026-01', qte: 60, date: '2026-05-01', cree_par: 'chef.elevage@sahelbio.sn' },
            { secteur: 'Maraîchage bio', code: 'MBIO-2026-OIG-1', qte: 300, date: '2026-06-20', culture: 'Oignon', duree: 40, cree_par: 'chef.elevage@sahelbio.sn' },
        ],
        commandeB2B: { numero: 'CMD-SB-1001', clientIndex: 0, produitIndex: 0, quantite: 2, prixUnitaire: 180000, montant: 360000 },
        commandeB2C: { numero: 'CMD-SB-1002', clientIndex: 2, produitIndex: 1, quantite: 5, prixUnitaire: 550, montant: 2750, livreurEmail: 'livreur1@sahelbio.sn' },
        caisseLivreurEmail: 'livreur1@sahelbio.sn',
    }, roleIds, motDePasse);

    return { organisations: { massla: orgMassla, sahelBio: orgSahel } };
}

async function seedOrganisation(pool, def, roleIds, motDePasse) {
    const orgRes = await pool.query(`INSERT INTO organisations (nom) VALUES ($1) RETURNING id`, [def.nom]);
    const tenantId = orgRes.rows[0].id;

    const secteurIds = {};
    for (const s of def.secteurs) {
        const res = await pool.query(
            `INSERT INTO secteurs (tenant_id, nom, suivi_recolte) VALUES ($1, $2, $3) RETURNING id`,
            [tenantId, s.nom, !!s.suivi_recolte]
        );
        secteurIds[s.nom] = res.rows[0].id;
    }

    const userIds = {};
    for (const u of def.utilisateurs) {
        const res = await pool.query(
            `INSERT INTO utilisateurs (tenant_id, nom_complet, email, mot_de_passe_hash, role_id, secteur_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [tenantId, u.nom, u.email, motDePasse, roleIds[u.role], u.secteur ? secteurIds[u.secteur] : null]
        );
        userIds[u.email] = res.rows[0].id;
    }

    const clientIds = [];
    for (const c of def.clients) {
        const res = await pool.query(
            `INSERT INTO clients (tenant_id, nom, type_client, categorie_tarifaire, telephone, adresse, gps_lat, gps_lng, limite_credit, solde_encours, est_abonne)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10) RETURNING id`,
            [tenantId, c.nom, c.type, c.cat, c.tel, c.adresse, c.lat, c.lng, c.credit, !!c.abonne]
        );
        clientIds.push(res.rows[0].id);
    }

    const produitIds = [];
    for (const p of def.produits) {
        const res = await pool.query(
            `INSERT INTO produits (tenant_id, secteur_id, nom, unite_mesure, prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [tenantId, secteurIds[p.secteur], p.nom, p.unite, p.b2b, p.b2c, p.gros]
        );
        produitIds.push(res.rows[0].id);
        await pool.query(
            `INSERT INTO stocks (produit_id, quantite_disponible, seuil_alerte) VALUES ($1, $2, 15)`,
            [res.rows[0].id, 200 + Math.round(Math.random() * 300)]
        );
    }

    const lotIds = [];
    for (const l of def.lots) {
        const res = await pool.query(
            `INSERT INTO lots_production (tenant_id, secteur_id, code_lot, quantite_initiale, date_demarrage, statut, culture, duree_maturite_jours, cree_par)
             VALUES ($1, $2, $3, $4, $5, 'EN_COURS', $6, $7, $8) RETURNING id`,
            [tenantId, secteurIds[l.secteur], l.code, l.qte, l.date, l.culture || null, l.duree || null, userIds[l.cree_par]]
        );
        lotIds.push(res.rows[0].id);
    }

    const aujourdhui = new Date().toISOString().slice(0, 10);
    const dans30jours = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    const b2b = def.commandeB2B;
    const cmdB2B = await pool.query(
        `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, $2, $3, 'LIVREE', $4) RETURNING id`,
        [tenantId, b2b.numero, clientIds[b2b.clientIndex], b2b.montant]
    );
    await pool.query(
        `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_unitaire_applique, sous_total) VALUES ($1, $2, $3, $4, $5)`,
        [cmdB2B.rows[0].id, produitIds[b2b.produitIndex], b2b.quantite, b2b.prixUnitaire, b2b.montant]
    );
    await pool.query(
        `INSERT INTO factures (commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, 'A_PAYER', $3)`,
        [cmdB2B.rows[0].id, dans30jours, b2b.montant]
    );
    await pool.query(`UPDATE clients SET solde_encours = solde_encours + $1 WHERE id = $2`, [b2b.montant, clientIds[b2b.clientIndex]]);

    const b2c = def.commandeB2C;
    const cmdB2C = await pool.query(
        `INSERT INTO commandes (tenant_id, numero_commande, client_id, statut, montant_total) VALUES ($1, $2, $3, 'EN_ATTENTE', $4) RETURNING id`,
        [tenantId, b2c.numero, clientIds[b2c.clientIndex], b2c.montant]
    );
    await pool.query(
        `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_unitaire_applique, sous_total) VALUES ($1, $2, $3, $4, $5)`,
        [cmdB2C.rows[0].id, produitIds[b2c.produitIndex], b2c.quantite, b2c.prixUnitaire, b2c.montant]
    );
    await pool.query(
        `INSERT INTO factures (commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, 'A_PAYER', $3)`,
        [cmdB2C.rows[0].id, aujourdhui, b2c.montant]
    );
    await pool.query(
        `INSERT INTO livraisons (commande_id, livreur_id, date_prevue, statut) VALUES ($1, $2, $3, 'A_FAIRE')`,
        [cmdB2C.rows[0].id, userIds[b2c.livreurEmail], aujourdhui]
    );

    await pool.query(
        `INSERT INTO caisses_chauffeur (tenant_id, livreur_id, date_caisse, statut) VALUES ($1, $2, $3, 'OUVERTE')`,
        [tenantId, userIds[def.caisseLivreurEmail], aujourdhui]
    );

    return { tenantId, secteurIds, userIds, clientIds, produitIds, lotIds };
}

module.exports = { seed };
