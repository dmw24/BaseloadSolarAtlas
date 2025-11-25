
import { readParquet } from './parquet_wasm.js';

// Initialize WASM
let wasmReady = false;

async function initWasm() {
    if (wasmReady) return;
    // parquet-wasm needs to load the .wasm file. 
    // The CDN ESM build handles this usually, but sometimes needs explicit init.
    // For 0.6.1 ESM, we might need to import the default export and call it.
    // Let's try the simplest path first.
    console.log("Initializing Parquet-Wasm...");
    // Dynamic import to ensure it loads
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
        console.log("Wasm 0.7.1 loaded locally.");

        // Read parquet to Arrow Table
        const wasmTable = wasm.readParquet(new Uint8Array(buffer));
        const table = wasmTable.intoIPCStream();
        console.log("Read Parquet result:", table);
        console.log("Result type:", typeof table);
        if (table) {
            console.log("Result constructor:", table.constructor.name);
            console.log("Result byteLength:", table.byteLength);
        }

        const { tableFromIPC } = await import('./apache-arrow.js');

        const arrowTable = tableFromIPC(table);
        console.log("Arrow Table created.");

        const data = [];
        for (const row of arrowTable) {
            data.push(row.toJSON());
        }
        console.log("Data parsed. Rows:", data.length);
        return data;
    } catch (e) {
        console.error("Error in loadSummary:", e);
        throw e;
    }
}

export async function loadPopulationCsv() {
    const response = await fetch('data/voronoi_population_2020.csv');
    if (!response.ok) {
        throw new Error('Population CSV not found at data/voronoi_population_2020.csv');
    }
    const text = await response.text();
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
        return {
            latitude: Number(row.latitude),
            longitude: Number(row.longitude),
            population_2020: Number(row.population_2020)
        };
    });
}

export async function loadVoronoiGeojson() {
    const response = await fetch('data/voronoi_cells.geojson');
    if (!response.ok) {
        throw new Error('Voronoi GeoJSON not found at data/voronoi_cells.geojson');
    }
    return response.json();
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
    // await wasm.default(); 

    const { tableFromIPC } = await import('./apache-arrow.js');

    const wasmTable = wasm.readParquet(new Uint8Array(buffer));
    const table = wasmTable.intoIPCStream();
    const arrowTable = tableFromIPC(table);

    // Convert to array of objects
    // Each row is: { location_id, season, timestamps, solar_gen, ... }
    // Note: timestamps/solar_gen are Lists (Vectors). Arrow handles this.
    const data = [];
    for (const row of arrowTable) {
        data.push(row.toJSON());
    }

    return data;
}
