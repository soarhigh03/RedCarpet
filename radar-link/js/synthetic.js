/* Synthetic feed: the board's wire format with no board attached.
 *
 * Every row leaves here as ASCII and goes through the same parser as a real link, so
 * nothing downstream knows the difference. The geometry is a teaching model — straight
 * tracks, constant command speed, a closed-form crossing — not a guidance model, and it
 * is labelled synthetic everywhere it is shown.
 */
(function () {
  const RL = (window.RL = window.RL || {});
  const R2D = 180 / Math.PI, D2R = Math.PI / 180;

  /** Smallest positive time at which a point leaving the origin at `speed` meets p + v·t. */
  function crossingTime(p, v, speed) {
    const a = v.x * v.x + v.y * v.y - speed * speed;
    const b = 2 * (p.x * v.x + p.y * v.y);
    const c = p.x * p.x + p.y * p.y;
    if (Math.abs(a) < 1e-9) return b < -1e-9 ? -c / b : null;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    const candidates = [(-b - root) / (2 * a), (-b + root) / (2 * a)].filter((t) => t > 1e-4).sort((m, n) => m - n);
    return candidates.length ? candidates[0] : null;
  }

  /**
   * @param {{speed?:number, fovDeg?:number, maxRange?:number, seed?:number}} options
   *        speed is the command speed setting in m/s — the length of the go-to vector.
   */
  RL.Synthetic = function (options) {
    const config = Object.assign({ speed: 5, fovDeg: 160, maxRange: 30, seed: 20261011 }, options);
    let state = config.seed >>> 0;
    /** Repeatable noise, so a synthetic session can be described and reproduced. */
    const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
    const spread = (amount) => (random() * 2 - 1) * amount;

    let frame = 0;
    const half = config.fovDeg / 2;

    const spawn = (idx, cls, speedRange) => {
      const bearing = spread(half * 0.82) * D2R;
      const range = config.maxRange * (0.6 + random() * 0.35);
      const p = { x: range * Math.cos(bearing), y: range * Math.sin(bearing) };
      // Aimed past the radar rather than straight at it, so bearing actually moves.
      const aim = Math.atan2(-p.y + spread(config.maxRange * 0.25), -p.x);
      const speed = speedRange[0] + random() * (speedRange[1] - speedRange[0]);
      return { idx, cls, p, v: { x: Math.cos(aim) * speed, y: Math.sin(aim) * speed }, hidden: 0 };
    };

    // The drone band straddles the command speed on purpose: a contact moving faster
    // than the interceptor cannot always be met, which is the sol = 0 chase case.
    const DRONE = [config.speed * 0.6, config.speed * 1.8], MOVER = [0.6, 2.2];
    const tracks = [spawn(1, 2, DRONE), spawn(2, 1, MOVER)];

    return {
      label: 'Synthetic feed · seed ' + config.seed,
      /** Advance by dt seconds and return the wire lines for one frame. */
      next(dt) {
        frame = (frame + 1) % 65536;
        const lines = [];

        for (const track of tracks) {
          track.p.x += track.v.x * dt;
          track.p.y += track.v.y * dt;
          const range = Math.hypot(track.p.x, track.p.y);
          const bearing = Math.atan2(track.p.y, track.p.x) * R2D;

          // Out of the envelope: hold it out of view for a moment, then put up a new track.
          if (range > config.maxRange || range < 0.08 || Math.abs(bearing) > half) {
            if (++track.hidden > 12) Object.assign(track, spawn(track.idx, track.cls, track.cls === 2 ? DRONE : MOVER));
            continue;
          }
          track.hidden = 0;

          // What the module reports: range to the millimetre, bearing to a hundredth of a degree.
          const rangeMm = Math.round(range * 1000 + spread(1.5));
          const bearingCdeg = Math.round((bearing + spread(0.05)) * 100);
          const closingMms = Math.round(-((track.p.x * track.v.x + track.p.y * track.v.y) / range) * 1000);

          const ttg = crossingTime(track.p, track.v, config.speed);
          const solved = ttg !== null && ttg < 30;
          const aimAt = solved
            ? { x: track.p.x + track.v.x * ttg, y: track.p.y + track.v.y * ttg }
            : { x: track.p.x, y: track.p.y };           // chase: head at where it is now
          const aimLength = Math.hypot(aimAt.x, aimAt.y) || 1;
          const wx = Math.round((aimAt.x / aimLength) * config.speed * 1000);
          const wy = Math.round((aimAt.y / aimLength) * config.speed * 1000);
          const cx = wx + Math.round(spread(2));        // the board's correction, mm/s
          const cy = wy + Math.round(spread(2));

          lines.push(['G', frame, track.idx, track.cls, solved ? 1 : 0, rangeMm, bearingCdeg, closingMms,
            solved ? Math.round(ttg * 1000) : -1, wx, wy, cx, cy,
            Math.round(Math.atan2(cy, cx) * R2D * 100)].join(','));
        }

        if (!lines.length) lines.push('G,' + frame + ',-1');
        return lines;
      },
    };
  };
})();
