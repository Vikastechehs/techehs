// Support tool: node scripts/admin.js find EMAIL | disable KEY | enable KEY  (uses DATABASE_PATH)
const { openDatabase } = require('../src/db');
const [command, value] = process.argv.slice(2);
const db = openDatabase(process.env.DATABASE_PATH || './data/pagepress.sqlite');
const date = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '-');
if (command === 'find' && value) {
  const rows = db.prepare('SELECT * FROM licenses WHERE email = ? ORDER BY created_at').all(value.trim().toLowerCase());
  if (!rows.length) console.log('No licenses for that email.');
  for (const l of rows) {
    const used = db.prepare('SELECT COUNT(*) AS n FROM instances WHERE license_key = ? AND revoked_at IS NULL').get(l.key).n;
    console.log(`${l.key}  ${l.status}  ${l.currency}  expires ${date(l.expires_at)}  activations ${used}/${l.activation_limit}  subscription ${l.subscription_id}${l.renewal_cancelled ? '  renewal cancelled' : ''}`);
  }
} else if (['disable', 'enable'].includes(command) && value) {
  const changes = db.prepare('UPDATE licenses SET status = ? WHERE key = ?').run(command === 'disable' ? 'disabled' : 'active', value.trim()).changes;
  console.log(changes ? `License ${command}d.` : 'No license with that key.');
} else {
  console.log('Usage: node scripts/admin.js find EMAIL | disable KEY | enable KEY');
  process.exitCode = 1;
}
