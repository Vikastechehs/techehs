const http = require('node:http');
const { loadConfig } = require('./src/config');
const { openDatabase } = require('./src/db');
const { createRazorpay } = require('./src/razorpay');
const { createApp } = require('./src/app');

const config = loadConfig();
const db = openDatabase(config.databasePath);
const handler = createApp({ config, db, razorpay: createRazorpay(config) });
// Never let one failed request take the process down.
const server = http.createServer((req, res) => handler(req, res).catch((error) => { console.error(new Date().toISOString(), 'Unhandled request error', error); if (!res.headersSent) { res.writeHead(500); res.end(); } }));
server.listen(config.port, () => console.log(`PagePress license server listening on port ${config.port} for ${config.publicUrl}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
