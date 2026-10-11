/* Ways to get the board's lines into the page.
 *
 * Each transport resolves to the same handle: { kind, name, detail, close() }, and pushes
 * decoded ASCII at handlers.onText. Nothing above this file cares which one is open.
 */
(function () {
  const RL = (window.RL = window.RL || {});

  RL.support = {
    bluetooth: typeof navigator !== 'undefined' && !!navigator.bluetooth,
    serial: typeof navigator !== 'undefined' && !!navigator.serial,
    secure: typeof window !== 'undefined' && window.isSecureContext,
  };

  /** Nordic UART Service, which is what an ESP32 BLE sketch normally exposes. */
  RL.NUS = {
    service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
    write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  };

  const uuid = (text) => String(text || '').trim().toLowerCase();

  RL.transports = {
    /** Bluetooth LE, which is the only Bluetooth an ESP32-C5 has. */
    async ble(settings, handlers) {
      if (!navigator.bluetooth) throw new Error('This browser has no Web Bluetooth. Use Chrome, or run the Python bridge.');
      const service = uuid(settings.bleService) || RL.NUS.service;
      const wanted = uuid(settings.bleNotify);

      const device = await navigator.bluetooth.requestDevice(
        settings.bleShowAll
          ? { acceptAllDevices: true, optionalServices: [service] }
          : { filters: [{ services: [service] }], optionalServices: [service] }
      );

      const server = await device.gatt.connect();
      const gattService = await server.getPrimaryService(service);
      const characteristics = await gattService.getCharacteristics();
      const channel = characteristics.find((c) => uuid(c.uuid) === wanted)
        || characteristics.find((c) => c.properties.notify)
        || characteristics.find((c) => c.properties.indicate);
      if (!channel) throw new Error('That service has no characteristic that notifies.');

      const decoder = new TextDecoder();
      const onValue = (event) => {
        const view = event.target.value;
        handlers.onBytes(view.byteLength);
        handlers.onText(decoder.decode(view));
      };
      const onGone = () => handlers.onClose('the device disconnected');
      channel.addEventListener('characteristicvaluechanged', onValue);
      device.addEventListener('gattserverdisconnected', onGone);
      await channel.startNotifications();

      return {
        kind: 'ble',
        name: device.name || 'Unnamed BLE device',
        detail: 'notify ' + channel.uuid.slice(0, 8),
        async close() {
          device.removeEventListener('gattserverdisconnected', onGone);
          channel.removeEventListener('characteristicvaluechanged', onValue);
          try { await channel.stopNotifications(); } catch {}
          try { device.gatt.disconnect(); } catch {}
        },
      };
    },

    /** A serial port: a USB CDC cable, or a virtual port a dongle put on the system. */
    async serial(settings, handlers) {
      if (!navigator.serial) throw new Error('This browser has no Web Serial. Use Chrome, or run the Python bridge.');
      const port = await navigator.serial.requestPort();
      const baudRate = Number(settings.baud) || 115200;
      await port.open({ baudRate });

      const decoder = new TextDecoderStream();
      const piped = port.readable.pipeTo(decoder.writable).catch(() => {});
      const reader = decoder.readable.getReader();
      let running = true;

      (async () => {
        try {
          while (running) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) { handlers.onBytes(value.length); handlers.onText(value); }
          }
        } catch (error) {
          if (running) handlers.onError(error);
        }
        if (running) handlers.onClose('the port closed');
      })();

      const info = port.getInfo ? port.getInfo() : {};
      const vendor = info.usbVendorId != null
        ? 'USB ' + info.usbVendorId.toString(16).padStart(4, '0') + ':' + String(info.usbProductId || 0).padStart(4, '0')
        : 'serial port';
      return {
        kind: 'serial',
        name: vendor,
        detail: baudRate + ' baud',
        async close() {
          running = false;
          try { await reader.cancel(); } catch {}
          try { await piped; } catch {}
          try { await port.close(); } catch {}
        },
      };
    },

    /** The Python bridge: pyserial or bleak forwarded over a WebSocket. */
    bridge(settings, handlers) {
      const url = String(settings.bridgeUrl || '').trim() || 'ws://127.0.0.1:8787';
      return new Promise((resolve, reject) => {
        let socket;
        try { socket = new WebSocket(url); } catch (error) { reject(error); return; }
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) { settled = true; try { socket.close(); } catch {} reject(new Error('No answer from ' + url + '. Is bridge.py running?')); }
        }, 6000);

        socket.onopen = () => {
          settled = true; clearTimeout(timer);
          resolve({
            kind: 'bridge', name: url, detail: 'WebSocket',
            close() { socket.onclose = null; try { socket.close(); } catch {} },
          });
        };
        socket.onmessage = (event) => {
          const text = typeof event.data === 'string' ? event.data : '';
          if (!text) return;
          handlers.onBytes(text.length);
          handlers.onText(text.endsWith('\n') ? text : text + '\n');
        };
        socket.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Could not reach ' + url + '. Is bridge.py running?')); } };
        socket.onclose = () => { if (settled) handlers.onClose('the bridge closed'); };
      });
    },
  };
})();
