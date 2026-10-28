"use strict";

const Database = require("better-sqlite3");

function readRows(file, sql, timeout = 5000) {
  const database = new Database(file, { readonly: true, fileMustExist: true, timeout });
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

function execute(file, sql, timeout = 5000) {
  const database = new Database(file, { fileMustExist: true, timeout });
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

module.exports = { readRows, execute };
