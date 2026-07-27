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
            const tenantId = req.user.tenant_id;

            const [caJour, commandesB2C, stockTotal, encoursB2B, caissesOuvertes, lotsActifs, lotsRecolte] = await Promise.all([
                pool.query(
                    `SELECT COALESCE(SUM(montant_total), 0) as total FROM commandes WHERE tenant_id = $1 AND cree_le >= $2 AND cree_le < $3 AND statut != 'ANNULEE' AND deleted_at IS NULL`,
                    [tenantId, debutJour, finJour]
                ),
                pool.query(
                    `SELECT COUNT(*) as count FROM commandes c JOIN clients cl ON c.client_id = cl.id WHERE c.tenant_id = $1 AND cl.type_client = 'B2C' AND c.cree_le >= $2 AND c.cree_le < $3`,
                    [tenantId, debutJour, finJour]
                ),
                // Généralisé (prototype multi-tenant) : total tous secteurs de l'organisation, plus de secteur nommé en dur.
                pool.query(
                    `SELECT COALESCE(SUM(quantite_disponible), 0) as total FROM stocks s JOIN produits p ON s.produit_id = p.id WHERE p.tenant_id = $1`,
                    [tenantId]
                ),
                pool.query(`SELECT COALESCE(SUM(solde_encours), 0) as total FROM clients WHERE tenant_id = $1 AND type_client = 'B2B' AND deleted_at IS NULL`, [tenantId]),
                pool.query(`SELECT COUNT(*) as count FROM caisses_chauffeur WHERE tenant_id = $1 AND statut = 'OUVERTE'`, [tenantId]),
                pool.query(`SELECT COUNT(*) as count FROM lots_production WHERE tenant_id = $1 AND statut = 'EN_COURS' AND deleted_at IS NULL`, [tenantId]),
                // Généralisé : secteurs.suivi_recolte remplace le test en dur "nom = 'Maraîcher'" — configurable par organisation.
                pool.query(
                    `SELECT l.date_demarrage, l.duree_maturite_jours FROM lots_production l
                     JOIN secteurs s ON l.secteur_id = s.id
                     WHERE l.tenant_id = $1 AND s.suivi_recolte = TRUE AND l.statut = 'EN_COURS' AND l.deleted_at IS NULL AND l.duree_maturite_jours IS NOT NULL`,
                    [tenantId]
                ),
            ]);

            // Calculé en JS plutôt qu'en SQL (arithmétique de dates) pour rester portable pg-mem/PostgreSQL.
            const maintenant = Date.now();
            const recoltesProches = lotsRecolte.rows.filter((l) => {
                const prevue = new Date(l.date_demarrage).getTime() + Number(l.duree_maturite_jours) * 86400000;
                const joursRestants = (prevue - maintenant) / 86400000;
                return joursRestants <= 7;
            }).length;

            res.json({
                chiffreAffairesJour: Number(caJour.rows[0].total),
                commandesB2C: Number(commandesB2C.rows[0].count),
                stockTotal: Number(stockTotal.rows[0].total),
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
