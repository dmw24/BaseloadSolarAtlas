import { readParquet } from './parquet_wasm.js';

// Initialize WASM
let wasmReady = false;

async function initWasm() {
    if (wasmReady) return;
    console.log("Initializing Parquet-Wasm...");
    const wasm = await import('./parquet_wasm.js');
    await wasm.default();
    wasmReady = true;
    console.log("Parquet-Wasm initialized.");
}

export async function loadSummary() {
    await initWasm();

    const response = await fetch('data/simulation_results_summary.parquet');
    const buffer = await response.arrayBuffer();
    try {
        const wasm = await import('./parquet_wasm.js');
        await wasm.default();
        const wasmTable = wasm.readParquet(new Uint8Array(buffer));
        const table = wasmTable.intoIPCStream();
        const { tableFromIPC } = await import('./apache-arrow.js');
        const arrowTable = tableFromIPC(table);
        const data = [];
        for (const row of arrowTable) {
            data.push(row.toJSON());
        }
        return data;
    } catch (e) {
        console.error("Error in loadSummary:", e);
        throw e;
    }
}

function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    const header = lines.shift();
    if (!header) return [];
    const cols = header.split(',');
    return lines.map(line => {
        const parts = line.split(',');
        const row = {};
        cols.forEach((c, idx) => {
            row[c] = parts[idx];
        });
        return row;
    });
}

export async function loadPopulationCsv() {
    const response = await fetch('data/voronoi_population_2020.csv');
    if (!response.ok) {
        throw new Error('Population CSV not found at data/voronoi_population_2020.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        population_2020: Number(row.population_2020)
    }));
}

export async function loadGemPlantsCsv() {
    const response = await fetch('data/gem_plants.csv');
    if (!response.ok) {
        throw new Error('GEM plants CSV not found at data/gem_plants.csv');
    }
    const rows = parseCsv(await response.text());
    return rows
        .map(row => ({
            plant_name: row.plant_name || '',
            country: row.country || '',
            fuel_group: (row.fuel_group || '').toLowerCase(),
            capacity_mw: Number(row.capacity_mw),
            latitude: Number(row.latitude),
            longitude: Number(row.longitude),
            status: (row.status || 'existing').toLowerCase()
        }))
        .filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
}

export async function loadVoronoiGemCapacityCsv() {
    const response = await fetch('data/voronoi_gem_capacity.csv');
    if (!response.ok) {
        throw new Error('Voronoi fossil capacity CSV not found at data/voronoi_gem_capacity.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        coal_Announced: Number(row.coal_Announced) || 0,
        coal_Existing: Number(row.coal_Existing) || 0,
        oil_gas_Announced: Number(row.oil_gas_Announced) || 0,
        oil_gas_Existing: Number(row.oil_gas_Existing) || 0,
        bioenergy_Announced: Number(row.bioenergy_Announced) || 0,
        bioenergy_Existing: Number(row.bioenergy_Existing) || 0,
        nuclear_Announced: Number(row.nuclear_Announced) || 0,
        nuclear_Existing: Number(row.nuclear_Existing) || 0
    }));
}

export async function loadSample(solarGw, battGwh) {
    await initWasm();

    const filename = `samples_s${solarGw}_b${battGwh}.parquet`;
    const response = await fetch(`data/samples/${filename}`);

    if (!response.ok) {
        throw new Error(`Sample file not found: ${filename}`);
    }

    const buffer = await response.arrayBuffer();
    const wasm = await import('./parquet_wasm.js');
    const { tableFromIPC } = await import('./apache-arrow.js');

    const wasmTable = wasm.readParquet(new Uint8Array(buffer));
    const table = wasmTable.intoIPCStream();
    const arrowTable = tableFromIPC(table);

    const data = [];
    for (const row of arrowTable) {
        data.push(row.toJSON());
    }

    return data;
}
