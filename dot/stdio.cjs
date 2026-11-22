"use strict";

const { Transform } = require("node:stream");

class PluginAdapterError extends Error {
  constructor(code, detail) {
    super(`[dot:${code}] ${detail}`);
    this.code = code;
  }
}

// The published SDK exposes stdio v4 but collapses exceptions to adapter_error.
// Keep the public SDK transport and restore only this adapter's typed errors.
function compatibleOutput(destination) {
  const output = new Transform({
    transform(chunk, encoding, callback) {
      const line = chunk.toString();
      try {
        const packet = JSON.parse(line);
        const typed = packet.ok === false && packet.error?.code === "adapter_error" &&
          /^\[dot:([a-z_]+)\] (.*)$/u.exec(packet.error.message);
        if (typed) {
          packet.error.code = typed[1];
          packet.error.message = typed[2];
          callback(null, `${JSON.stringify(packet)}\n`);
          return;
        }
      } catch {}
      callback(null, chunk);
    },
  });
  destination.on("error", (error) => output.destroy(error));
  output.pipe(destination, { end: false });
  return output;
}

module.exports = { PluginAdapterError, compatibleOutput };
