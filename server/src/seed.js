const bcrypt = require('bcryptjs');

/** Jeu de données de démonstration réaliste (Sénégal / Dakar-Thiès-Diamniadio). */
async function seed(pool) {
    const roles = ['admin', 'comptable', 'chef_prod', 'livreur'];
    for (const r of roles) {
        await pool.query(`INSERT INTO roles (nom) VALUES ($1)`, [r]);
    }

    const secteurs = ['Avicole', 'Piscicole', 'Maraîcher'];
    for (const s of secteurs) {
        await pool.query(`INSERT INTO secteurs (nom) VALUES ($1)`, [s]);
    }

    const motDePasse = await bcrypt.hash('demo1234', 10);
    const utilisateurs = [
        { nom: 'Aïssatou Diop', email: 'admin@massla.sn', role: 1, secteur: null },
        { nom: 'Moussa Fall', email: 'comptable@massla.sn', role: 2, secteur: null },
        { nom: 'Ibrahima Ndiaye', email: 'chef.avicole@massla.sn', role: 3, secteur: 1 },
        { nom: 'Fatou Sarr', email: 'chef.piscicole@massla.sn', role: 3, secteur: 2 },
        { nom: 'Cheikh Ba', email: 'chef.maraicher@massla.sn', role: 3, secteur: 3 },
        { nom: 'Ousmane Diallo', email: 'livreur1@massla.sn', role: 4, secteur: null },
        { nom: 'Modou Gueye', email: 'livreur2@massla.sn', role: 4, secteur: null },
    ];
    const userIds = {};
    for (const u of utilisateurs) {
        const res = await pool.query(
            `INSERT INTO utilisateurs (nom_complet, email, mot_de_passe_hash, role_id, secteur_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [u.nom, u.email, motDePasse, u.role, u.secteur]
        );
        userIds[u.email] = res.rows[0].id;
    }

    // Clients B2B (hôtels, restaurants, grossistes) et B2C (particuliers abonnés)
    const clients = [
        { nom: 'Hôtel Teranga Dakar', type: 'B2B', cat: 'restaurant', tel: '+221771000001', adresse: 'Route de la Corniche, Dakar', lat: 14.6928, lng: -17.4467, credit: 1500000 },
        { nom: 'Restaurant Le Baobab', type: 'B2B', cat: 'restaurant', tel: '+221771000002', adresse: 'Almadies, Dakar', lat: 14.7295, lng: -17.5113, credit: 500000 },
        { nom: 'Grossiste Marché Sandaga', type: 'B2B', cat: 'grossiste', tel: '+221771000003', adresse: 'Sandaga, Dakar', lat: 14.6719, lng: -17.4362, credit: 2000000 },
        { nom: 'Supermarché Diamniadio', type: 'B2B', cat: 'grossiste', tel: '+221771000004', adresse: 'Diamniadio', lat: 14.7247, lng: -17.1875, credit: 800000 },
        { nom: 'Aminata Cissé', type: 'B2C', cat: 'standard', tel: '+221771000005', adresse: 'Sacré-Cœur, Dakar', lat: 14.7011, lng: -17.4677, credit: 0, abonne: true },
        { nom: 'Babacar Ndour', type: 'B2C', cat: 'standard', tel: '+221771000006', adresse: 'Mermoz, Dakar', lat: 14.7127, lng: -17.4779, credit: 0, abonne: false },
        { nom: 'Coumba Diagne', type: 'B2C', cat: 'standard', tel: '+221771000007', adresse: 'Thiès Nord', lat: 14.7910, lng: -16.9256, credit: 0, abonne: true },
    ];
    const clientIds = [];
    for (const c of clients) {
        const res = await pool.query(
            `INSERT INTO clients (nom, type_client, categorie_tarifaire, telephone, adresse, gps_lat, gps_lng, limite_credit, solde_encours, est_abonne)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9) RETURNING id`,
            [c.nom, c.type, c.cat, c.tel, c.adresse, c.lat, c.lng, c.credit, !!c.abonne]
        );
        clientIds.push(res.rows[0].id);
    }

    // Produits avec double grille tarifaire (B2B toujours plus avantageuse en volume)
    const produits = [
        { secteur: 1, nom: 'Poulet de chair (vif)', unite: 'TETE', b2b: 2800, b2c: 3500, gros: 2500 },
        { secteur: 1, nom: 'Œufs (plateau de 30)', unite: 'CAISSE', b2b: 2200, b2c: 2700, gros: 1950 },
        { secteur: 2, nom: 'Tilapia frais', unite: 'KG', b2b: 1800, b2c: 2300, gros: 1600 },
        { secteur: 2, nom: 'Silure fumé', unite: 'KG', b2b: 2500, b2c: 3200, gros: null },
        { secteur: 3, nom: 'Tomate', unite: 'KG', b2b: 350, b2c: 500, gros: 300 },
        { secteur: 3, nom: 'Chou pommé', unite: 'KG', b2b: 300, b2c: 450, gros: 260 },
        { secteur: 3, nom: 'Bissap (bouquet)', unite: 'BOTTES', b2b: 150, b2c: 250, gros: null },
    ];
    const produitIds = [];
    for (const p of produits) {
        const res = await pool.query(
            `INSERT INTO produits (secteur_id, nom, unite_mesure, prix_unitaire_b2b, prix_unitaire_b2c, prix_unitaire_grossiste) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [p.secteur, p.nom, p.unite, p.b2b, p.b2c, p.gros]
        );
        produitIds.push(res.rows[0].id);
        await pool.query(
            `INSERT INTO stocks (produit_id, quantite_disponible, seuil_alerte) VALUES ($1, $2, 15)`,
            [res.rows[0].id, 200 + Math.round(Math.random() * 300)]
        );
    }

    // Lots de production en cours par secteur
    const lots = [
        { secteur: 1, code: 'AVI-2026-05', qte: 850, date: '2026-06-01', cree_par: userIds['chef.avicole@massla.sn'] },
        { secteur: 1, code: 'AVI-2026-06', qte: 500, date: '2026-06-25', cree_par: userIds['chef.avicole@massla.sn'] },
        { secteur: 2, code: 'PIS-2026-03', qte: 3000, date: '2026-04-10', cree_par: userIds['chef.piscicole@massla.sn'] },
        // Planification des cultures : tomate déjà en retard de récolte, chou proche de la récolte (≤7j)
        { secteur: 3, code: 'MAR-2026-TOM-1', qte: 400, date: '2026-05-15', culture: 'Tomate', duree: 60, cree_par: userIds['chef.maraicher@massla.sn'] },
        { secteur: 3, code: 'MAR-2026-CHOU-1', qte: 250, date: '2026-06-25', culture: 'Chou pommé', duree: 30, cree_par: userIds['chef.maraicher@massla.sn'] },
    ];
    const lotIds = [];
    for (const l of lots) {
        const res = await pool.query(
            `INSERT INTO lots_production (secteur_id, code_lot, quantite_initiale, date_demarrage, statut, culture, duree_maturite_jours, cree_par)
             VALUES ($1, $2, $3, $4, 'EN_COURS', $5, $6, $7) RETURNING id`,
            [l.secteur, l.code, l.qte, l.date, l.culture || null, l.duree || null, l.cree_par]
        );
        lotIds.push(res.rows[0].id);
    }

    // Relevés journaliers récents (alimentent le calcul FCR et les KPI qualité d'eau)
    const releves = [
        { lot: lotIds[0], user: userIds['chef.avicole@massla.sn'], date: '2026-07-18', mortalite: 3, aliment: 180, poids: 1450 },
        { lot: lotIds[0], user: userIds['chef.avicole@massla.sn'], date: '2026-07-19', mortalite: 1, aliment: 185, poids: 1490 },
        { lot: lotIds[2], user: userIds['chef.piscicole@massla.sn'], date: '2026-07-19', mortalite: 12, aliment: 45, poids: 320, taille: 18.5, temp: 27.5, ph: 7.1 },
        { lot: lotIds[3], user: userIds['chef.maraicher@massla.sn'], date: '2026-07-18', mortalite: 0, aliment: 0, poids: 0, intrants: 'Engrais NPK 15-15-15, 20kg', recolte: 45 },
    ];
    for (const r of releves) {
        await pool.query(
            `INSERT INTO releves_journaliers (lot_id, utilisateur_id, date_releve, mortalite, conso_aliment_kg, poids_moyen_g, taille_moyenne_cm, temperature_eau, ph_eau, intrants_utilises, quantite_recoltee_kg)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [r.lot, r.user, r.date, r.mortalite, r.aliment, r.poids, r.taille || null, r.temp || null, r.ph || null, r.intrants || null, r.recolte || null]
        );
    }

    // Une commande B2B déjà livrée aujourd'hui + une commande B2C du jour (alimentent le dashboard)
    const cmdB2B = await pool.query(
        `INSERT INTO commandes (numero_commande, client_id, statut, montant_total) VALUES ('CMD-100001', $1, 'LIVREE', 84000) RETURNING id`,
        [clientIds[0]]
    );
    await pool.query(
        `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_unitaire_applique, sous_total) VALUES ($1, $2, 30, 2800, 84000)`,
        [cmdB2B.rows[0].id, produitIds[0]]
    );
    const aujourdhui = new Date().toISOString().slice(0, 10);
    const dans30jours = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    await pool.query(
        `INSERT INTO factures (commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, 'A_PAYER', 84000)`,
        [cmdB2B.rows[0].id, dans30jours]
    );
    await pool.query(`UPDATE clients SET solde_encours = solde_encours + 84000 WHERE id = $1`, [clientIds[0]]);

    const cmdB2C = await pool.query(
        `INSERT INTO commandes (numero_commande, client_id, statut, montant_total) VALUES ('CMD-100002', $1, 'EN_ATTENTE', 4600) RETURNING id`,
        [clientIds[4]]
    );
    await pool.query(
        `INSERT INTO lignes_commande (commande_id, produit_id, quantite, prix_unitaire_applique, sous_total) VALUES ($1, $2, 2, 2300, 4600)`,
        [cmdB2C.rows[0].id, produitIds[2]]
    );
    await pool.query(
        `INSERT INTO factures (commande_id, date_echeance, statut, montant_restant) VALUES ($1, $2, 'A_PAYER', 4600)`,
        [cmdB2C.rows[0].id, aujourdhui]
    );

    // Livraison du jour à faire pour le livreur 1, avec point GPS client
    await pool.query(
        `INSERT INTO livraisons (commande_id, livreur_id, date_prevue, statut) VALUES ($1, $2, $3, 'A_FAIRE')`,
        [cmdB2C.rows[0].id, userIds['livreur1@massla.sn'], aujourdhui]
    );

    // Dépenses par pôle (comptabilité analytique)
    const depenses = [
        { secteur: 1, categorie: 'Aliment', montant: 45000, description: 'Aliment volaille (croissance)', date: '2026-07-15' },
        { secteur: 1, categorie: 'Vétérinaire', montant: 12000, description: 'Vaccination Newcastle', date: '2026-07-10' },
        { secteur: 2, categorie: 'Aliment', montant: 32000, description: 'Granulés poisson', date: '2026-07-16' },
        { secteur: 3, categorie: 'Intrants', montant: 18000, description: 'Engrais NPK + semences', date: '2026-07-10' },
        { secteur: null, categorie: "Main d'œuvre", montant: 150000, description: 'Salaires équipe (mensuel)', date: '2026-07-01' },
    ];
    for (const d of depenses) {
        await pool.query(
            `INSERT INTO depenses (secteur_id, categorie, montant, description, date_depense, cree_par) VALUES ($1, $2, $3, $4, $5, $6)`,
            [d.secteur, d.categorie, d.montant, d.description, d.date, userIds['comptable@massla.sn']]
        );
    }

    // Relevés bancaires (saisie manuelle simulant un import) — un déjà rapproché, un en attente
    await pool.query(
        `INSERT INTO releves_bancaires (date_operation, libelle, montant, type_operation, cree_par) VALUES ($1, $2, $3, 'CREDIT', $4)`,
        [aujourdhui, 'VIR WAVE CLIENT - HOTEL TERANGA', 84000, userIds['comptable@massla.sn']]
    );
    await pool.query(
        `INSERT INTO releves_bancaires (date_operation, libelle, montant, type_operation, cree_par) VALUES ($1, $2, $3, 'DEBIT', $4)`,
        ['2026-07-15', 'ACHAT ALIMENTS - FOURNISSEUR AGRO', 45000, userIds['comptable@massla.sn']]
    );

    return { userIds, clientIds, produitIds, lotIds };
}

module.exports = { seed };
