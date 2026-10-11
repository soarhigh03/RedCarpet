/* Shared number formatting. The board works in millimetres and hundredths of a degree,
 * and a bench test sits at 0.3 m while a drone run sits at 30 m, so distances switch
 * units rather than printing 0.00 m or 34912 mm. */
(function () {
  const RL = (window.RL = window.RL || {});

  const sign = (value) => (value > 0 ? '+' : value < 0 ? '−' : '') + Math.abs(value);

  RL.fmt = {
    /** Distance in metres → "349 mm", "1.24 m", "34.9 m". */
    distance(metres, places) {
      if (!Number.isFinite(metres)) return '—';
      if (Math.abs(metres) < 1) return Math.round(metres * 1000) + ' mm';
      return metres.toFixed(places == null ? 2 : places) + ' m';
    },
    distanceValue(metres) {
      if (!Number.isFinite(metres)) return { value: '—', unit: '' };
      if (Math.abs(metres) < 1) return { value: String(Math.round(metres * 1000)), unit: 'mm' };
      return { value: metres.toFixed(2), unit: 'm' };
    },
    /** Bearing in degrees → "−48.59°", always signed because 0 is the boresight. */
    bearing(degrees, places) {
      if (!Number.isFinite(degrees)) return '—';
      const fixed = Math.abs(degrees).toFixed(places == null ? 2 : places);
      return (degrees < 0 ? '−' : degrees > 0 ? '+' : '') + fixed + '°';
    },
    /** Heading of a vector → "−48.6°" with no forced sign on zero. */
    heading(degrees) {
      if (!Number.isFinite(degrees)) return '—';
      return (degrees < 0 ? '−' : '') + Math.abs(degrees).toFixed(1) + '°';
    },
    /** Radial rate in m/s. Positive is closing, which the label has to make explicit. */
    rate(metresPerSecond) {
      if (!Number.isFinite(metresPerSecond)) return '—';
      const text = Math.abs(metresPerSecond).toFixed(2);
      return (metresPerSecond > 0 ? '+' : metresPerSecond < 0 ? '−' : '') + text;
    },
    /** Time to go in seconds → "81 ms" or "1.24 s". */
    duration(seconds) {
      if (seconds == null || !Number.isFinite(seconds)) return '—';
      if (Math.abs(seconds) < 1) return Math.round(seconds * 1000) + ' ms';
      return seconds.toFixed(2) + ' s';
    },
    speed(metresPerSecond) {
      if (!Number.isFinite(metresPerSecond)) return '—';
      return metresPerSecond.toFixed(2) + ' m/s';
    },
    bytes(count) {
      if (count < 1024) return count + ' B';
      if (count < 1024 * 1024) return (count / 1024).toFixed(1) + ' kB';
      return (count / (1024 * 1024)).toFixed(2) + ' MB';
    },
    clock(seconds) {
      if (!Number.isFinite(seconds)) return '—';
      if (seconds < 60) return seconds.toFixed(1) + ' s';
      const minutes = Math.floor(seconds / 60);
      return minutes + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
    },
    signed: sign,
  };
})();
