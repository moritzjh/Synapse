#pragma once

#include <sqlite3.h>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>

// Thin RAII wrapper around SQLite. Not thread-safe by itself; callers
// serialize access (see NoteStore).
class Db {
 public:
  explicit Db(const std::string& path);
  ~Db();
  Db(const Db&) = delete;
  Db& operator=(const Db&) = delete;

  void exec(const char* sql);
  sqlite3* handle() { return db_; }
  int64_t last_insert_id() const { return sqlite3_last_insert_rowid(db_); }

 private:
  sqlite3* db_ = nullptr;
};

class Stmt {
 public:
  Stmt(Db& db, const char* sql);
  ~Stmt();
  Stmt(const Stmt&) = delete;
  Stmt& operator=(const Stmt&) = delete;

  Stmt& bind(int idx, int64_t v);
  Stmt& bind(int idx, double v);
  Stmt& bind(int idx, std::string_view v);

  // Returns true while a row is available.
  bool step();
  void run() { while (step()) {} }
  void reset() { sqlite3_reset(stmt_); sqlite3_clear_bindings(stmt_); }

  int64_t col_int(int i) const { return sqlite3_column_int64(stmt_, i); }
  double col_double(int i) const { return sqlite3_column_double(stmt_, i); }
  std::string col_text(int i) const;

 private:
  sqlite3* db_;
  sqlite3_stmt* stmt_ = nullptr;
};

struct DbError : std::runtime_error {
  using std::runtime_error::runtime_error;
};
