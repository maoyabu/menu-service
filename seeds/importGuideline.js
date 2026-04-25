import mongoose from 'mongoose';
import fs from 'fs';
import path, { dirname } from 'path';
import csv from 'csv-parser';
import { fileURLToPath } from 'url';
import FoodGuideline from '../models/foodGuideline.js';

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

function normalizeSex(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  if (raw === '男' || raw === '男性') return '男';
  if (raw === '女' || raw === '女性') return '女';
  if (raw.includes('男')) return '男';
  if (raw.includes('女')) return '女';
  const lower = raw.toLowerCase();
  if (lower.startsWith('m')) return '男';
  if (lower.startsWith('f')) return '女';
  return '';
}

function parseAgeRange(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return null;
  const cleaned = raw
    .replace(/[歳]/g, '')
    .replace(/[〜~－–—]/g, '-')
    .replace(/[，]/g, ',')
    .replace(/\s+/g, '');
  let start = null;
  let end = null;
  if (cleaned.endsWith('-')) {
    start = Number(cleaned.slice(0, -1));
    end = null;
  } else if (cleaned.includes('-')) {
    const [a, b] = cleaned.split('-', 2);
    start = Number(a);
    end = Number(b);
  } else if (cleaned.includes(',')) {
    const [a, b] = cleaned.split(',', 2);
    start = Number(a);
    end = Number(b);
  } else {
    start = Number(cleaned);
    end = Number(cleaned);
  }
  if (!Number.isFinite(start) || (end !== null && !Number.isFinite(end))) return null;
  if (end !== null && end < start) return null;
  return { start, end };
}

async function importGuideline() {
  await mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });
  const csvPath = path.join(__dirname, 'guideline.csv');
  const rows = await readCSV(csvPath);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const ageRange = row['年齢'] || row['年齢範囲'] || row['age'] || '';
    const parsed = parseAgeRange(ageRange);
    if (!parsed) { skipped += 1; continue; }

    const sex = normalizeSex(row['性別'] || row['sex'] || '');
    const classification = String(row['分類'] || row['分類名'] || row['class'] || '').trim();
    const requiredGrams = Number(row['必要量'] || row['必要量(g)'] || row['required'] || 0);
    if (!classification) { skipped += 1; continue; }

    const doc = {
      ageStart: parsed.start,
      ageEnd: parsed.end,
      sex,
      classification,
      requiredGrams: Number.isFinite(requiredGrams) ? requiredGrams : 0
    };

    const res = await FoodGuideline.findOneAndUpdate(
      {
        ageStart: doc.ageStart,
        ageEnd: doc.ageEnd,
        sex: doc.sex,
        classification: doc.classification
      },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true, rawResult: true }
    );
    if (res?.lastErrorObject?.updatedExisting) updated += 1; else inserted += 1;
  }

  console.log(`✅ Guideline import done. inserted=${inserted}, updated=${updated}, skipped=${skipped}`);
  await mongoose.disconnect();
}

importGuideline().catch(async (err) => {
  console.error('Guideline import failed:', err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
