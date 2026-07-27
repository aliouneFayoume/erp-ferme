const PDFDocument = require('pdfkit');

const STATUT_LABELS = {
    A_PAYER: 'À payer',
    PAYEE_PARTIEL: 'Payée partiellement',
    PAYEE: 'Payée',
    EN_RETARD: 'En retard',
};

function formatDate(valeur) {
    const d = new Date(valeur);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

// Formatage manuel plutôt que toLocaleString('fr-FR') : cette dernière insère une espace fine
// insécable (U+202F) entre les milliers, un caractère absent de l'encodage WinAnsi des polices
// standard de pdfkit (Helvetica) — il s'affichait comme un "/" parasite dans le PDF généré.
function formatMontant(n) {
    const entier = Math.round(Number(n));
    const avecEspaces = entier.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${avecEspaces} FCFA`;
}

/**
 * Génère le PDF d'une facture et l'écrit directement sur la réponse HTTP (Content-Type déjà posé
 * par l'appelant). pdfkit ne fournit pas de widget "tableau" : les colonnes des lignes de commande
 * sont dessinées à des positions x fixes.
 */
function genererFacturePDF(res, { facture, commande, client, lignes }) {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    doc.fontSize(20).text('FERME MASSLA', { align: 'left' });
    doc.fontSize(10).fillColor('#666666').text('Avicole · Piscicole · Maraîcher').text('massla.sn');
    doc.moveDown(1.5);

    doc.fillColor('#000000').fontSize(16).text('FACTURE', { align: 'right' });
    doc.fontSize(10).fillColor('#333333');
    doc.text(`Référence : ${commande.numero_commande}`, { align: 'right' });
    doc.text(`Date d'émission : ${formatDate(new Date())}`, { align: 'right' });
    doc.text(`Date d'échéance : ${formatDate(facture.date_echeance)}`, { align: 'right' });
    doc.moveDown(1.5);

    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#dddddd').stroke();
    doc.moveDown(1);

    doc.fillColor('#000000').fontSize(11).text('Client', { underline: true });
    doc.fontSize(10).fillColor('#333333');
    doc.text(client.nom);
    doc.text(`${client.type_client === 'B2B' ? 'Professionnel' : 'Particulier'} — ${client.categorie_tarifaire || 'standard'}`);
    doc.text(`Téléphone : ${client.telephone}`);
    if (client.adresse) doc.text(`Adresse : ${client.adresse}`);
    doc.moveDown(1.5);

    const colX = { produit: 50, quantite: 300, prixUnitaire: 380, sousTotal: 470 };
    const ligneY = () => doc.y;

    doc.fillColor('#000000').fontSize(10).font('Helvetica-Bold');
    doc.text('Produit', colX.produit, ligneY(), { continued: false });
    doc.text('Qté', colX.quantite, doc.y - doc.currentLineHeight());
    doc.text('Prix unitaire', colX.prixUnitaire, doc.y - doc.currentLineHeight());
    doc.text('Sous-total', colX.sousTotal, doc.y - doc.currentLineHeight());
    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#000000').stroke();
    doc.moveDown(0.5);

    doc.font('Helvetica').fillColor('#333333');
    for (const l of lignes) {
        const y = doc.y;
        doc.text(l.produit_nom, colX.produit, y, { width: 240 });
        doc.text(String(l.quantite), colX.quantite, y);
        doc.text(formatMontant(l.prix_unitaire_applique), colX.prixUnitaire, y);
        doc.text(formatMontant(l.sous_total), colX.sousTotal, y);
        doc.moveDown(0.6);
    }

    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#dddddd').stroke();
    doc.moveDown(1);

    // x/width explicites : sans ça, ces lignes héritent de la position x laissée par la dernière
    // colonne du tableau ci-dessus, ce qui les coince dans une colonne étroite et les fait retourner
    // à la ligne au milieu des mots.
    const pleineLargeur = { x: 50, width: 495, align: 'right' };
    doc.font('Helvetica-Bold').fontSize(11);
    doc.text(`Montant total : ${formatMontant(commande.montant_total)}`, pleineLargeur.x, doc.y, pleineLargeur);
    doc.text(`Montant restant dû : ${formatMontant(facture.montant_restant)}`, pleineLargeur.x, doc.y, pleineLargeur);
    doc.text(`Statut : ${STATUT_LABELS[facture.statut] || facture.statut}`, pleineLargeur.x, doc.y, pleineLargeur);

    doc.moveDown(3);
    doc.font('Helvetica').fontSize(8).fillColor('#999999');
    doc.text(`Facture générée automatiquement par l'ERP Ferme Massla le ${formatDate(new Date())}.`, 50, doc.y, { width: 495, align: 'center' });

    doc.end();
}

module.exports = { genererFacturePDF };
