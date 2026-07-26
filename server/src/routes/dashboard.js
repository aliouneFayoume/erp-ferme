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

            const [caJour, commandesB2C, stockAvicole, encoursB2B, caissesOuvertes, lotsActifs, lotsMaraicher] = await Promise.all([
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
            ]);

            // Calculé en JS plutôt qu'en SQL (arithmétique de dates) pour rester portable pg-mem/PostgreSQL.
            const maintenant = Date.now();
            const recoltesProches = lotsMaraicher.rows.filter((l) => {
                const prevue = new Date(l.date_demarrage).getTime() + Number(l.duree_maturite_jours) * 86400000;
                const joursRestants = (prevue - maintenant) / 86400000;
                return joursRestants <= 7;
            }).length;

            res.json({
                chiffreAffairesJour: Number(caJour.rows[0].total),
                commandesB2C: Number(commandesB2C.rows[0].count),
                stockAvicole: Number(stockAvicole.rows[0].total),
                encoursB2B: Number(encoursB2B.rows[0].total),
                caissesOuvertes: Number(caissesOuvertes.rows[0].count),
                lotsActifs: Number(lotsActifs.rows[0].count),
                recoltesProches,
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ erreur: 'Erreur lors de la récupération des statistiques' });
        }
    });

    return router;
};
