/* The scope: a plan view of the sensor's field with the radar at the origin, boresight
 * up, and positive bearing to one side. Everything drawn here comes from a row the board
 * sent — the contact where it said, the go-to vector it asked for, and the point that
 * vector reaches after the time to go it quoted.
 *
 * The sensor is an FMCW module with no moving parts, so there is no rotating sweep to
 * draw. The outer edge of the field brightens as frames arrive instead, which is a tell
 * about the link rather than a picture of a beam.
 */
(function () {
  const RL = (window.RL = window.RL || {});
  const D2R = Math.PI / 180;
  const UP = -Math.PI / 2;

  const COLOR = {
    faceInner: '#e6eef0', faceOuter: '#cfdcdf', edge: '#a8bcc0', ring: '#ffffffb8',
    ringText: '#8aa0a4', spoke: '#b6c8cb', spokeText: '#7d949a', boresight: '#8ca3a8',
    drone: '#c2673c', mover: '#5d7f98', unknown: '#7b8c94',
    command: '#ccff33', commandEdge: '#55681c', solved: '#1b9d88', chase: '#b08a3e',
    label: '#44635e', labelBack: '#ffffffd9', labelEdge: '#ffffff', quiet: '#7e9298',
  };

  const niceStep = (span) => {
    const raw = span / 4;
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    const unit = raw / power;
    return (unit < 1.5 ? 1 : unit < 3 ? 2 : unit < 7 ? 5 : 10) * power;
  };

  RL.niceRange = function (metres) {
    const span = Math.max(metres, 0.05);
    const power = Math.pow(10, Math.floor(Math.log10(span)));
    const unit = span / power;
    return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
  };

  RL.Scope = function (canvas) {
    const ctx = canvas.getContext('2d');
    let layout = null;
    let markers = [];

    const place = (view, x, y) => ({
      sx: layout.ox + y * view.side * layout.scale,
      sy: layout.oy - x * layout.scale,
    });

    /** Canvas angle for a bearing, given which side counts as positive. */
    const angleOf = (view, bearingDeg) => UP + bearingDeg * view.side * D2R;

    function measure(view) {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr; canvas.height = height * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const inset = view.insets;
      const left = inset.left, right = width - inset.right;
      const top = inset.top, bottom = height - inset.bottom;
      const ox = Math.max(left, Math.min(right, (left + right) / 2));
      const oy = Math.max(top + 40, bottom);
      const half = Math.min(view.fovDeg / 2, 90);
      const reach = Math.max(1, oy - top);
      const flank = Math.max(1, Math.min(ox - left, right - ox));
      const spread = Math.max(0.2, Math.sin(half * D2R));
      layout = { width, height, ox, oy, half, scale: Math.max(2, Math.min(reach / view.maxRange, flank / (view.maxRange * spread))) };
      return layout;
    }

    function sectorPath(view, radius) {
      ctx.beginPath();
      ctx.moveTo(layout.ox, layout.oy);
      ctx.arc(layout.ox, layout.oy, radius, angleOf(view, -layout.half), angleOf(view, layout.half));
      ctx.closePath();
    }

    function drawFace(view) {
      const radius = view.maxRange * layout.scale;
      ctx.clearRect(0, 0, layout.width, layout.height);

      const sky = ctx.createLinearGradient(0, 0, 0, layout.height);
      sky.addColorStop(0, '#dde7e9'); sky.addColorStop(1, '#d2dfe1');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, layout.width, layout.height);

      const face = ctx.createRadialGradient(layout.ox, layout.oy, 0, layout.ox, layout.oy, radius);
      face.addColorStop(0, COLOR.faceInner); face.addColorStop(1, COLOR.faceOuter);
      sectorPath(view, radius);
      ctx.fillStyle = face; ctx.fill();

      // Range rings, clipped to the field so they read as sensor coverage.
      ctx.save();
      sectorPath(view, radius); ctx.clip();
      const step = niceStep(view.maxRange);
      ctx.lineWidth = 1;
      for (let r = step; r <= view.maxRange * 1.001; r += step) {
        const pixels = r * layout.scale;
        ctx.beginPath();
        ctx.arc(layout.ox, layout.oy, pixels, angleOf(view, -layout.half), angleOf(view, layout.half));
        ctx.strokeStyle = COLOR.ring; ctx.stroke();
        ctx.font = '500 10px ' + FONT;
        ctx.fillStyle = COLOR.ringText; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(RL.fmt.distance(r, r < 10 ? 1 : 0), layout.ox + 6, layout.oy - pixels);
      }
      // Bearing spokes every 20°, labelled at the rim.
      ctx.strokeStyle = COLOR.spoke;
      for (let b = -Math.floor(layout.half / 20) * 20; b <= layout.half; b += 20) {
        if (b === 0) continue;
        const angle = angleOf(view, b);
        ctx.beginPath();
        ctx.moveTo(layout.ox, layout.oy);
        ctx.lineTo(layout.ox + Math.cos(angle) * radius, layout.oy + Math.sin(angle) * radius);
        ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1;
      }
      ctx.restore();

      // Spoke labels outside the clip so they are never cut in half.
      ctx.font = '500 10px ' + FONT;
      ctx.fillStyle = COLOR.spokeText; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let b = -Math.floor(layout.half / 20) * 20; b <= layout.half; b += 20) {
        const angle = angleOf(view, b);
        const at = radius + 11;
        ctx.fillText((b > 0 ? '+' : b < 0 ? '−' : '') + Math.abs(b) + '°',
          layout.ox + Math.cos(angle) * at, layout.oy + Math.sin(angle) * at);
      }

      // Boresight: x = 정면, the axis the go-to vector is measured from.
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = COLOR.boresight; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(layout.ox, layout.oy); ctx.lineTo(layout.ox, layout.oy - radius); ctx.stroke();
      ctx.restore();

      // Field edge, brightening with each frame that lands.
      ctx.beginPath();
      ctx.arc(layout.ox, layout.oy, radius, angleOf(view, -layout.half), angleOf(view, layout.half));
      ctx.strokeStyle = COLOR.edge; ctx.lineWidth = 1.2; ctx.stroke();
      if (view.pulse > 0.001) {
        ctx.strokeStyle = 'rgba(204,255,51,' + (0.22 + 0.5 * view.pulse).toFixed(3) + ')';
        ctx.lineWidth = 2.2; ctx.stroke();
      }
      sectorPath(view, radius);
      ctx.strokeStyle = COLOR.edge; ctx.lineWidth = 1; ctx.stroke();

      // The radar itself.
      ctx.beginPath(); ctx.arc(layout.ox, layout.oy, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#35525d'; ctx.fill();
      ctx.beginPath(); ctx.arc(layout.ox, layout.oy, 9, 0, Math.PI * 2);
      ctx.strokeStyle = '#35525d66'; ctx.lineWidth = 1; ctx.stroke();
    }

    const FONT = "'Pretendard', -apple-system, system-ui, sans-serif";

    function pill(text, sx, sy, tone) {
      ctx.font = '600 11px ' + FONT;
      const width = ctx.measureText(text).width + 12;
      const left = Math.max(2, Math.min(layout.width - width - 2, sx - width / 2));
      const top = Math.max(2, Math.min(layout.height - 20, sy));
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(left, top, width, 17, 4);
      else ctx.rect(left, top, width, 17);
      ctx.fillStyle = COLOR.labelBack; ctx.fill();
      ctx.strokeStyle = tone || COLOR.labelEdge; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = COLOR.label; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(text, left + 6, top + 9);
    }

    function arrow(fromX, fromY, toX, toY, dashed) {
      const angle = Math.atan2(toY - fromY, toX - fromX);
      const length = Math.hypot(toX - fromX, toY - fromY);
      if (length < 4) return;
      const head = Math.min(11, length * 0.35);
      const baseX = toX - Math.cos(angle) * head, baseY = toY - Math.sin(angle) * head;
      ctx.save();
      if (dashed) ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(baseX, baseY); ctx.stroke();
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(toX, toY);
      ctx.lineTo(baseX + Math.cos(angle + Math.PI / 2) * head * 0.46, baseY + Math.sin(angle + Math.PI / 2) * head * 0.46);
      ctx.lineTo(baseX + Math.cos(angle - Math.PI / 2) * head * 0.46, baseY + Math.sin(angle - Math.PI / 2) * head * 0.46);
      ctx.closePath();
      ctx.fill();
    }

    function drawTrail(view, track, now) {
      if (track.history.length < 2 || view.trailSeconds <= 0) return;
      const color = COLOR[track.klass.key] || COLOR.unknown;
      ctx.lineWidth = 1.6; ctx.lineCap = 'round';
      for (let i = 1; i < track.history.length; i++) {
        const previous = track.history[i - 1], point = track.history[i];
        const age = now - point.t;
        if (age > view.trailSeconds) continue;
        const a = place(view, previous.x, previous.y), b = place(view, point.x, point.y);
        ctx.globalAlpha = Math.max(0, 0.5 * (1 - age / view.trailSeconds));
        ctx.strokeStyle = color;
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    function drawMarker(view, track, selected) {
      const row = track.row;
      const at = place(view, row.position.x, row.position.y);
      const color = COLOR[track.klass.key] || COLOR.unknown;
      markers.push({ idx: track.idx, sx: at.sx, sy: at.sy });

      ctx.globalAlpha = track.stale ? 0.4 : 1;
      if (selected) {
        ctx.beginPath(); ctx.arc(at.sx, at.sy, 15, 0, Math.PI * 2);
        ctx.strokeStyle = COLOR.command; ctx.lineWidth = 2; ctx.stroke();
        ctx.beginPath(); ctx.arc(at.sx, at.sy, 15, 0, Math.PI * 2);
        ctx.strokeStyle = COLOR.commandEdge + '55'; ctx.lineWidth = 0.8; ctx.stroke();
      }

      if (track.klass.key === 'drone') {
        // Four rotors around a body: the glyph says class 2 without reading the label.
        ctx.strokeStyle = color; ctx.lineWidth = 1.4;
        for (const [dx, dy] of [[-6, -6], [6, -6], [-6, 6], [6, 6]]) {
          ctx.beginPath(); ctx.moveTo(at.sx, at.sy); ctx.lineTo(at.sx + dx, at.sy + dy); ctx.stroke();
          ctx.beginPath(); ctx.arc(at.sx + dx, at.sy + dy, 2.6, 0, Math.PI * 2);
          ctx.fillStyle = color; ctx.fill();
        }
        ctx.beginPath(); ctx.arc(at.sx, at.sy, 3.4, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(at.sx, at.sy, 4.4, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        ctx.beginPath(); ctx.arc(at.sx, at.sy, 8, 0, Math.PI * 2);
        ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.globalAlpha *= 0.65; ctx.stroke();
        ctx.globalAlpha = track.stale ? 0.4 : 1;
      }

      if (track.stale) {
        ctx.save(); ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.arc(at.sx, at.sy, 12, 0, Math.PI * 2);
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      return at;
    }

    function drawSolution(view, track, selected) {
      const row = track.row;
      const origin = { sx: layout.ox, sy: layout.oy };
      const alpha = track.stale ? 0.25 : selected ? 1 : 0.45;
      const target = place(view, row.position.x, row.position.y);

      if (row.solved && row.intercept) {
        const meet = place(view, row.intercept.x, row.intercept.y);

        // Where the contact is going, from where it is to where the vector meets it.
        ctx.save();
        ctx.globalAlpha = alpha * 0.8; ctx.setLineDash([5, 4]);
        ctx.strokeStyle = COLOR.solved; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(target.sx, target.sy); ctx.lineTo(meet.sx, meet.sy); ctx.stroke();
        ctx.restore();

        // The go-to vector, drawn out to the point it reaches in the quoted time.
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = COLOR.commandEdge; ctx.fillStyle = COLOR.commandEdge; ctx.lineWidth = 4.6;
        arrow(origin.sx, origin.sy, meet.sx, meet.sy, false);
        ctx.strokeStyle = COLOR.command; ctx.fillStyle = COLOR.command; ctx.lineWidth = 2.4;
        arrow(origin.sx, origin.sy, meet.sx, meet.sy, false);

        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(meet.sx, meet.sy - 6); ctx.lineTo(meet.sx + 6, meet.sy);
        ctx.lineTo(meet.sx, meet.sy + 6); ctx.lineTo(meet.sx - 6, meet.sy);
        ctx.closePath();
        ctx.fillStyle = '#ffffffcc'; ctx.fill();
        ctx.strokeStyle = COLOR.solved; ctx.lineWidth = 1.6; ctx.stroke();
        ctx.globalAlpha = 1;
        if (selected) pill(RL.fmt.duration(row.ttgS) + ' to intercept', meet.sx, meet.sy + 11, COLOR.solved + '66');
      } else {
        // No solution: the board is only chasing, so the vector gets a fixed length.
        const reach = view.maxRange * 0.33;
        const tip = place(view, Math.cos(row.command.headingDeg * D2R) * reach, Math.sin(row.command.headingDeg * D2R) * reach);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = COLOR.commandEdge; ctx.fillStyle = COLOR.commandEdge; ctx.lineWidth = 4;
        arrow(origin.sx, origin.sy, tip.sx, tip.sy, true);
        ctx.strokeStyle = COLOR.chase; ctx.fillStyle = COLOR.chase; ctx.lineWidth = 2;
        arrow(origin.sx, origin.sy, tip.sx, tip.sy, true);
        ctx.globalAlpha = 1;
        if (selected) pill('chase · no solution', tip.sx, tip.sy - 22, COLOR.chase + '66');
      }
    }

    return {
      get layout() { return layout; },

      render(view) {
        measure(view);
        markers = [];
        drawFace(view);

        const live = view.tracks.filter((track) => track.row);
        for (const track of live) drawTrail(view, track, view.now);
        for (const track of live) drawSolution(view, track, track.idx === view.selected);
        for (const track of live) {
          const at = drawMarker(view, track, track.idx === view.selected);
          const row = track.row;
          const text = '#' + track.idx + '  ' + RL.fmt.distance(row.rangeM) + '  ' + RL.fmt.bearing(row.bearingDeg, 1);
          pill(text, at.sx, at.sy + 16, track.idx === view.selected ? COLOR.command : COLOR.labelEdge);
        }

        if (!live.length) {
          ctx.font = '600 13px ' + FONT;
          ctx.fillStyle = COLOR.quiet; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.globalAlpha = 0.8;
          ctx.fillText(view.message || 'NO CONTACT', layout.ox, layout.oy - view.maxRange * layout.scale * 0.5);
          ctx.globalAlpha = 1;
        }
      },

      /** Nearest contact to a point in canvas coordinates, or null. */
      pick(x, y) {
        let best = null, bestDistance = 20;
        for (const marker of markers) {
          const distance = Math.hypot(marker.sx - x, marker.sy - y);
          if (distance < bestDistance) { best = marker.idx; bestDistance = distance; }
        }
        return best;
      },

      /** Range in metres at a point, used for the scroll-to-zoom hint. */
      rangeAt(x, y) {
        if (!layout) return 0;
        return Math.hypot(x - layout.ox, y - layout.oy) / layout.scale;
      },
    };
  };
})();
