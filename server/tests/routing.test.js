const { FARM_DEPOT, haversineKm, optimiserTournee, itineraireReel } = require('../src/routing');

function stop(id, lat, lng) {
    return { livraison_id: id, gps_lat: lat, gps_lng: lng };
}

describe('routing — optimiserTournee', () => {
    const ancienneCle = process.env.ORS_API_KEY;
    const fetchOriginal = global.fetch;

    afterEach(() => {
        process.env.ORS_API_KEY = ancienneCle;
        global.fetch = fetchOriginal;
        jest.restoreAllMocks();
    });

    test("sans clé ORS configurée, se replie sur la distance à vol d'oiseau", async () => {
        delete process.env.ORS_API_KEY;
        const proche = stop(1, FARM_DEPOT.lat + 0.01, FARM_DEPOT.lng);
        const loin = stop(2, FARM_DEPOT.lat + 0.5, FARM_DEPOT.lng);

        const route = await optimiserTournee([loin, proche]);

        expect(route[0].livraison_id).toBe(1); // le plus proche passe en premier
        expect(route[0].duree_depuis_precedent_min).toBeNull();
        expect(route[0].distance_depuis_precedent_km).toBeCloseTo(haversineKm(FARM_DEPOT.lat, FARM_DEPOT.lng, proche.gps_lat, proche.gps_lng), 1);
    });

    test('avec une clé ORS et une matrice réelle, utilise la distance/durée routière (pas à vol d\'oiseau)', async () => {
        process.env.ORS_API_KEY = 'fausse-cle-test';
        const a = stop(1, FARM_DEPOT.lat + 0.01, FARM_DEPOT.lng);
        const b = stop(2, FARM_DEPOT.lat + 0.02, FARM_DEPOT.lng);

        // Matrice 3x3 (dépôt, a, b) : ORS indique que "b" est en réalité plus proche en distance
        // routière que "a", alors qu'"a" est plus proche à vol d'oiseau — vérifie qu'on suit bien
        // la matrice réelle plutôt que haversine.
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                distances: [
                    [0, 5000, 1000],
                    [5000, 0, 4000],
                    [1000, 4000, 0],
                ],
                durations: [
                    [0, 600, 120],
                    [600, 0, 480],
                    [120, 480, 0],
                ],
            }),
        });

        const route = await optimiserTournee([a, b]);

        expect(global.fetch).toHaveBeenCalledWith(
            'https://api.openrouteservice.org/v2/matrix/driving-car',
            expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'fausse-cle-test' }) })
        );
        expect(route[0].livraison_id).toBe(2); // "b" est premier malgré une distance à vol d'oiseau plus grande
        expect(route[0].distance_depuis_precedent_km).toBe(1);
        expect(route[0].duree_depuis_precedent_min).toBe(2);
    });

    test("un échec de l'API ORS (réseau ou quota) se replie sur la distance à vol d'oiseau sans planter", async () => {
        process.env.ORS_API_KEY = 'fausse-cle-test';
        global.fetch = jest.fn().mockRejectedValue(new Error('réseau indisponible'));
        const proche = stop(1, FARM_DEPOT.lat + 0.01, FARM_DEPOT.lng);

        const route = await optimiserTournee([proche]);

        expect(route[0].livraison_id).toBe(1);
        expect(route[0].duree_depuis_precedent_min).toBeNull();
        expect(route[0].distance_depuis_precedent_km).toBeCloseTo(haversineKm(FARM_DEPOT.lat, FARM_DEPOT.lng, proche.gps_lat, proche.gps_lng), 1);
    });

    test('une tournée vide renvoie un tableau vide sans appeler ORS', async () => {
        process.env.ORS_API_KEY = 'fausse-cle-test';
        global.fetch = jest.fn();

        const route = await optimiserTournee([]);

        expect(route).toEqual([]);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('routing — itineraireReel', () => {
    const ancienneCle = process.env.ORS_API_KEY;
    const fetchOriginal = global.fetch;

    afterEach(() => {
        process.env.ORS_API_KEY = ancienneCle;
        global.fetch = fetchOriginal;
        jest.restoreAllMocks();
    });

    test('sans clé ORS configurée, renvoie null', async () => {
        delete process.env.ORS_API_KEY;
        const trace = await itineraireReel([FARM_DEPOT, { lat: 14.7, lng: -17.4 }]);
        expect(trace).toBeNull();
    });

    test("avec moins de 2 points, renvoie null sans appeler l'API", async () => {
        process.env.ORS_API_KEY = 'fausse-cle-test';
        global.fetch = jest.fn();
        const trace = await itineraireReel([FARM_DEPOT]);
        expect(trace).toBeNull();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('convertit correctement les coordonnées GeoJSON [lng,lat] en [lat,lng] pour Leaflet', async () => {
        process.env.ORS_API_KEY = 'fausse-cle-test';
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                features: [{ geometry: { coordinates: [[-17.1875, 14.7247], [-17.4, 14.7]] } }],
            }),
        });

        const trace = await itineraireReel([FARM_DEPOT, { lat: 14.7, lng: -17.4 }]);

        expect(global.fetch).toHaveBeenCalledWith(
            'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({ coordinates: [[-17.1875, 14.7247], [-17.4, 14.7]] }),
            })
        );
        expect(trace).toEqual([[14.7247, -17.1875], [14.7, -17.4]]);
    });

    test("un échec de l'API renvoie une erreur exploitable par l'appelant (pas de plantage silencieux)", async () => {
        process.env.ORS_API_KEY = 'fausse-cle-test';
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 });

        await expect(itineraireReel([FARM_DEPOT, { lat: 14.7, lng: -17.4 }])).rejects.toThrow('429');
    });
});
