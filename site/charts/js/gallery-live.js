export const LIVE_REFRESH_RATES = [
  { id: "1000", label: "1 Hz", intervalMs: 1000 },
  { id: "250", label: "4 Hz", intervalMs: 250 },
  { id: "100", label: "10 Hz", intervalMs: 100 },
  { id: "33", label: "30 Hz", intervalMs: 33 },
  { id: "16", label: "60 Hz", intervalMs: 16 },
];

export const DEFAULT_LIVE_REFRESH_RATE_ID = "100";

export function getLiveRefreshRate(id) {
  return (
    LIVE_REFRESH_RATES.find((rate) => rate.id === String(id)) ??
    LIVE_REFRESH_RATES.find((rate) => rate.id === DEFAULT_LIVE_REFRESH_RATE_ID) ??
    LIVE_REFRESH_RATES[0]
  );
}
