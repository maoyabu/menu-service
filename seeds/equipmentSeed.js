import mongoose from 'mongoose';
import fs from 'fs';
import path, { dirname } from 'path';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';
import Equipment from '../models/equipment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/finance';

function readCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv({ mapHeaders: ({ header }) => (header || '').replace(/^\uFEFF/, '') }))
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (err) => reject(err));
  });
}

function toBool(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  const t = v.toLowerCase();
  return ['1','true','yes','y','on','消耗品','はい'].includes(t);
}

function cleanStr(v) {
  return String(v || '').trim();
}

async function seedEquipment() {
  await mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });
  const csvPath = path.join(__dirname, 'equipment.csv');
  const rows = await readCSV(csvPath);

  let inserted = 0;
  let updated = 0;

  for (const row of rows) {
    const doc = {
      name: cleanStr(row['備品名']),
      isConsumable: toBool(row['消耗品']),
      houseCategory: cleanStr(row['家ストック分類']),
      disasterCategory: cleanStr(row['防災対策分類']),
      campingCategory: cleanStr(row['キャンプ分類']),
      maintenance: cleanStr(row['メンテナンス'])
    };
    if (!doc.name) continue;

    const res = await Equipment.findOneAndUpdate(
      { name: doc.name },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true, rawResult: true }
    );
    if (res?.lastErrorObject?.updatedExisting) updated += 1; else inserted += 1;
  }

  console.log(`✅ Equipment seed done. inserted=${inserted}, updated=${updated}`);
  await mongoose.disconnect();
}

seedEquipment().catch(async (err) => {
  console.error('Equipment seed failed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});

