/**
 * Master switch for every outbound live timing call (F1 SignalR feed, RapidAPI poller).
 * Off unless LIVE_TIMING_ENABLED=true, so no reconnect attempts or request quota are spent
 * while there is no usable live data source.
 */
export const isLiveTimingEnabled = () => process.env.LIVE_TIMING_ENABLED === 'true'
