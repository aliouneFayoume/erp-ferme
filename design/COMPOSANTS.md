# Composants UI Massla

Classes CSS dans `massla-composants.css`. Charger d'abord `../02_Couleurs/massla-tokens.css` (variables) puis ce fichier.

## Bouton

Déclenche une action ; un seul bouton principal par écran.

## Variantes
- **Principal** `ms-btn ms-btn--primary` : fond `sahel-900`, texte `on-brand`. L'action principale de l'écran.
- **Accent** `ms-btn--accent` : fond `dakar-500`, texte `on-accent`. Sur fond foncé, ou pour une action à mettre en avant (Réapprovisionner). Jamais plus d'un par écran.
- **Secondaire** `ms-btn--secondary` : contour `border-strong` (3,8:1). Action alternative.
- **Texte** `ms-btn--text` : lien d'action en `dakar-700`, souligné.
- `ms-btn--block` : pleine largeur, pour le bas d'écran sur téléphone.

## Règles
- Hauteur `button-h` (54 px), rayon `radius-lg`, libellé en 16 px / 700.
- Libellé = verbe à l'infinitif + objet : « Ajouter un produit », pas « OK ».
- Toujours un vrai `<button>` (ou `<a>` pour une navigation). Focus visible avec `focus`.
- Pendant un envoi : désactiver et changer le libellé (« Envoi… »).


## Champ de saisie

Saisie d'une donnée unique, toujours avec un libellé visible au-dessus.

## Structure
`ms-field` > `ms-label` + `ms-input` + `ms-help`. Erreur : `ms-input--error` sur le champ, `ms-help--error` sur le message, `aria-invalid="true"` et `aria-describedby`.

## Règles
- Hauteur `input-h` (52 px), texte 16 px (évite le zoom automatique sur iOS).
- Contour `border-strong` (contrôle ≥ 3:1), focus `focus`.
- Le texte indicatif montre un exemple de format, il ne remplace jamais le libellé.
- Clavier adapté : `inputmode="tel"` pour un téléphone, `numeric` pour une quantité, `decimal` pour un prix.
- Message d'erreur qui dit quoi faire : « La quantité doit être positive. »


## Badge de statut

Étiquette courte qui indique l'état d'un produit, d'un paiement ou d'une facture.

## Variantes
`ms-badge--success` (Payé, En stock), `--warning` (Stock faible, Échéance proche), `--danger` (Épuisé, Échec — rouge plein, texte blanc), `--info` (Hors ligne, Nouveau). Encre `*-ink` sur fond `*-bg`, tous ≥ 5:1. L'erreur est le seul état en aplat plein : elle doit sauter aux yeux.

## Règles
- Toujours une **icône + un mot** : le statut ne passe jamais par la couleur seule.
- Un ou deux mots maximum, sans ponctuation.
- Rayon `radius-sm`, 13 px / 700.


## Carte KPI

Affiche un indicateur clé : un libellé, une valeur, une évolution.

## Variantes
- `ms-kpi` : carte `surface` avec filet `border`.
- `ms-kpi--brand` : fond `sahel-900`, pour l'indicateur principal de l'écran (un seul).

## Règles
- Valeur en chiffres tabulaires, 28 px / 700, unité plus petite après la valeur.
- L'évolution utilise un badge (+12,5 % en succès ; une baisse en attention, jamais en rouge sauf perte réelle).
- Téléphone : 2 ou 3 cartes par ligne ; ordinateur : 4.
- Toucher une carte ouvre le détail du chiffre.


## Barre d'onglets

Navigation principale de l'application sur téléphone, fixée en bas de l'écran.

## Règles
- 4 onglets (5 maximum) : Accueil, Stock, Ventes, Profil.
- Icône 24 px + libellé toujours visible ; cible ≥ `tap-min`.
- Onglet actif : `aria-current="page"`, couleur `sahel-900`, libellé en 700.
- Hauteur `tabbar-h` plus la zone de sécurité du téléphone.
- Sur tablette, peut devenir un rail latéral ; sur ordinateur, une barre latérale de 240 px.


## Bandeau d'alerte

Message contextuel en haut d'un écran ou d'une carte : ce qui se passe, puis quoi faire.

## Variantes
`ms-alert--warning`, `--info`, `--success`, `--danger`, mêmes jetons que les badges.

## Règles
- Commencer par le fait en gras, puis le détail chiffré.
- Icône + texte, jamais la couleur seule. `role="status"` (ou `role="alert"` pour une erreur bloquante).
- Un seul bandeau visible à la fois par écran.
- L'état hors ligne est permanent tant qu'il dure, et il indique combien d'opérations attendent.


## Couleurs d'état

Les statuts restent dans la famille de la marque : vert Niayes pour le succès, sauge pour l'information, vert Sahel plein pour l'attention. Seule l'erreur est rouge.

Succès et attention se distinguent par leur valeur (fond clair ou fond foncé), leur icône et leur libellé. Un statut ne passe jamais par la couleur seule.

