// Daily SQLite backup without the sqlite3 CLI. VACUUM INTO writes a
// consistent copy while the app keeps running in WAL mode; a plain file copy
// could miss pages that are still in the -wal file.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const source = resolve(process.env.DATABASE_PATH ?? 'data/opendots.sqlite');
const dir = resolve(process.env.BACKUP_DIR ?? 'data/backups');
const keep = Number(process.env.BACKUP_KEEP ?? 14);
if (!Number.isInteger(keep) || keep < 1)
  throw new Error('BACKUP_KEEP must be a positive integer.');

mkdirSync(dir, { recursive: true });
const stamp = new Date(Date.now() + 9 * 3600_000)
  .toISOString()
  .slice(0, 19)
  .replace(/[-:]/g, '')
  .replace('T', '-');
const target = join(dir, `opendots-${stamp}.sqlite`);
if (existsSync(target)) {
  console.log(`A backup for ${stamp} already exists; nothing to do.`);
  process.exit(0);
}
const db = new DatabaseSync(source, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} finally {
  db.close();
}

const old = readdirSync(dir)
  .filter((name) => /^opendots-\d{8}-\d{6}\.sqlite$/.test(name))
  .sort()
  .slice(0, -keep);
for (const name of old) rmSync(join(dir, name));
console.log(`Backed up to ${target}; removed ${old.length} old copies.`);
