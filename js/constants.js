/**
 * Shared constants
 */

export const ALL_FUELS = ['coal', 'oil_gas', 'bioenergy', 'nuclear'];

export const FUEL_COLORS = {
    coal: '#f97316',
    oil_gas: '#38bdf8',
    bioenergy: '#84cc16',
    nuclear: '#a855f7'
};

export const BASE_LOAD_MW = 1000;

export const TX_WACC = 0.06;
export const TX_LIFE = 50;

export const LCOE_NO_DATA_COLOR = '#611010';

export const VIEW_MODE_EXPLANATIONS = {
    capacity: 'Capacity Factor Map shows what share of the year a given solar + storage build can sustain a 1\u00a0MW baseload.',
    samples: 'Hourly Profile Samples replay a representative 168-hour week so you can examine solar output, storage dispatch, and any unmet 1\u00a0MW demand.',
    lcoe: 'LCOE Map compares the levelized cost ($/MWh) of every location that can meet the target capacity factor.',
    population: 'Supply-Demand Matching links where people live (population density as a proxy for demand) with the CF or LCOE of each location.'
};

// Color scale for Capacity Factor (0.0 to 1.0) - domain and range
export const CF_COLOR_SCALE = {
    domain: [0, 0.05, 0.4, 0.7, 1.0],
    range: ["#0049ff", "#0049ff", "#00c853", "#ff9800", "#d32f2f"]
};
