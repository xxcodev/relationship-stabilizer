/** @file Tiny SQL dialect helpers shared by the app and the external DB worker. */

// Convert positional `?` placeholders to PostgreSQL `$1..$n`. The project's SQL never puts
// a literal `?` inside a string, so a direct scan is sufficient and keeps SQL readable.
function toPgSql(sql) {
  let index = 0;
  return String(sql).replace(/\?/g, () => `$${++index}`);
}

module.exports = { toPgSql };
