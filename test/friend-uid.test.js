// UID-first friend identity: upsert by UID, rename sync, and session capability by UID.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyf-uid-'));
process.env.DATA_DIR = tmp;
process.env.DB_FILE = path.join(tmp, 'app.db');

const repos = require('../src/repos');
const apiSession = require('../src/api-session');
const { syncFriendNamesFromMutual } = require('../src/dashboard');
const db = require('../src/db');

let acc;

test.before(() => {
  acc = repos.upsertAccount({ label: 'U1', profileDir: path.join(tmp, 'p'), port: 9349, friend: '', enabled: true });
  repos.seedAccountDefaults(acc.id);
});

test.after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('upsertFriendByUid creates once and renames by UID', () => {
  let rows = repos.upsertFriendByUid(acc.id, 'OldName', '1001');
  assert.equal(rows.length, 1);
  const id = rows[0].id;
  assert.equal(rows[0].userid, '1001');

  rows = repos.upsertFriendByUid(acc.id, 'NewName', '1001');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].name, 'NewName');
  assert.equal(repos.getFriendByUid(acc.id, '1001').name, 'NewName');
});

test('upsertFriendByUid attaches a UID to a legacy name-only row', () => {
  repos.addFriend(acc.id, 'Legacy');
  const before = repos.getFriendByName(acc.id, 'Legacy');
  assert.equal(before.userid || '', '');

  const rows = repos.upsertFriendByUid(acc.id, 'Legacy', '2002');
  const after = rows.find((r) => r.id === before.id);
  assert.ok(after);
  assert.equal(after.userid, '2002');
  assert.equal(rows.filter((r) => r.userid === '2002').length, 1);
});

test('upsertFriendByUid refuses to overwrite a different UID with the same nickname', () => {
  repos.upsertFriendByUid(acc.id, 'Taken', '3003');
  assert.throws(() => repos.upsertFriendByUid(acc.id, 'Taken', '3004'), /占用/);
  assert.equal(repos.getFriendByName(acc.id, 'Taken').userid, '3003');
});

test('syncFriendNamesFromMutual renames by UID, links name-only rows and never auto-adds', () => {
  repos.addFriend(acc.id, 'SyncOld', '4004');
  repos.addFriend(acc.id, 'SyncLegacy');
  const before = repos.listFriends(acc.id);
  const oldRow = before.find((r) => r.name === 'SyncOld');
  const legacyRow = before.find((r) => r.name === 'SyncLegacy');

  const touched = syncFriendNamesFromMutual(acc, [
    { name: 'SyncNew', uid: '4004' },
    { name: 'SyncLegacy', uid: '5005' },
    { name: 'Stranger', uid: '6006' },
  ]);
  const after = repos.listFriends(acc.id);
  assert.equal(touched.renamed, 1);
  assert.equal(touched.linked, 1);
  assert.equal(after.find((r) => r.id === oldRow.id).name, 'SyncNew');
  assert.equal(after.find((r) => r.id === legacyRow.id).userid, '5005');
  assert.equal(after.filter((r) => r.userid === '6006').length, 0);
});

test('syncFriendNamesFromMutual counts a nickname clash instead of overwriting', () => {
  const a = repos.upsertFriendByUid(acc.id, 'ClashA', '7007').find((r) => r.userid === '7007');
  const b = repos.upsertFriendByUid(acc.id, 'ClashB', '8008').find((r) => r.userid === '8008');
  const touched = syncFriendNamesFromMutual(acc, [{ name: 'ClashB', uid: '7007' }]);
  assert.ok(touched.conflicts >= 1);
  assert.equal(repos.getFriendByUid(acc.id, '7007').name, 'ClashA');
  assert.equal(repos.getFriendByUid(acc.id, '8008').name, 'ClashB');
});

test('syncFriendNamesFromMutual refuses to link a UID through an ambiguous nickname', () => {
  repos.addFriend(acc.id, 'Duplicate');
  const touched = syncFriendNamesFromMutual(acc, [
    { name: 'Duplicate', uid: '9101' },
    { name: 'Duplicate', uid: '9102' },
  ]);
  assert.ok(touched.conflicts >= 1);
  assert.equal(repos.getFriendByName(acc.id, 'Duplicate').userid || '', '');
});

test('the same UID in following and follower lists still backfills a unique nickname', () => {
  repos.addFriend(acc.id, 'MutualName');
  const touched = syncFriendNamesFromMutual(acc, [
    { name: 'MutualName', uid: '9201' },
    { name: 'MutualName', uid: '9201' },
  ]);
  assert.equal(touched.linked, 1);
  assert.equal(repos.getFriendByName(acc.id, 'MutualName').userid, '9201');
});

test('apiSession can send by UID even when the captured name is stale', () => {
  const session = {
    friend: 'OldName',
    createTemplate: { bodyB64: 'ZmFrZQ==' },
    friends: [{ name: 'OldName', userid: '9009' }],
  };
  assert.equal(apiSession.canSendTo(session, 'OldName'), true);
  assert.equal(apiSession.canSendTo(session, 'NewName'), false);
  assert.equal(apiSession.canSendToUid(session, '9009'), true);
  assert.equal(apiSession.canSendToUid(session, '9999'), false);
  assert.equal(apiSession.canSendToUid(session, ''), false);
});
