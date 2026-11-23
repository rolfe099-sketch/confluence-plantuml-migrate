// The change log: one JSON object per line, flushed to disk before and
// after every write, so it is complete even if the run is cut off.
'use strict';

const fs = require('fs');

function openLog(file) {
  const fd = fs.openSync(file, 'a', 0o600);
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

/**
 * Reads a log. A last line cut short (the run was killed while writing it)
 * is skipped with a warning; a bad line anywhere else stops.
 */
function readLog(file, io) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((x) => x.trim() !== '');
  const out = [];
  lines.forEach((x, i) => {
    try {
      out.push(JSON.parse(x));
    } catch {
      if (i === lines.length - 1) {
        if (io) io.print(`  note: the last line of ${file} is incomplete (the run was cut off while writing it); it is skipped.`);
        return;
      }
      throw new Error(`${file}: line ${i + 1} is not valid JSON`);
    }
  });
  return out;
}

module.exports = { openLog, readLog };
