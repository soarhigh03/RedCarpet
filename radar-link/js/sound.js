/* The drone alert tone, synthesised so the folder stays self-contained.
 *
 * Two rising notes rather than a chime: it has to read as a warning across a room, and
 * it has to be short enough to repeat without becoming noise. Browsers will not start
 * audio before the page has been clicked, so the context is created lazily and resumed
 * on the first interaction. */
(function () {
  const RL = (window.RL = window.RL || {});

  RL.Sound = function () {
    let ctx = null;

    function open() {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      if (!ctx) ctx = new Ctor();
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }

    /** One note with a short fade at each end, so it starts and stops without a click. */
    function note(audio, frequency, offset, duration, peak) {
      const at = audio.currentTime + offset;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(frequency, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(peak, at + 0.012);
      gain.gain.setValueAtTime(peak, at + duration - 0.035);
      gain.gain.linearRampToValueAtTime(0.0001, at + duration);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(at);
      osc.stop(at + duration + 0.02);
    }

    return {
      /** Called from a click, which is the only moment a browser will let audio start. */
      unlock() { try { open(); } catch {} },
      get ready() { return !!ctx && ctx.state === 'running'; },
      get available() { return !!(window.AudioContext || window.webkitAudioContext); },

      alert() {
        const audio = open();
        if (!audio || audio.state !== 'running') return false;
        note(audio, 988, 0, 0.13, 0.17);      // B5
        note(audio, 1319, 0.16, 0.19, 0.17);  // E6
        return true;
      },
    };
  };
})();
