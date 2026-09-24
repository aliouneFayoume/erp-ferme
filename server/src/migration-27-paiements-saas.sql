-- ==============================================================================
-- MIGRATION 27 — Paiement en ligne des factures SaaS (Massla se fait payer via PayDunya)
-- ==============================================================================
-- Jusqu'ici, une facture SaaS (mise en route / abonnement mensuel) se réglait hors application (Wave,
-- Orange Money, virement) et le superviseur cliquait « Marquer payée ». Cette table trace chaque
-- tentative de paiement PayDunya d'une facture SaaS : le superviseur génère un lien de paiement
-- (checkout PayDunya hébergé, avec les clés PayDunya de l'organisation ÉMETTRICE — Massla), la ferme
-- paie par Wave/Orange Money/carte, puis l'IPN confirme et marque la facture payée automatiquement.
--
-- 100% additif : une nouvelle table, aucune colonne existante touchée. Sans effet tant que le nouveau
-- code n'est pas déployé, et la table reste vide tant qu'aucun lien de paiement n'est généré.
--
-- Plusieurs lignes possibles par facture (un lien régénéré, un second essai) : chaque token reste
-- résolvable par l'IPN, sinon un paiement réel fait avec un ancien lien ne serait jamais enregistré.
-- Un second paiement complété sur une facture déjà payée est marqué DOUBLON (à rembourser à la main),
-- jamais crédité deux fois.
--
-- RLS : mêmes règles que factures_saas — accessible UNIQUEMENT via l'échappatoire
-- is_plateforme_admin() ; une ferme ne voit jamais ces lignes, ni les siennes.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS paiements_saas (
    id SERIAL PRIMARY KEY,
    facture_saas_id INT NOT NULL REFERENCES factures_saas(id),
    tenant_id INT NOT NULL REFERENCES organisations(id),
    emetteur_tenant_id INT NOT NULL REFERENCES organisations(id),
    montant INT NOT NULL,
    token VARCHAR(255) NOT NULL UNIQUE,
    reference_interne VARCHAR(100) NOT NULL,
    url_paiement TEXT NOT NULL,
    statut VARCHAR(20) NOT NULL DEFAULT 'EN_ATTENTE' CHECK (statut IN ('EN_ATTENTE', 'VALIDE', 'ECHOUE', 'DOUBLON')),
    date_paiement TIMESTAMP,
    cree_par INT REFERENCES utilisateurs(id),
    cree_le TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_paiements_saas_facture ON paiements_saas (facture_saas_id);

ALTER TABLE paiements_saas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plateforme_seulement ON paiements_saas;
CREATE POLICY plateforme_seulement ON paiements_saas
    USING (is_plateforme_admin())
    WITH CHECK (is_plateforme_admin());

INSERT INTO schema_migrations (nom) VALUES ('migration-27-paiements-saas.sql')
ON CONFLICT (nom) DO NOTHING;
