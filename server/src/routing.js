// Ferme Massla — dépôt de départ des tournées (zone Diamniadio, cahier des charges §1).
const FARM_DEPOT = { lat: 14.7247, lng: -17.1875 };

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Interroge l'API Matrix d'OpenRouteService pour obtenir en un seul appel les distances/durées
 * routières réelles entre le dépôt et chaque arrêt (plutôt que la distance à vol d'oiseau).
 * Attention à l'ordre des coordonnées : ORS attend [longitude, latitude], à l'inverse de la
 * convention {lat, lng} utilisée partout ailleurs dans ce module.
 *
 * Renvoie `null` si aucune clé n'est configurée (ORS_API_KEY absente) — l'appelant se replie
 * alors sur le calcul à vol d'oiseau plutôt que d'échouer.
 */
async function matriceReelle(depot, points) {
    const apiKey = process.env.ORS_API_KEY;
    if (!apiKey) return null;

    const locations = [[depot.lng, depot.lat], ...points.map((p) => [p.lng, p.lat])];
    const res = await fetch('https://api.openrouteservice.org/v2/matrix/driving-car', {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ locations, metrics: ['distance', 'duration'] }),
    });
    if (!res.ok) {
        throw new Error(`OpenRouteService a répondu ${res.status}`);
    }
    const data = await res.json();
    return { distances: data.distances, durations: data.durations };
}

/**
 * Optimise l'ordre de passage d'une tournée par heuristique du plus proche voisin, en partant
 * du dépôt de la ferme. Simple mais efficace pour de petites tournées (quelques dizaines d'arrêts) —
 * un TSP exact serait disproportionné ici.
 *
 * Utilise les distances/durées routières réelles (OpenRouteService) quand disponibles ; se replie
 * automatiquement sur le calcul à vol d'oiseau si l'API est indisponible, en quota dépassé, ou non
 * configurée — l'affichage d'une tournée ne doit jamais dépendre entièrement d'un service externe.
 */
async function optimiserTournee(stops, depot = FARM_DEPOT) {
    let matrice = null;
    if (stops.length > 0) {
        try {
            matrice = await matriceReelle(
                depot,
                stops.map((s) => ({ lat: Number(s.gps_lat), lng: Number(s.gps_lng) }))
            );
        } catch (err) {
            console.error("OpenRouteService indisponible, repli sur le calcul à vol d'oiseau :", err.message);
        }
    }

    const restants = stops.map((s, i) => ({ ...s, _idx: i }));
    const route = [];
    let position = depot;
    let positionMatriceIdx = 0; // index 0 = dépôt dans la matrice ; un arrêt d'indice original i est à i+1

    while (restants.length > 0) {
        let meilleurI = 0;
        let meilleureDistanceKm = Infinity;
        let meilleureDureeMin = null;

        restants.forEach((s, i) => {
            const destIdx = s._idx + 1;
            const distanceReelleM = matrice?.distances?.[positionMatriceIdx]?.[destIdx];
            const dureeReelleS = matrice?.durations?.[positionMatriceIdx]?.[destIdx];

            const distanceKm =
                distanceReelleM != null ? distanceReelleM / 1000 : haversineKm(position.lat, position.lng, Number(s.gps_lat), Number(s.gps_lng));
            const dureeMin = dureeReelleS != null ? dureeReelleS / 60 : null;

            if (distanceKm < meilleureDistanceKm) {
                meilleureDistanceKm = distanceKm;
                meilleureDureeMin = dureeMin;
                meilleurI = i;
            }
        });

        const prochain = restants.splice(meilleurI, 1)[0];
        route.push({
            ...prochain,
            distance_depuis_precedent_km: Number(meilleureDistanceKm.toFixed(2)),
            duree_depuis_precedent_min: meilleureDureeMin !== null ? Number(meilleureDureeMin.toFixed(1)) : null,
        });
        position = { lat: Number(prochain.gps_lat), lng: Number(prochain.gps_lng) };
        positionMatriceIdx = prochain._idx + 1;
    }

    return route.map((s, i) => {
        const { _idx, ...rest } = s;
        return { ...rest, ordre: i + 1 };
    });
}

/**
 * Récupère le tracé routier réel (géométrie GeoJSON) suivant l'ordre optimisé des arrêts, pour
 * affichage sur la carte — distinct de matriceReelle() qui ne renvoie que des distances/durées,
 * pas un tracé. `points` doit déjà être dans l'ordre de passage (dépôt en premier).
 *
 * Renvoie `null` si aucune clé n'est configurée, s'il y a moins de 2 points, ou si l'appel échoue —
 * l'appelant se replie alors sur un tracé en ligne droite plutôt que d'échouer l'affichage.
 */
async function itineraireReel(points) {
    const apiKey = process.env.ORS_API_KEY;
    if (!apiKey || points.length < 2) return null;

    const coordinates = points.map((p) => [p.lng, p.lat]);
    const res = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
        method: 'POST',
        headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ coordinates }),
    });
    if (!res.ok) {
        throw new Error(`OpenRouteService (directions) a répondu ${res.status}`);
    }
    const data = await res.json();
    const coords = data.features?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coords)) return null;
    return coords.map(([lng, lat]) => [lat, lng]); // reconverti en [lat, lng] pour Leaflet
}

module.exports = { FARM_DEPOT, haversineKm, optimiserTournee, itineraireReel };
