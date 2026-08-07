const express = require('express');
const { requireAuth, checkRole } = require('../auth');

function todayBounds() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return [start.toISOString(), end.toISOString()];
}

module.exports = function dashboardRoutes(pool) {
    const router = express.Router();

    router.get('/stats', requireAuth, checkRole(['comptable']), async (req, res) => {
        try {
            const [debutJour, finJour] = todayBounds();

            const [caJour, commandesB2C, stockAvicole, encoursB2B, caissesOuvertes, lotsActifs, lotsMaraicher, caParJour, produitsSousSeuil] = await Promise.all([
                pool.query(
                    `SELECT COALESCE(SUM(montant_total), 0) as total FROM commandes WHERE cree_le >= $1 AND cree_le < $2 AND statut != 'ANNULEE' AND deleted_at IS NULL`,
                    [debutJour, finJour]
                ),
                pool.query(
                    `SELECT COUNT(*) as count FROM commandes c JOIN clients cl ON c.client_id = cl.id WHERE cl.type_client = 'B2C' AND c.cree_le >= $1 AND c.cree_le < $2`,
                    [debutJour, finJour]
                ),
                pool.query(
                    `SELECT COALESCE(SUM(quantite_disponible), 0) as total FROM stocks s JOIN produits p ON s.produit_id = p.id JOIN secteurs sec ON p.secteur_id = sec.id WHERE sec.nom = 'Avicole'`
                ),
                pool.query(`SELECT COALESCE(SUM(solde_encours), 0) as total FROM clients WHERE type_client = 'B2B' AND deleted_at IS NULL`),
                pool.query(`SELECT COUNT(*) as count FROM caisses_chauffeur WHERE statut = 'OUVERTE'`),
                pool.query(`SELECT COUNT(*) as count FROM lots_production WHERE statut = 'EN_COURS' AND deleted_at IS NULL`),
                pool.query(
                    `SELECT l.date_demarrage, l.duree_maturite_jours FROM lots_production l
                     JOIN secteurs s ON l.secteur_id = s.id
                     WHERE s.nom = 'Maraîcher' AND l.statut = 'EN_COURS' AND l.deleted_at IS NULL AND l.duree_maturite_jours IS NOT NULL`
                ),
                // Courbe d'évolution du CA (14 derniers jours) pour le graphique du dashboard : lignes
                // brutes, groupées par jour en JS plus bas (date_trunc n'est pas supporté par pg-mem,
                // même contrainte que recoltesProches ci-dessous).
                pool.query(
                    `SELECT cree_le, montant_total
                     FROM commandes
                     WHERE cree_le >= $1 AND statut != 'ANNULEE' AND deleted_at IS NULL`,
                    [new Date(Date.now() - 13 * 86400000).toISOString()]
                ),
                pool.query(
                    `SELECT COUNT(*) as count FROM stocks st JOIN produits p ON p.id = st.produit_id
                     WHERE p.deleted_at IS NULL AND p.actif = TRUE AND st.quantite_disponible <= st.seuil_alerte`
                ),
            ]);

            // Calculé en JS plutôt qu'en SQL (arithmétique de dates) pour rester portable pg-mem/PostgreSQL.
            const maintenant = Date.now();
            const recoltesProches = lotsMaraicher.rows.filter((l) => {
                const prevue = new Date(l.date_demarrage).getTime() + Number(l.duree_maturite_jours) * 86400000;
                const joursRestants = (prevue - maintenant) / 86400000;
                return joursRestants <= 7;
            }).length;

            // Regroupe par jour (clé YYYY-MM-DD) puis complète les jours sans commande à 0 pour une
            // courbe continue sur 14 jours.
            const parJourMap = new Map();
            for (const r of caParJour.rows) {
                const jour = new Date(r.cree_le).toISOString().slice(0, 10);
                parJourMap.set(jour, (parJourMap.get(jour) || 0) + Number(r.montant_total));
            }
            const chiffreAffairesParJour = [];
            for (let i = 13; i >= 0; i--) {
                const jour = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
                chiffreAffairesParJour.push({ date: jour, value: parJourMap.get(jour) || 0 });
            }

            res.json({
                chiffreAffairesJour: Number(caJour.rows[0].total),
                commandesB2C: Number(commandesB2C.rows[0].count),
                stockAvicole: Number(stockAvicole.rows[0].total),
                encoursB2B: Number(encoursB2B.rows[0].total),
                caissesOuvertes: Number(caissesOuvertes.rows[0].count),
                lotsActifs: Number(lotsActifs.rows[0].count),
                recoltesProches,
                produitsSousSeuil: Number(produitsSousSeuil.rows[0].count),
                chiffreAffairesParJour,
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la récupération des statistiques' });
        }
    });

    return router;
};
