'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('./docs/security.js');

test('data blobs: round-trip, wrong PIN, swapped name all fail closed', async () => {
  const salt = S.newSalt();
  const key = await S.deriveDataKey('4821', salt);
  const blob = await S.encryptJson(key, 'jenni_chat_v1', [{ text: 'secret' }]);
  assert.ok(!JSON.stringify(blob).includes('secret'));
  assert.deepEqual(await S.decryptJson(key, 'jenni_chat_v1', blob), [{ text: 'secret' }]);
  await assert.rejects(S.decryptJson(await S.deriveDataKey('0000', salt), 'jenni_chat_v1', blob));
  await assert.rejects(S.decryptJson(key, 'jenni_memory_v1', blob));   // AAD binds the storage name
  const again = await S.encryptJson(key, 'jenni_chat_v1', [{ text: 'secret' }]);
  assert.notEqual(again.iv, blob.iv);                                  // fresh IV per write
});
