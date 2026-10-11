const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

function readSession(file = path.resolve(__dirname, '../.navbot/latest.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read debug session ${file}. Launch it first. ${error.message}`); }
}

function request(session, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(session.socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(12000, () => socket.destroy(new Error('Debug command timed out')));
    socket.once('connect', () => socket.write(`${JSON.stringify(command)}\n`));
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject);
    socket.once('end', () => {
      try {
        const result = JSON.parse(response);
        if (!result.ok) throw new Error(result.error);
        resolve(result.result);
      } catch (error) { reject(error); }
    });
  });
}

module.exports = { request, readSession };
