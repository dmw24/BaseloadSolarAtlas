import { loadSummary, loadPopulationCsv, loadVoronoiGeojson } from './data.js';
import { initMap, updateMap, updateLcoeMap, updatePopulationSimple, updatePopulationGeo } from './map.js';
import { initSampleDays, loadSampleWeekData, cleanupSampleDays } from './samples.js';

// State
let summaryData = [];
let currentSolar = 5;
let currentBatt = 8;
let currentLocationId = null;
let currentViewMode = 'capacity';
let locationIndex = new Map();
let lcoeResults = [];
let populationData = [];
let summaryCoordIndex = new Map();
let populationCoordIndex = new Map();
let voronoiGeojson = null;
const BASE_LOAD_MW = 1000; // assume baseload of 1 GW for CF outputs
const TX_WACC = 0.06;
const TX_LIFE = 50;
const TX_CRF = (() => {
    // capitalRecoveryFactor is hoisted, so safe to call later
    try {
        return capitalRecoveryFactor ? capitalRecoveryFactor(TX_WACC, TX_LIFE) : 0;
    } catch {
        return 0;
    }
})();
let lcoeParams = {
    solarCapex: 600,       // $/kW_DC
    batteryCapex: 120,     // $/kWh
    solarOpexPct: 0.015,   // 1.5% of capex annually
    batteryOpexPct: 0.02,  // 2% of capex annually (as requested)
    solarLife: 30,
    batteryLife: 20,
    wacc: 0.07,
    targetCf: 0.90
};
let lcoeUpdateTimeout = null;
let lcoeReference = null; // Stores the selected location's LCOE result
const DELTA_PERCENTILE = 0.95;
let comparisonMetric = 'lcoe';
let legendLock = false;
let lockedColorInfo = null;
let lastColorInfo = null;
const VIEW_MODE_EXPLANATIONS = {
    capacity: 'Capacity Factor maps the percentage of the year this solar + storage build supplies 1\u00a0GW baseload.',
    samples: 'Sample Days replays a representative 168-hour week so you can review solar output, storage dispatch, and any unmet 1 GW demand.',
    lcoe: 'LCOE compares the levelized $/MWh for every location that meets the target capacity factor.',
    population: 'Population view shows total people per Voronoi cell, with an optional capacity-factor overlay.'
};

// DOM Elements
const solarSlider = document.getElementById('solar-slider');
const battSlider = document.getElementById('batt-slider');
const solarVal = document.getElementById('solar-val');
const battVal = document.getElementById('batt-val');
const loading = document.getElementById('loading');
const loadingStatus = document.getElementById('loading-status');
const viewModeSelect = document.getElementById('view-mode');
const viewModeExplainer = document.getElementById('view-mode-explainer');
const configNote = document.getElementById('config-note');
const statsSection = document.getElementById('stats-section');
const sampleControls = document.getElementById('sample-controls');
const locationPanel = document.getElementById('location-panel');
const systemConfig = document.getElementById('system-config');
const legendCapacity = document.getElementById('legend-capacity');
const legendSamples = document.getElementById('legend-samples');
const legendLcoe = document.getElementById('legend-lcoe');
const legendLcoeTitle = document.getElementById('legend-lcoe-title');
const legendLcoeMin = document.getElementById('legend-lcoe-min');
const legendLcoeMid = document.getElementById('legend-lcoe-mid');
const legendLcoeMax = document.getElementById('legend-lcoe-max');
const legendLcoeRef = document.getElementById('legend-lcoe-ref');
const legendLcoeBar = document.getElementById('legend-lcoe-bar');
const legendTxExplainer = document.getElementById('legend-tx-explainer');
const comparisonToggle = document.getElementById('comparison-toggle');
const comparisonButtons = document.querySelectorAll('#comparison-toggle button');
const clearRefBtn = document.getElementById('lcoe-clear-ref');
const legendLockBtn = document.getElementById('legend-lock-btn');
const lcoeControls = document.getElementById('lcoe-controls');
const targetCfSlider = document.getElementById('target-cf-slider');
const targetCfVal = document.getElementById('target-cf-val');
const solarCapexInput = document.getElementById('solar-capex');
const batteryCapexInput = document.getElementById('battery-capex');
const solarOpexInput = document.getElementById('solar-opex');
const batteryOpexInput = document.getElementById('battery-opex');
const solarLifeInput = document.getElementById('solar-life');
const batteryLifeInput = document.getElementById('battery-life');
const waccInput = document.getElementById('wacc');
const populationOverlaySelect = document.getElementById('population-overlay-mode');
const populationToggleWrapper = document.getElementById('population-toggle');
const populationOverlayConfig = document.getElementById('population-overlay-config');
const populationSolarSlider = document.getElementById('population-solar-slider');
const populationSolarVal = document.getElementById('population-solar-val');
const populationBattSlider = document.getElementById('population-batt-slider');
const populationBattVal = document.getElementById('population-batt-val');
const legendPopulation = document.getElementById('legend-population');
const legendPopMin = document.getElementById('legend-pop-min');
const legendPopMax = document.getElementById('legend-pop-max');

// Helpers
function buildLocationIndex(data) {
    const index = new Map();
    data.forEach(row => {
        const arr = index.get(row.location_id) || [];
        arr.push(row);
        index.set(row.location_id, arr);
    });
    return index;
}

function buildCoordIndex(data) {
    const index = new Map();
    data.forEach(row => {
        if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) return;
        const key = coordKey(row.latitude, row.longitude);
        index.set(key, row);
    });
    return index;
}

function capitalRecoveryFactor(rate, years) {
    if (years <= 0) return 0;
    if (rate === 0) return 1 / years;
    const pow = Math.pow(1 + rate, years);
    return (rate * pow) / (pow - 1);
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => deg * Math.PI / 180;
    const R = 6371; // Earth radius in km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function coordKey(lat, lon) {
    return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

function computeConfigLcoe(row, params) {
    const solarKw = row.solar_gw * 1_000_000;      // GW_DC -> kW
    const batteryKwh = row.batt_gwh * 1_000_000;   // GWh -> kWh

    const solarCapex = params.solarCapex * solarKw;
    const batteryCapex = params.batteryCapex * batteryKwh;

    const solarAnnual = solarCapex * capitalRecoveryFactor(params.wacc, params.solarLife);
    const batteryAnnual = batteryCapex * capitalRecoveryFactor(params.wacc, params.batteryLife);

    const solarOpex = solarCapex * params.solarOpexPct;
    const batteryOpex = batteryCapex * params.batteryOpexPct;

    const annualCost = solarAnnual + batteryAnnual + solarOpex + batteryOpex;
    const annualEnergyMWh = row.annual_cf * 8760 * BASE_LOAD_MW;
    if (annualEnergyMWh === 0) return Infinity;
    return annualCost / annualEnergyMWh;
}

function computeTransmissionMetrics(row, reference, delta) {
    if (!reference || !Number.isFinite(delta)) return null;
    const distanceKm = haversineKm(row.latitude, row.longitude, reference.latitude, reference.longitude);
    const savingsPerMwh = -delta; // positive if row cheaper
    if (!Number.isFinite(distanceKm)) {
        return null;
    }
    if (savingsPerMwh <= 0 || row.annual_cf <= 0) {
        return { distanceKm, savingsPerMwh, breakevenPerGw: 0, breakevenPerGwKm: 0 };
    }
    const annualEnergyMWh = row.annual_cf * 8760 * BASE_LOAD_MW;
    const annualPayment = savingsPerMwh * annualEnergyMWh;
    const breakevenPerGw = TX_CRF > 0 ? annualPayment / TX_CRF : 0;
    const breakevenPerGwKm = distanceKm > 0 ? breakevenPerGw / distanceKm : 0;
    return {
        distanceKm,
        savingsPerMwh,
        breakevenPerGw,
        breakevenPerGwKm
    };
}

function formatNumber(value, decimals = 0) {
    if (!Number.isFinite(value)) return '--';
    return value.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

function formatCurrencyLabel(value, decimals = 0) {
    const num = formatNumber(value, decimals);
    return num === '--' ? '--' : `$${num}`;
}

function computeBestLcoeByLocation(targetCf, params) {
    const results = [];
    locationIndex.forEach(rows => {
        const payloads = [];
        let bestMeeting = null;
        let bestFallback = null;
        let maxSolar = -Infinity;
        let maxBatt = -Infinity;

        rows.forEach(r => {
            const lcoe = computeConfigLcoe(r, params);
            const payload = { ...r, lcoe, targetCf };
            payloads.push(payload);

            if (r.annual_cf >= targetCf) {
                if (!bestMeeting || lcoe < bestMeeting.lcoe) {
                    bestMeeting = payload;
                }
            }

            if (!bestFallback || r.annual_cf > bestFallback.annual_cf) {
                bestFallback = payload;
            }

            if (r.solar_gw > maxSolar || (r.solar_gw === maxSolar && r.batt_gwh > maxBatt)) {
                maxSolar = r.solar_gw;
                maxBatt = r.batt_gwh;
            }
        });

        const highConfig = payloads.find(p => p.solar_gw === maxSolar && p.batt_gwh === maxBatt) ||
            payloads.reduce((best, p) => {
                if (!best) return p;
                if (p.solar_gw > best.solar_gw) return p;
                if (p.solar_gw === best.solar_gw && p.batt_gwh > best.batt_gwh) return p;
                return best;
            }, null);

        const chosen = bestMeeting ? { ...bestMeeting, meetsTarget: true } :
            bestFallback ? { ...bestFallback, meetsTarget: false } : null;

        if (chosen) {
            chosen.maxConfigSolar = highConfig?.solar_gw ?? null;
            chosen.maxConfigBatt = highConfig?.batt_gwh ?? null;
            chosen.maxConfigLcoe = highConfig?.lcoe ?? null;
            results.push(chosen);
        }
    });
    return results;
}

function setLegendGradient(mode) {
    legendLcoeBar.classList.remove('legend-gradient-cost', 'legend-gradient-delta', 'legend-gradient-tx');
    if (mode === 'delta') {
        legendLcoeBar.classList.add('legend-gradient-delta');
    } else if (mode === 'tx') {
        legendLcoeBar.classList.add('legend-gradient-tx');
    } else {
        legendLcoeBar.classList.add('legend-gradient-cost');
    }
}

function setViewModeExplanation(mode) {
    if (!viewModeExplainer) return;
    const message = VIEW_MODE_EXPLANATIONS[mode] || VIEW_MODE_EXPLANATIONS.capacity;
    viewModeExplainer.textContent = message;
}

function updatePopulationOverlayControls(mode) {
    if (!populationOverlayConfig) return;
    const show = mode === 'cf';
    populationOverlayConfig.classList.toggle('hidden', !show);
    if (show) {
        if (populationSolarSlider) populationSolarSlider.value = currentSolar;
        if (populationSolarVal) populationSolarVal.textContent = currentSolar;
        if (populationBattSlider) populationBattSlider.value = currentBatt;
        if (populationBattVal) populationBattVal.textContent = currentBatt;
    }
}

function updatePopulationLegend(popData) {
    if (!legendPopulation || !legendPopMin || !legendPopMax) return;
    if (!popData || popData.length === 0) {
        legendPopulation.classList.add('hidden');
        return;
    }
    const vals = popData.map(p => p.population_2020 || 0).filter(Number.isFinite);
    const max = Math.max(...vals, 0);
    legendPopMin.textContent = '0';
    legendPopMax.textContent = max ? formatNumber(max, 0) : '--';
    legendPopulation.classList.remove('hidden');
}

function setConfigNoteVisibility(show) {
    if (!configNote) return;
    configNote.classList.toggle('hidden', !show);
}

function updateComparisonToggleUI() {
    if (!comparisonButtons || comparisonButtons.length === 0) return;
    comparisonButtons.forEach(btn => {
        const isActive = btn.dataset.mode === comparisonMetric;
        btn.classList.toggle('bg-slate-800', isActive);
        btn.classList.toggle('text-slate-200', isActive);
        btn.classList.toggle('bg-slate-900', !isActive);
        btn.classList.toggle('text-slate-400', !isActive);
    });
}

function updateLegendLockButton() {
    if (!legendLockBtn) return;
    if (!lcoeReference) {
        legendLockBtn.classList.add('hidden');
        legendLock = false;
        lockedColorInfo = null;
        legendLockBtn.textContent = 'Fix legend scales';
    } else {
        legendLockBtn.classList.remove('hidden');
        legendLockBtn.textContent = legendLock ? 'Release legend scales' : 'Fix legend scales';
    }
}

function renderLegendFromInfo(info) {
    if (!info) {
        legendLcoeMin.textContent = '--';
        legendLcoeMid.textContent = '--';
        legendLcoeMax.textContent = '--';
        legendLcoeRef.textContent = 'Reference: --';
        if (legendLcoeTitle) legendLcoeTitle.textContent = 'LCOE ($/MWh)';
        setLegendGradient('cost');
        legendTxExplainer?.classList.add('hidden');
        comparisonToggle.classList.add('hidden');
        clearRefBtn.classList.add('hidden');
        updateLegendLockButton();
        return;
    }

    if (legendLcoeTitle) {
        legendLcoeTitle.textContent = info.title || 'LCOE ($/MWh)';
    }
    legendLcoeMin.textContent = info.minLabel || '--';
    legendLcoeMid.textContent = info.midLabel || '--';
    legendLcoeMax.textContent = info.maxLabel || '--';
    legendLcoeRef.textContent = info.refLabel || 'Reference: --';
    setLegendGradient(info.gradient || 'cost');
    if (legendTxExplainer) {
        if (info.type === 'tx') {
            legendTxExplainer.classList.remove('hidden');
        } else {
            legendTxExplainer.classList.add('hidden');
        }
    }

    if (info.showComparison) {
        comparisonToggle.classList.remove('hidden');
        clearRefBtn.classList.remove('hidden');
        updateComparisonToggleUI();
        updateLegendLockButton();
    } else {
        comparisonToggle.classList.add('hidden');
        clearRefBtn.classList.add('hidden');
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();
    }
}

function updateLcoeLegend(points, overrideInfo = null) {
    if (overrideInfo) {
        renderLegendFromInfo(overrideInfo);
        return overrideInfo;
    }

    const valid = points.filter(p => p.meetsTarget && Number.isFinite(p.lcoe));
    if (!valid.length) {
        const info = {
            type: 'lcoe',
            title: 'LCOE ($/MWh)',
            minLabel: '--',
            midLabel: '--',
            maxLabel: '--',
            refLabel: 'Reference: --',
            gradient: 'cost',
            showComparison: false,
            domain: null
        };
        renderLegendFromInfo(info);
        return info;
    }

    if (lcoeReference) {
        if (comparisonMetric === 'tx') {
            const txValues = points
                .filter(p => p.meetsTarget && p.txMetrics && p.txMetrics.breakevenPerGwKm > 0)
                .map(p => p.txMetrics.breakevenPerGwKm)
                .sort((a, b) => a - b);
            let domain;
            let minLabel = '$0/GW/km';
            let midLabel = '--';
            let maxLabel = '--';
            if (txValues.length) {
                const pick = (q) => txValues[Math.min(txValues.length - 1, Math.max(0, Math.floor(q * txValues.length)))];
                const rawMax = pick(0.95) || txValues[txValues.length - 1];
                const max = Math.max(rawMax, 1);
                const mid = Math.max(pick(0.5), max * 0.5);
                domain = [0, mid, max];
                midLabel = `${formatCurrencyLabel(mid)}/GW/km`;
                maxLabel = `${formatCurrencyLabel(max)}/GW/km`;
            } else {
                domain = [0, 1, 1];
            }
            const info = {
                type: 'tx',
                domain,
                title: 'Breakeven Transmission ($/GW/km)',
                minLabel,
                midLabel,
                maxLabel,
                refLabel: `Reference: ${formatCurrencyLabel(lcoeReference.lcoe)}/MWh`,
                gradient: 'tx',
                showComparison: true
            };
            renderLegendFromInfo(info);
            return info;
        }

        const withDelta = points.filter(p => p.meetsTarget && Number.isFinite(p.delta));
        let info;
        if (!withDelta.length) {
            info = {
                type: 'delta',
                maxAbs: 1,
                title: 'LCOE Δ ($/MWh)',
                minLabel: '--',
                midLabel: '$0',
                maxLabel: '--',
                refLabel: `Reference: ${formatCurrencyLabel(lcoeReference.lcoe)}/MWh`,
                gradient: 'delta',
                showComparison: true
            };
        } else {
            const absVals = withDelta.map(p => Math.abs(p.delta)).sort((a, b) => a - b);
            const pick = (q) => absVals[Math.min(absVals.length - 1, Math.max(0, Math.floor(q * absVals.length)))];
            const maxAbs = Math.max(1, pick(DELTA_PERCENTILE) || absVals[absVals.length - 1] || 1);
            const labelVal = Math.max(1, Math.round(maxAbs));
            info = {
                type: 'delta',
                maxAbs: labelVal,
                title: 'LCOE Δ ($/MWh)',
                minLabel: `-${formatCurrencyLabel(labelVal)}`,
                midLabel: '$0',
                maxLabel: `+${formatCurrencyLabel(labelVal)}`,
                refLabel: `Reference: ${formatCurrencyLabel(lcoeReference.lcoe)}/MWh`,
                gradient: 'delta',
                showComparison: true
            };
        }
        renderLegendFromInfo(info);
        return info;
    }

    const costs = valid.map(p => p.lcoe).sort((a, b) => a - b);
    const pick = (q) => costs[Math.floor(q * (costs.length - 1))];
    const min = costs[0];
    const median = pick(0.5);
    const max = costs[costs.length - 1];

    const domain = [min, pick(0.33), pick(0.67), max];
    const info = {
        type: 'lcoe',
        domain,
        title: 'LCOE ($/MWh)',
        minLabel: formatCurrencyLabel(min),
        midLabel: formatCurrencyLabel(median),
        maxLabel: formatCurrencyLabel(max),
        refLabel: 'Reference: --',
        gradient: 'cost',
        showComparison: false
    };
    renderLegendFromInfo(info);
    return info;
}

function queueLcoeUpdate() {
    if (currentViewMode !== 'lcoe') return;
    if (lcoeUpdateTimeout) {
        clearTimeout(lcoeUpdateTimeout);
    }
    lcoeUpdateTimeout = setTimeout(() => {
        lcoeUpdateTimeout = null;
        updateLcoeView();
    }, 150);
}

async function init() {
    try {
        // Initialize Map
        await initMap(handleLocationSelect);

        // Initialize Sample Days
        initSampleDays();

        // Load Data
        loadingStatus.textContent = "Downloading summary data...";
        summaryData = await loadSummary();
        locationIndex = buildLocationIndex(summaryData);
        summaryCoordIndex = buildCoordIndex(summaryData);
        try {
            populationData = await loadPopulationCsv();
            populationCoordIndex = buildCoordIndex(populationData);
        } catch (err) {
            console.error("Population data load failed:", err);
            populationData = [];
            populationCoordIndex = new Map();
        }
        try {
            voronoiGeojson = await loadVoronoiGeojson();
        } catch (err) {
            console.error("Voronoi geojson load failed:", err);
            voronoiGeojson = null;
        }

        loadingStatus.textContent = "Processing...";
        console.log("Loaded summary data. Rows:", summaryData.length);
        updateUI();

        // Hide Loading
        loading.classList.add('hidden');

    } catch (err) {
        console.error(err);
        loadingStatus.textContent = "Error loading data: " + err.message;
        loadingStatus.classList.add('text-red-500');
    }
}

function updateUI() {
    if (currentViewMode === 'capacity') {
        // Update Map with CF data
        updateMap(summaryData, currentSolar, currentBatt);
        legendPopulation?.classList.add('hidden');
    } else if (currentViewMode === 'lcoe') {
        updateLcoeView();
        legendPopulation?.classList.add('hidden');
    } else if (currentViewMode === 'population') {
        updatePopulationView();
        legendPopulation?.classList.remove('hidden');
    } else {
        // Sample mode - map updates handled by samples.js
        legendPopulation?.classList.add('hidden');
    }
}

function updateLcoeView() {
    if (!summaryData.length || locationIndex.size === 0) return;
    lcoeResults = computeBestLcoeByLocation(lcoeParams.targetCf, lcoeParams);

    // Sync reference to freshest data
    let ref = null;
    if (lcoeReference) {
        ref = lcoeResults.find(r => r.location_id === lcoeReference.location_id) || null;
        lcoeReference = ref;
    }

    const wantsComparison = Boolean(ref);
    const desiredType = wantsComparison ? (comparisonMetric === 'tx' ? 'tx' : 'delta') : 'lcoe';
    if (!wantsComparison) {
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();
    } else if (legendLock && lockedColorInfo && lockedColorInfo.type !== desiredType) {
        lockedColorInfo = null;
    }

    const resultsWithDelta = lcoeResults.map(r => {
        const delta = ref ? r.lcoe - ref.lcoe : null;
        const txMetrics = ref ? computeTransmissionMetrics(r, ref, delta) : null;
        return { ...r, delta, txMetrics };
    });

    let colorInfo;
    if (legendLock && lockedColorInfo) {
        colorInfo = updateLcoeLegend(resultsWithDelta, lockedColorInfo);
    } else {
        colorInfo = updateLcoeLegend(resultsWithDelta);
        if (legendLock) {
            lockedColorInfo = colorInfo;
        }
    }
    lastColorInfo = colorInfo;

    updateLcoeMap(resultsWithDelta, {
        targetCf: lcoeParams.targetCf,
        colorInfo,
        reference: ref,
        comparisonMetric
    });
}

async function handleLocationSelect(locationData) {
    currentLocationId = locationData?.location_id ?? null;
    if (currentViewMode === 'lcoe' && locationData) {
        lcoeReference = locationData;
        updateLcoeView();
    }
}

function switchViewMode(mode) {
    setViewModeExplanation(mode);
    currentViewMode = mode;
    cleanupSampleDays();

    if (mode === 'capacity') {
        // Show capacity elements
        statsSection.classList.remove('hidden');
        locationPanel.classList.remove('hidden');
        systemConfig?.classList.remove('hidden');
        setConfigNoteVisibility(true);
        populationToggleWrapper?.classList.add('hidden');
        sampleControls.classList.add('hidden');
        lcoeControls.classList.add('hidden');
        legendCapacity.classList.remove('hidden');
        legendSamples.classList.add('hidden');
        legendLcoe.classList.add('hidden');
        if (comparisonToggle) comparisonToggle.classList.add('hidden');
        clearRefBtn.classList.add('hidden');
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();

        // Update map with CF data
        updateMap(summaryData, currentSolar, currentBatt);
    } else if (mode === 'samples') {
        // Show sample elements
        statsSection.classList.add('hidden');
        locationPanel.classList.add('hidden');
        systemConfig?.classList.remove('hidden');
        setConfigNoteVisibility(true);
        populationToggleWrapper?.classList.add('hidden');
        sampleControls.classList.remove('hidden');
        lcoeControls.classList.add('hidden');
        legendCapacity.classList.add('hidden');
        legendSamples.classList.remove('hidden');
        legendLcoe.classList.add('hidden');
        populationToggleWrapper?.classList.add('hidden');
        if (comparisonToggle) comparisonToggle.classList.add('hidden');
        clearRefBtn.classList.add('hidden');
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();

        // Load sample week data
        loadSampleWeekData(currentSolar, currentBatt, summaryData);
    } else if (mode === 'lcoe') {
        statsSection.classList.add('hidden');
        locationPanel.classList.remove('hidden');
        sampleControls.classList.add('hidden');
        lcoeControls.classList.remove('hidden');
        systemConfig?.classList.add('hidden');
        setConfigNoteVisibility(false);
        legendCapacity.classList.add('hidden');
        legendSamples.classList.add('hidden');
        legendLcoe.classList.remove('hidden');
        populationToggleWrapper?.classList.add('hidden');

        updateLcoeView();
    } else if (mode === 'population') {
        statsSection.classList.remove('hidden');
        locationPanel.classList.remove('hidden');
        sampleControls.classList.add('hidden');
        lcoeControls.classList.add('hidden');
        systemConfig?.classList.add('hidden');
        setConfigNoteVisibility(false);
        legendCapacity.classList.add('hidden');
        legendSamples.classList.add('hidden');
        legendLcoe.classList.add('hidden');
        populationToggleWrapper?.classList.remove('hidden');
        updatePopulationView();
    }
}

setViewModeExplanation(currentViewMode);
setConfigNoteVisibility(currentViewMode !== 'lcoe');
if (currentViewMode === 'population') {
    populationToggleWrapper?.classList.remove('hidden');
}
legendPopulation?.classList.add('hidden');
if (populationSolarSlider) {
    populationSolarSlider.value = currentSolar;
    if (populationSolarVal) populationSolarVal.textContent = currentSolar;
}
if (populationBattSlider) {
    populationBattSlider.value = currentBatt;
    if (populationBattVal) populationBattVal.textContent = currentBatt;
}

// Event Listeners
function handleSolarInput(value, origin = 'main') {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(1, Math.min(20, parsed));
    currentSolar = clamped;
    if (solarVal) solarVal.textContent = clamped;
    if (populationSolarVal) populationSolarVal.textContent = clamped;
    if (solarSlider && origin !== 'main') solarSlider.value = clamped;
    if (populationSolarSlider && origin !== 'population') populationSolarSlider.value = clamped;
    if (currentViewMode === 'capacity') {
        updateUI();
    } else if (currentViewMode === 'samples') {
        loadSampleWeekData(currentSolar, currentBatt, summaryData);
    } else if (currentViewMode === 'population') {
        updatePopulationView();
    }
}

function handleBattInput(value, origin = 'main') {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.max(0, Math.min(36, parsed));
    currentBatt = clamped;
    if (battVal) battVal.textContent = clamped;
    if (populationBattVal) populationBattVal.textContent = clamped;
    if (battSlider && origin !== 'main') battSlider.value = clamped;
    if (populationBattSlider && origin !== 'population') populationBattSlider.value = clamped;
    if (currentViewMode === 'capacity') {
        updateUI();
    } else if (currentViewMode === 'samples') {
        loadSampleWeekData(currentSolar, currentBatt, summaryData);
    } else if (currentViewMode === 'population') {
        updatePopulationView();
    }
}

solarSlider.addEventListener('input', (e) => handleSolarInput(e.target.value, 'main'));

battSlider.addEventListener('input', (e) => handleBattInput(e.target.value, 'main'));

populationSolarSlider?.addEventListener('input', (e) => handleSolarInput(e.target.value, 'population'));

populationBattSlider?.addEventListener('input', (e) => handleBattInput(e.target.value, 'population'));

viewModeSelect.addEventListener('change', (e) => {
    switchViewMode(e.target.value);
});

targetCfSlider.addEventListener('input', (e) => {
    const pct = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
    lcoeParams.targetCf = pct / 100;
    targetCfVal.textContent = pct;
    queueLcoeUpdate();
});

function updatePopulationView() {
    if (!populationData.length) return;
    const overlayMode = populationOverlaySelect?.value || 'none';
    updatePopulationOverlayControls(overlayMode);

    // Combine population with coordinates from summary
    const enriched = populationData.map(p => {
        const coords = summaryCoordIndex.get(coordKey(p.latitude, p.longitude)) || populationCoordIndex.get(coordKey(p.latitude, p.longitude)) || {};
        const lat = Number.isFinite(coords.latitude) ? coords.latitude : p.latitude;
        const lon = Number.isFinite(coords.longitude) ? coords.longitude : p.longitude;
        return {
            ...p,
            latitude: lat,
            longitude: lon,
            annual_cf: coords.annual_cf
        };
    }).filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));

    // Use current solar/batt selection to fetch CF overlay
    const cfFiltered = summaryData.filter(d => d.solar_gw === currentSolar && d.batt_gwh === currentBatt);
    let lcoeOverlay = [];
    let lcoeDomain = null;
    if (overlayMode === 'lcoe') {
        if (!lcoeResults.length) {
            lcoeResults = computeBestLcoeByLocation(lcoeParams.targetCf, lcoeParams);
        }
        const costs = lcoeResults.map(r => r.lcoe).filter(Number.isFinite).sort((a, b) => a - b);
        if (costs.length) {
            const pick = (q) => costs[Math.floor(q * (costs.length - 1))];
            lcoeDomain = [costs[0], pick(0.33), pick(0.67), costs[costs.length - 1]];
            const overrideInfo = {
                type: 'lcoe',
                domain: lcoeDomain,
                title: 'LCOE ($/MWh)',
                minLabel: formatCurrencyLabel(lcoeDomain[0]),
                midLabel: formatCurrencyLabel(pick(0.5)),
                maxLabel: formatCurrencyLabel(lcoeDomain[lcoeDomain.length - 1]),
                refLabel: 'Reference: --',
                gradient: 'cost',
                showComparison: false
            };
            updateLcoeLegend(lcoeResults, overrideInfo);
        } else {
            updateLcoeLegend([], {
                type: 'lcoe',
                title: 'LCOE ($/MWh)',
                minLabel: '--',
                midLabel: '--',
                maxLabel: '--',
                refLabel: 'Reference: --',
                gradient: 'cost',
                showComparison: false,
                domain: null
            });
        }
        lcoeOverlay = lcoeResults;
        legendLcoe.classList.remove('hidden');
        legendCapacity.classList.add('hidden');
    } else if (overlayMode === 'cf') {
        legendCapacity.classList.remove('hidden');
        legendLcoe.classList.add('hidden');
    } else {
        legendCapacity.classList.add('hidden');
        legendLcoe.classList.add('hidden');
    }
    updatePopulationLegend(enriched);
    legendPopulation?.classList.remove('hidden');
    if (voronoiGeojson) {
        updatePopulationGeo(enriched, voronoiGeojson, {
            overlayMode,
            cfData: overlayMode === 'cf' ? cfFiltered : [],
            lcoeData: overlayMode === 'lcoe' ? lcoeOverlay : [],
            lcoeDomain
        });
    } else {
        updatePopulationSimple(enriched);
    }
}

populationOverlaySelect?.addEventListener('change', () => {
    const mode = populationOverlaySelect.value;
    updatePopulationOverlayControls(mode);
    if (currentViewMode === 'population') {
        updatePopulationView();
    }
});

solarCapexInput.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value);
    if (Number.isFinite(val)) {
        lcoeParams.solarCapex = Math.max(0, val);
        queueLcoeUpdate();
    }
});

batteryCapexInput.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value);
    if (Number.isFinite(val)) {
        lcoeParams.batteryCapex = Math.max(0, val);
        queueLcoeUpdate();
    }
});

solarOpexInput.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value);
    if (Number.isFinite(val)) {
        lcoeParams.solarOpexPct = Math.max(0, val) / 100;
        queueLcoeUpdate();
    }
});

batteryOpexInput.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value);
    if (Number.isFinite(val)) {
        lcoeParams.batteryOpexPct = Math.max(0, val) / 100;
        queueLcoeUpdate();
    }
});

solarLifeInput.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    if (Number.isFinite(val)) {
        lcoeParams.solarLife = Math.max(1, val);
        queueLcoeUpdate();
    }
});

batteryLifeInput.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    if (Number.isFinite(val)) {
        lcoeParams.batteryLife = Math.max(1, val);
        queueLcoeUpdate();
    }
});

waccInput.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value);
    if (Number.isFinite(val)) {
        lcoeParams.wacc = Math.max(0, val) / 100;
        queueLcoeUpdate();
    }
});

comparisonButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        if (!lcoeReference) return;
        const mode = btn.dataset.mode;
        comparisonMetric = mode === 'tx' ? 'tx' : 'lcoe';
        updateComparisonToggleUI();
        updateLcoeView();
    });
});

clearRefBtn.addEventListener('click', () => {
    lcoeReference = null;
    comparisonMetric = 'lcoe';
    if (comparisonToggle) comparisonToggle.classList.add('hidden');
    clearRefBtn.classList.add('hidden');
    legendLock = false;
    lockedColorInfo = null;
    updateLegendLockButton();
    updateComparisonToggleUI();
    updateLcoeView();
});

legendLockBtn?.addEventListener('click', () => {
    if (!lcoeReference) return;
    legendLock = !legendLock;
    if (!legendLock) {
        lockedColorInfo = null;
        updateLegendLockButton();
        updateLcoeView();
    } else {
        lockedColorInfo = lastColorInfo;
        updateLegendLockButton();
        if (!lockedColorInfo) {
            updateLcoeView();
        } else {
            updateLcoeLegend(lcoeResults, lockedColorInfo);
        }
    }
});

// Start
init();
