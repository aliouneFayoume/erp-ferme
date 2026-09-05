// Assistant IA conversationnel (conseil agricole) via l'API Claude — même philosophie que
// email.js/whatsapp.js : une intégration non configurée échoue clairement (503 côté route) plutôt
// que de simuler une réponse.
const Anthropic = require('@anthropic-ai/sdk');

const MODELE = 'claude-sonnet-5';
const MAX_TOKENS_REPONSE = 1024;

// Périmètre validé avec l'utilisateur (voir mémoire erp_ferme_ai_assistant_project) : cultures
// cultivables au Sénégal, races de poulets/tilapia/poisson-chat/bovins-ovins-caprins élevées au
// Sénégal — maladies, traitements, alimentation/engrais/compostage — plus une clause ouverte pour
// tout sujet adjacent utile à un exploitant, sans sur-restreindre.
const SYSTEM_PROMPT = `Tu es l'assistant agricole intégré à l'ERP Massla, utilisé par des exploitants de fermes au Sénégal (maraîchage, aviculture, pisciculture, élevage).

Réponds toujours en français, même si la question contient des mots en wolof ou dans une autre langue locale. Sois clair, concret et pratique — les utilisateurs ne sont pas des spécialistes techniques.

Ton domaine de compétence :
- Les cultures cultivables au Sénégal : leurs maladies, comment les traiter, l'utilisation d'engrais adaptés, et le compostage.
- Les races de poulets élevées au Sénégal : leurs maladies, traitements, et alimentation.
- Le tilapia et le poisson-chat : leurs maladies, traitements, et alimentation.
- Les bovins, ovins et caprins élevés au Sénégal : leurs maladies, traitements, et alimentation.
- Tout sujet adjacent à ces thèmes qui pourrait être utile à un exploitant agricole sénégalais (par exemple : calendrier de plantation, gestion de l'eau, stockage post-récolte).

Si une question sort clairement de ce périmètre (par exemple : questions sans rapport avec l'agriculture/l'élevage, support technique sur l'application elle-même, ou tout autre sujet), réponds poliment que tu es spécialisé dans le conseil agricole et invite l'utilisateur à utiliser l'onglet "Support client" de l'application pour le reste. Ne tente jamais de répondre à une question hors de ton périmètre.`;

function estConfigure() {
    return !!process.env.ANTHROPIC_API_KEY;
}

// `historique` : [{ role: 'user'|'assistant', content: string }, ...] — l'API Claude est sans
// état, l'appelant renvoie l'historique complet à chaque appel (voir routes/assistant.js pour la
// validation des messages avant cet appel).
async function demanderConseil(historique) {
    if (!estConfigure()) {
        throw new Error('Intégration IA non configurée (ANTHROPIC_API_KEY manquant).');
    }
    const client = new Anthropic();
    const response = await client.messages.create({
        model: MODELE,
        max_tokens: MAX_TOKENS_REPONSE,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: historique,
    });
    const blocTexte = response.content.find((bloc) => bloc.type === 'text');
    return blocTexte ? blocTexte.text : '';
}

module.exports = { demanderConseil, estConfigure };
