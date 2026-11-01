'use strict';

function stableStringify(value) {
  return JSON.stringify(value, (key, val) => (val && typeof val === 'object' && !Array.isArray(val))
    ? Object.keys(val).sort().reduce((sorted, k) => { sorted[k] = val[k]; return sorted; }, {})
    : val);
}

// Write only the products that changed (and remove the ones that disappeared), in batches that stay
// under Firestore's 500-operation limit. `productsCollection` and `db` are Firestore handles.
async function syncProducts({ db, productsCollection, items, batchSize = 400 }) {
  const existing = await productsCollection.get();
  const existingById = new Map(existing.docs.map(doc => [doc.id, doc]));
  const nextIds = new Set(items.map(item => item.id));
  const operations = [];
  existing.docs.forEach(doc => {
    if (!nextIds.has(doc.id)) operations.push(batch => batch.delete(doc.ref));
  });
  items.forEach(item => {
    const { id, ...data } = item;
    const current = existingById.get(id);
    if (current && stableStringify(current.data()) === stableStringify(data)) return;
    operations.push(batch => batch.set(productsCollection.doc(id), data));
  });
  for (let start = 0; start < operations.length; start += batchSize) {
    const batch = db.batch();
    operations.slice(start, start + batchSize).forEach(apply => apply(batch));
    await batch.commit();
  }
  return operations.length;
}

module.exports = { stableStringify, syncProducts };
