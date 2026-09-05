window.Views = window.Views || {};

// Historique conservé en mémoire de module (pas container.dataset) — éphémère par choix explicite
// (voir mémoire erp_ferme_ai_assistant_project) : vit tant que la page n'est pas rechargée, perdu
// ensuite. Pas de nouvelle table côté serveur.
let historiqueAssistant = [];
let assistantEnAttente = false;

function bulleAssistant(message) {
  const estUtilisateur = message.role === 'user';
  return `
    <div style="display:flex; ${estUtilisateur ? 'justify-content:flex-end' : 'justify-content:flex-start'}; margin-bottom:10px;">
      <div style="max-width:75%; padding:10px 14px; border-radius:10px; white-space:pre-wrap;
                  background:${estUtilisateur ? 'var(--text)' : 'var(--bg)'};
                  color:${estUtilisateur ? 'var(--card)' : 'var(--text)'};
                  border:${estUtilisateur ? 'none' : '1px solid var(--border)'};">
        ${esc(message.content)}
      </div>
    </div>`;
}

window.Views.assistant = {
  async render(container) {
    container.innerHTML = `
      <div class="panel">
        <h2>Assistant IA</h2>
        <p class="sub" style="margin-top:-4px;">
          Posez vos questions sur les cultures, l'aviculture, la pisciculture ou l'élevage au Sénégal
          (maladies, traitements, alimentation, engrais, compostage...).
        </p>
        <div id="assistant-messages" style="margin-top:16px; max-height:50vh; overflow-y:auto; padding-right:4px;">
          ${
            historiqueAssistant.length
              ? historiqueAssistant.map(bulleAssistant).join('')
              : '<p class="empty">Posez votre première question ci-dessous.</p>'
          }
        </div>
        <form id="form-assistant" class="panel-row" style="align-items:end; margin-top:16px;" autocomplete="off">
          <label style="flex:1;">Votre question
            <textarea name="question" rows="2" required maxlength="2000" ${assistantEnAttente ? 'disabled' : ''}></textarea>
          </label>
          <button type="submit" id="btn-envoyer-assistant" ${assistantEnAttente ? 'disabled' : ''}>${assistantEnAttente ? '...' : 'Envoyer'}</button>
        </form>
      </div>
    `;

    const zoneMessages = container.querySelector('#assistant-messages');
    zoneMessages.scrollTop = zoneMessages.scrollHeight;

    container.querySelector('#form-assistant').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (assistantEnAttente) return;
      const fd = new FormData(e.target);
      const question = fd.get('question').trim();
      if (!question) return;

      historiqueAssistant.push({ role: 'user', content: question });
      assistantEnAttente = true;
      window.Views.assistant.render(container);

      try {
        const { reponse } = await Api.post('/assistant/chat', { messages: historiqueAssistant });
        historiqueAssistant.push({ role: 'assistant', content: reponse });
      } catch (err) {
        historiqueAssistant.pop(); // retire la question envoyée : l'utilisateur peut la retaper
        showToast(err.message, 'error');
      }
      assistantEnAttente = false;
      window.Views.assistant.render(container);
    });
  },
};
