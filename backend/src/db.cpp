#include "db.hpp"

Db::Db(const std::string& path) {
  if (sqlite3_open(path.c_str(), &db_) != SQLITE_OK) {
    std::string msg = sqlite3_errmsg(db_);
    sqlite3_close(db_);
    throw DbError("cannot open db: " + msg);
  }
  exec("PRAGMA journal_mode=WAL;");
  exec("PRAGMA synchronous=NORMAL;");
  exec("PRAGMA foreign_keys=ON;");
}

Db::~Db() { sqlite3_close(db_); }

void Db::exec(const char* sql) {
  char* err = nullptr;
  if (sqlite3_exec(db_, sql, nullptr, nullptr, &err) != SQLITE_OK) {
    std::string msg = err ? err : "unknown";
    sqlite3_free(err);
    throw DbError(msg);
  }
}

Stmt::Stmt(Db& db, const char* sql) : db_(db.handle()) {
  if (sqlite3_prepare_v2(db_, sql, -1, &stmt_, nullptr) != SQLITE_OK) {
    throw DbError(sqlite3_errmsg(db_));
  }
}

Stmt::~Stmt() { sqlite3_finalize(stmt_); }

Stmt& Stmt::bind(int idx, int64_t v) {
  sqlite3_bind_int64(stmt_, idx, v);
  return *this;
}

Stmt& Stmt::bind(int idx, double v) {
  sqlite3_bind_double(stmt_, idx, v);
  return *this;
}

Stmt& Stmt::bind(int idx, std::string_view v) {
  sqlite3_bind_text(stmt_, idx, v.data(), static_cast<int>(v.size()), SQLITE_TRANSIENT);
  return *this;
}

bool Stmt::step() {
  int rc = sqlite3_step(stmt_);
  if (rc == SQLITE_ROW) return true;
  if (rc == SQLITE_DONE) return false;
  throw DbError(sqlite3_errmsg(db_));
}

std::string Stmt::col_text(int i) const {
  auto* p = reinterpret_cast<const char*>(sqlite3_column_text(stmt_, i));
  return p ? std::string(p, sqlite3_column_bytes(stmt_, i)) : std::string();
}
