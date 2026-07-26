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
 * Optimise l'ordre de passage d'une tournée par heuristique du plus proche voisin, en partant
 * du dépôt de la ferme. Simple mais efficace pour de petites tournées (quelques dizaines d'arrêts) —
 * un TSP exact serait disproportionné ici.
 */
function optimiserTournee(stops, depot = FARM_DEPOT) {
    const restants = stops.map((s, i) => ({ ...s, _idx: i }));
    const route = [];
    let position = depot;

    while (restants.length > 0) {
        let meilleurIdx = 0;
        let meilleureDistance = Infinity;
        restants.forEach((s, i) => {
            const d = haversineKm(position.lat, position.lng, Number(s.gps_lat), Number(s.gps_lng));
            if (d < meilleureDistance) {
                meilleureDistance = d;
                meilleurIdx = i;
            }
        });
        const prochain = restants.splice(meilleurIdx, 1)[0];
        route.push({ ...prochain, distance_depuis_precedent_km: Number(meilleureDistance.toFixed(2)) });
        position = { lat: Number(prochain.gps_lat), lng: Number(prochain.gps_lng) };
    }

    return route.map((s, i) => {
        const { _idx, ...rest } = s;
        return { ...rest, ordre: i + 1 };
    });
}

module.exports = { FARM_DEPOT, haversineKm, optimiserTournee };
