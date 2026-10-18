-- ==============================================================================
-- MIGRATION 39 — Demandes « Passer en Pro » : enregistrées dans la même liste que les demandes de contact
-- ==============================================================================
-- Un clic sur « Passer en Pro » (ou « Parler à un conseiller ») dans l'application laissait jusqu'ici UNIQUEMENT un message
-- WhatsApp éventuel : aucune trace si la personne n'envoyait rien. La demande est désormais enregistrée dans demandes_contact
-- (migration-38, source = 'pro') et apparaît dans Support plateforme avec les demandes « essai » et « démo ».
--
-- Une demande « pro » vient d'une ferme connectée, pas d'un visiteur : on garde le lien avec la ferme (tenant_id) et l'e-mail comme
-- le numéro WhatsApp deviennent facultatifs (un compte d'essai n'a pas d'e-mail ; un ancien compte peut ne pas avoir de numéro).
--
-- 100% additif et rejouable : aucune ligne existante modifiée, aucune policy à changer (celles de la migration-38 suffisent).
-- ==============================================================================

ALTER TABLE demandes_contact ALTER COLUMN email DROP NOT NULL;
ALTER TABLE demandes_contact ALTER COLUMN whatsapp DROP NOT NULL;
ALTER TABLE demandes_contact ADD COLUMN IF NOT EXISTS tenant_id INT REFERENCES organisations(id);

CREATE INDEX IF NOT EXISTS idx_demandes_contact_tenant ON demandes_contact (tenant_id);

INSERT INTO schema_migrations (nom) VALUES ('migration-39-demandes-pro.sql')
ON CONFLICT (nom) DO NOTHING;
