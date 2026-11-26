// pg-mem adapter exposed as a minimal `pg` module for the external-DB worker integration test.
// pg-mem inlines parameters as text, which loses number types in INSERT ... SELECT; the wrapper
// substitutes numeric literals so the SQL semantics can be tested without a real server.
const { newDb } = require('pg-mem');
const mem = newDb();
const Base = mem.adapters.createPg().Client;

function quote(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

class Client extends Base {
  query(sql, valuesOrCallback, callback) {
    if (Array.isArray(valuesOrCallback)) {
      const text = String(sql).replace(/\$(\d+)/g, (_, n) => quote(valuesOrCallback[Number(n) - 1]));
      return super.query(text, undefined, callback);
    }
    return super.query(sql, valuesOrCallback, callback);
  }
}

module.exports = { Client };
