-- ==============================================================================
-- MIGRATION 44 — Une seule facture « PASSAGE_PRO » ouverte par ferme
-- ==============================================================================
-- Constat d'audit : POST /api/abonnement/passer-pro lit les factures ouvertes puis en insère une, sans verrou. Deux clics
-- simultanés (ou un double envoi) pouvaient donc créer DEUX factures « Passage en Pro » ouvertes pour la même ferme, chacune avec
-- son propre lien de paiement. Le serveur reprend maintenant la facture ouverte en cas de course (erreur 23505) ; cet index
-- unique partiel en est le garde-fou en base.
--
-- « Ouverte » = statut A_PAYER ou EN_RETARD (les statuts payables, voir paiementsSaas.js). Une facture PAYEE ou ANNULEE ne compte
-- pas : une ferme peut repasser une demande plus tard.
--
-- Index partiel : volontairement ABSENT de schema.sql (pg-mem ne le supporte pas) ; il n'existe qu'en base réelle.
--
-- Étape 1 (données existantes) : si des doublons ouverts existent déjà, l'index échouerait à la création. On garde la PLUS ANCIENNE
-- facture ouverte par ferme (c'est celle dont le lien a le plus de chances d'avoir déjà été communiqué) et on annule les autres
-- (ANNULEE, jamais supprimées : traçabilité). Sans doublon, cette étape ne touche aucune ligne.
-- Étape 2 : création de l'index, seulement s'il n'existe pas (rejouable).
-- ==============================================================================

UPDATE factures_saas f
SET statut = 'ANNULEE'
WHERE f.notes = 'PASSAGE_PRO'
  AND f.statut IN ('A_PAYER', 'EN_RETARD')
  AND f.id <> (
      SELECT MIN(g.id) FROM factures_saas g
      WHERE g.tenant_id = f.tenant_id AND g.notes = 'PASSAGE_PRO' AND g.statut IN ('A_PAYER', 'EN_RETARD')
  );

CREATE UNIQUE INDEX IF NOT EXISTS uniq_facture_passage_pro_ouverte
    ON factures_saas (tenant_id)
    WHERE notes = 'PASSAGE_PRO' AND statut IN ('A_PAYER', 'EN_RETARD');

INSERT INTO schema_migrations (nom) VALUES ('migration-44-unique-facture-passage-pro.sql')
ON CONFLICT (nom) DO NOTHING;

-- Vérification (doit renvoyer 1 ligne : l'index existe) puis 0 ligne (aucun doublon ouvert) :
-- SELECT indexname FROM pg_indexes WHERE tablename = 'factures_saas' AND indexname = 'uniq_facture_passage_pro_ouverte';
-- SELECT tenant_id, COUNT(*) FROM factures_saas WHERE notes = 'PASSAGE_PRO' AND statut IN ('A_PAYER', 'EN_RETARD') GROUP BY tenant_id HAVING COUNT(*) > 1;
