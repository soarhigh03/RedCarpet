/* Time strips for the contact panel: one measurement against the last few seconds.
 * A gap in the data is drawn as a gap, not bridged — a frame with no target is a fact
 * about the link, and joining across it would invent a track that was never reported. */
(function () {
  const RL = (window.RL = window.RL || {});
  const FONT = "'Pretendard', -apple-system, system-ui, sans-serif";

  RL.Strip = function (canvas, options) {
    const ctx = canvas.getContext('2d');
    const config = Object.assign({ color: '#3f8a71', zero: false, format: (v) => v.toFixed(1) }, options);

    return {
      draw(points, now, windowSeconds) {
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
        if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
          canvas.width = width * dpr; canvas.height = height * dpr;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const pad = 3;
        const inWindow = points.filter((point) => now - point.t <= windowSeconds);
        const values = inWindow.filter((point) => point.v != null).map((point) => point.v);
        if (!values.length) {
          ctx.font = '500 10px ' + FONT; ctx.fillStyle = '#b4c2c6';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('no data', width / 2, height / 2);
          return;
        }

        let low = Math.min.apply(null, values), high = Math.max.apply(null, values);
        if (config.zero) { low = Math.min(low, 0); high = Math.max(high, 0); }
        if (high - low < 1e-9) { high += 1; low -= 1; }
        const margin = (high - low) * 0.15;
        low -= margin; high += margin;

        const toX = (t) => pad + (1 - (now - t) / windowSeconds) * (width - pad * 2);
        const toY = (v) => height - pad - ((v - low) / (high - low)) * (height - pad * 2);

        if (config.zero && low < 0 && high > 0) {
          ctx.strokeStyle = '#dde6e4'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(pad, toY(0)); ctx.lineTo(width - pad, toY(0)); ctx.stroke();
        }

        // Fill under the line, then the line itself, broken wherever a frame had no value.
        ctx.strokeStyle = config.color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
        let open = false;
        ctx.beginPath();
        for (const point of inWindow) {
          if (point.v == null) { open = false; continue; }
          const x = toX(point.t), y = toY(point.v);
          if (!open) { ctx.moveTo(x, y); open = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();

        const last = inWindow.filter((point) => point.v != null).pop();
        if (last) {
          ctx.beginPath(); ctx.arc(toX(last.t), toY(last.v), 2.4, 0, Math.PI * 2);
          ctx.fillStyle = config.color; ctx.fill();
        }

        ctx.font = '500 9px ' + FONT; ctx.fillStyle = '#aebcc0';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(config.format(high - margin), pad + 1, pad);
        ctx.textBaseline = 'bottom';
        ctx.fillText(config.format(low + margin), pad + 1, height - pad);
      },
    };
  };
})();
