// services/migrateToNeon.js — one-time helper to copy every table's data
// from the current (source) Postgres database into a new (target) Postgres
// database, e.g. moving off Render's free Postgres (which expires) onto
// Neon's free tier (which doesn't).
//
// How it works, in plain terms:
//   1. Runs schema.sql against the target DB, so every table/column/index
//      exists there (safe to re-run — schema.sql uses CREATE TABLE IF NOT
//      EXISTS / ADD COLUMN IF NOT EXISTS everywhere).
//   2. Asks Postgres itself (via information_schema) which tables exist and
//      how they reference each other via foreign keys, then sorts the
//      tables so a table is only copied after every table it points to —
//      this avoids foreign-key errors without needing to hardcode table
//      order by hand.
//   3. For each table, in that order: empties it on the target (TRUNCATE
//      ... CASCADE, so this is safe to run more than once), reads every row
//      from the source, and re-inserts them on the target in batches.
//   4. Resets every SERIAL/IDENTITY sequence on the target to match the
//      highest id actually copied, so new rows created after the switch
//      don't collide with migrated ones.
//
// Nothing here is Exam-House-specific — it just walks whatever tables
// schema.sql defines, so it keeps working even as the schema grows.

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const BATCH_SIZE = 500;

function makePool(connectionString) {
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
}

async function getTablesInDependencyOrder(client) {
  const { rows: tables } = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  const allTables = tables.map(t => t.table_name);

  const { rows: fks } = await client.query(`
    SELECT
      tc.table_name AS from_table,
      ccu.table_name AS to_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name <> ccu.table_name
  `);

  // Kahn's algorithm-ish: repeatedly pick any table whose dependencies are
  // already placed. Falls back to just appending anything left over (e.g.
  // circular references) rather than looping forever.
  const deps = {};
  allTables.forEach(t => { deps[t] = new Set(); });
  fks.forEach(({ from_table, to_table }) => {
    if (deps[from_table] && to_table !== from_table) deps[from_table].add(to_table);
  });

  const ordered = [];
  const placed = new Set();
  let remaining = new Set(allTables);

  while (remaining.size > 0) {
    let progressed = false;
    for (const t of Array.from(remaining)) {
      const stillWaiting = Array.from(deps[t]).some(dep => remaining.has(dep));
      if (!stillWaiting) {
        ordered.push(t);
        placed.add(t);
        remaining.delete(t);
        progressed = true;
      }
    }
    if (!progressed) {
      // circular FK dependency somewhere — just append what's left in any
      // order; TRUNCATE ... CASCADE + per-row insert will still work fine
      // for the vast majority of real schemas.
      ordered.push(...Array.from(remaining));
      break;
    }
  }
  return ordered;
}

async function copyTable(sourceClient, targetPool, tableName, log) {
  const { rows: columnsInfo } = await sourceClient.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  const columns = columnsInfo.map(c => c.column_name);
  if (columns.length === 0) return { table: tableName, copied: 0, skipped: 'no columns found' };

  const { rows } = await sourceClient.query(`SELECT * FROM "${tableName}"`);

  await targetPool.query(`TRUNCATE TABLE "${tableName}" CASCADE`);

  let copied = 0;
  const colList = columns.map(c => `"${c}"`).join(', ');

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const valueRows = [];
    const params = [];
    batch.forEach((row, rIdx) => {
      const placeholders = columns.map((col, cIdx) => {
        params.push(row[col]);
        return `$${rIdx * columns.length + cIdx + 1}`;
      });
      valueRows.push(`(${placeholders.join(', ')})`);
    });
    const sql = `INSERT INTO "${tableName}" (${colList}) VALUES ${valueRows.join(', ')}`;
    await targetPool.query(sql, params);
    copied += batch.length;
  }

  // Reset any SERIAL/IDENTITY sequence on this table so future inserts
  // don't collide with the ids we just copied in.
  const { rows: seqCols } = await sourceClient.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
      AND column_default LIKE 'nextval%'
  `, [tableName]);
  for (const { column_name } of seqCols) {
    await targetPool.query(`
      SELECT setval(
        pg_get_serial_sequence($1, $2),
        COALESCE((SELECT MAX("${column_name}") FROM "${tableName}"), 1),
        true
      )
    `, [tableName, column_name]);
  }

  log(`  ✓ ${tableName}: ${copied} row(s) copied`);
  return { table: tableName, copied };
}

async function migrateToNeon({ sourceConnectionString, targetConnectionString, logFn }) {
  const log = logFn || (() => {});
  const sourcePool = makePool(sourceConnectionString);
  const targetPool = makePool(targetConnectionString);
  const results = [];

  try {
    log('Applying schema.sql to target database...');
    const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    await targetPool.query(schemaSql);
    log('Schema applied.');

    const sourceClient = await sourcePool.connect();
    try {
      const order = await getTablesInDependencyOrder(sourceClient);
      log(`Copying ${order.length} table(s) in dependency order: ${order.join(', ')}`);
      for (const table of order) {
        const result = await copyTable(sourceClient, targetPool, table, log);
        results.push(result);
      }
    } finally {
      sourceClient.release();
    }

    log('Migration complete.');
    return { ok: true, tables: results };
  } finally {
    await sourcePool.end();
    await targetPool.end();
  }
}

module.exports = { migrateToNeon };
