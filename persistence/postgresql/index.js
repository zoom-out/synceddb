var Promise = require('bluebird');
var pg = Promise.promisifyAll(require('pg'));

function getClient(p) {
  return pg.connectAsync(p.conString).spread(function(client, done) {
    client.close = done;
    return client;
  });
}

function getNewKey(client) {
  return client.queryAsync(
    'SELECT max(key) FROM synceddb_changes'
  ).then(function(res) {
    return (res.rows[0].max !== null) ? res.rows[0].max + 1 : 0;
  });
}

function pgPersistence(opts) {
  var client;
  this.conString = opts.conString;
  getClient(this).then(function(c) {
    client = c;
    return client.queryAsync(
      'CREATE TABLE IF NOT EXISTS synceddb_changes' +
      '(timestamp serial, ' +
      'key INTEGER NOT NULL, ' +
      'storename TEXT NOT NULL, ' +
      'type TEXT NOT NULL,' +
      'data JSON NOT NULL)'
    );
  }).then(function() {
    client.close();
  });
}

var requiredProps = {
  create: ['type', 'storeName', 'record'],
  update: ['type', 'storeName', 'version', 'diff', 'key'],
  delete: ['type', 'storeName', 'key', 'version'],
};

var validateChange = function(c) {
  if (!(c.type in requiredProps)) {
    throw new Error('Change type ' + c.type + ' is invalid');
  }
  requiredProps[c.type].forEach(function(p) {
    if (!(p in c)) {
      throw new Error('Change of type ' + c.type + ' misses property ' + p);
    }
  });
};

var processChange = {
  create: function(change, data, client) {
    change.version = 0;
    data.version = 0;
    data.record = change.record;
    return getNewKey(client).then(function(nK) {
      change.record.key = nK;
      change.key = nK;
    });
  },
  update: function(change, data, client) {
    data.diff = change.diff;
    change.version++;
    data.version = change.version;
  },
  delete: function(change, data, client) {
    change.version++;
    data.version = change.version;
  },
};

pgPersistence.prototype.saveChange = function(change) {
  var client;
  var data = {};
  return getClient(this).then(function(c) {
    client = c;
    return processChange[change.type](change, data, client);
  }).then(function() {
    return client.queryAsync(
      'INSERT INTO synceddb_changes (key, storename, type, data)' +
      'VALUES ($1, $2, $3, $4) RETURNING timestamp',
      [change.key, change.storeName, change.type, data]
    );
  }).then(function(res) {
    client.close();
    change.timestamp = res.rows[0].timestamp;
    return change;
  });
};

pgPersistence.prototype.getChanges = function(req) {
  var client;
  var since = req.since === null ? -1 : req.since;
  return getClient(this).then(function(c) {
    client = c;
    return client.queryAsync(
      'SELECT * FROM synceddb_changes WHERE storename = $1 AND timestamp > $2',
      [req.storeName, since]
    );
  }).then(function(result) {
    client.close();
    return result.rows.map(function(r) {
      r.data.key = r.key;
      r.data.timestamp = r.timestamp;
      r.data.storeName = r.storename;
      r.data.type = r.type;
      return r.data;
    });
  });
};

pgPersistence.prototype.getChangesToRecord = function(change) {
};

pgPersistence.prototype.resetChanges = function(change) {
  var client;
  return getClient(this).then(function(c) {
    client = c;
    return client.queryAsync('DELETE FROM synceddb_changes');
  }).then(function() {
    return client.queryAsync('ALTER SEQUENCE synceddb_changes_timestamp_seq RESTART WITH 1');
  }).then(function() {
    client.close();
  });
};

module.exports = pgPersistence;
