// Bilan par lot (Easystart phase 4, migration-36) : ce que chaque lot rapporte.
//   marge = ventes rattachées au lot − (aliment + autres coûts)
// - ventes : lignes de commande dont lot_id est ce lot (commandes non annulées, non supprimées) ;
// - aliment : kg consommés (somme des relevés journaliers) × prix moyen du kg saisi sur le lot ;
// - autres coûts : saisis par lot (couts_lot) — poussins, vaccins/vétérinaire, main-d'œuvre, transport, autre.
// Une donnée manquante n'est JAMAIS comptée comme zéro en silence : `manques` la nomme, et le bilan se déclare incomplet
// plutôt que d'afficher une marge flatteuse (sans les poussins, par exemple, la marge d'un lot de poulets serait gonflée d'environ
// un quart).

const CATEGORIES_COUT = ['Poussins', 'Vétérinaire', "Main d'œuvre", 'Transport', 'Autre'];

const nombre = (v) => Number(v || 0);

async function calculerBilanLot(db, lot) {
    const releves = await db.query(`SELECT COALESCE(SUM(conso_aliment_kg), 0) AS kg FROM releves_journaliers WHERE lot_id = $1`, [lot.id]);
    const alimentKg = nombre(releves.rows[0].kg);
    const prixKg = lot.prix_aliment_kg === null || lot.prix_aliment_kg === undefined ? null : nombre(lot.prix_aliment_kg);
    const coutAliment = prixKg === null ? null : alimentKg * prixKg;

    const couts = await db.query(
        `SELECT id, categorie, libelle, montant, date_cout FROM couts_lot WHERE lot_id = $1 AND tenant_id = $2 AND deleted_at IS NULL ORDER BY date_cout ASC, id ASC`,
        [lot.id, lot.tenant_id]
    );
    const parCategorie = Object.fromEntries(CATEGORIES_COUT.map((c) => [c, 0]));
    for (const c of couts.rows) parCategorie[c.categorie] = (parCategorie[c.categorie] || 0) + nombre(c.montant);
    const totalAutres = couts.rows.reduce((s, c) => s + nombre(c.montant), 0);

    const ventesRes = await db.query(
        `SELECT lc.sous_total, lc.quantite, p.unite_mesure
         FROM lignes_commande lc
         JOIN commandes c ON c.id = lc.commande_id
         JOIN produits p ON p.id = lc.produit_id
         WHERE lc.lot_id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL AND c.statut <> 'ANNULEE'`,
        [lot.id, lot.tenant_id]
    );
    const ventesTotal = ventesRes.rows.reduce((s, l) => s + nombre(l.sous_total), 0);
    const sujetsVendus = ventesRes.rows.filter((l) => l.unite_mesure === 'TETE').reduce((s, l) => s + nombre(l.quantite), 0);

    const manques = [];
    if (prixKg === null) manques.push('prix_aliment');
    if (parCategorie.Poussins === 0) manques.push('poussins');
    if (ventesRes.rows.length === 0) manques.push('ventes');

    const totalCouts = (coutAliment || 0) + totalAutres;
    const marge = ventesTotal - totalCouts;
    return {
        lot: { id: lot.id, code_lot: lot.code_lot, statut: lot.statut, date_demarrage: lot.date_demarrage, effectif_actuel: nombre(lot.quantite_initiale), est_demo: !!lot.est_demo },
        aliment: { kg: alimentKg, prix_kg: prixKg, cout: coutAliment },
        couts: { lignes: couts.rows, par_categorie: parCategorie, total_autres: totalAutres },
        ventes: { total: ventesTotal, nb_lignes: ventesRes.rows.length, sujets_vendus: sujetsVendus },
        total_couts: totalCouts,
        marge,
        marge_pct: ventesTotal > 0 ? (marge / ventesTotal) * 100 : null,
        marge_par_sujet: sujetsVendus > 0 ? marge / sujetsVendus : null,
        manques,
        complet: manques.length === 0,
    };
}

module.exports = { calculerBilanLot, CATEGORIES_COUT };
