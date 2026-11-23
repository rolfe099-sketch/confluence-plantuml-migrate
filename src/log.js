// The change log: one JSON object per line, flushed to disk before and
// after every write, so it is complete even if the run is cut off.
'use strict';

const fs = require('fs');

function openLog(file) {
  const fd = fs.openSync(file, 'a');
  return {
    file,
    write(entry) {
      fs.writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
      fs.fsyncSync(fd);
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

function readLog(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  return lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`${file}: line ${i + 1} is not valid JSON`);
    }
  });
}

module.exports = { openLog, readLog };
