import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import Menu from '../models/menu.js';
import Ingredient from '../models/ingredients.js';
import Seasoning from '../models/seasonings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/finance';

const numberOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const boolVal = (v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null || v === undefined) return false;
  const s = String(v).trim().toLowerCase();
  return ['1', 'true', 't', 'yes', 'y', 'on'].includes(s);
};
const splitList = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean).map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(/[,、]/).map((x) => x.trim()).filter(Boolean);
};
const parseDateVal = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') {
    const epoch = new Date(Math.round((v - 25569) * 86400 * 1000));
    return Number.isNaN(epoch.getTime()) ? null : epoch;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const parseUnitConversions = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) { /* fall through */ }
  }
  return [];
};

const loadSheet = async (filename) => {
  const workbook = new ExcelJS.Workbook();
  const filePath = path.join(__dirname, filename);
  await workbook.xlsx.readFile(filePath);
  const ws = workbook.worksheets[0];
  if (!ws) throw new Error(`Worksheet not found in ${filename}`);
  const headerRow = ws.getRow(1);
  const headerMap = new Map();
  headerRow.eachCell((cell, col) => {
    const key = (cell?.value ?? '').toString().trim();
    if (key) headerMap.set(key, col);
  });
  const rows = [];
  ws.eachRow((row, idx) => {
    if (idx === 1) return;
    rows.push(row);
  });
  const val = (row, key) => {
    const col = headerMap.get(key);
    if (!col) return null;
    const cell = row.getCell(col);
    const v = cell?.value;
    if (v && typeof v === 'object' && 'text' in v && v.text) return v.text;
    return v;
  };
  return { rows, val };
};

const buildIngredientMapKey = (name) => (name ? String(name).trim().toLowerCase() : '');

async function importIngredients() {
  const { rows, val } = await loadSheet('ingredients.xlsx');
  console.log(`読み込み: ingredients.xlsx (${rows.length} 行)`);
  await Ingredient.deleteMany({});
  const docs = rows.map((row) => ({
    classification: val(row, '分類') || '',
    ingredient: val(row, '食材名') || '',
    yomi: val(row, 'よみ') || '',
    energy: numberOrNull(val(row, 'エネルギー')),
    water: numberOrNull(val(row, '水分')),
    protein: numberOrNull(val(row, 'たんぱく質')),
    lipid: numberOrNull(val(row, '脂質')),
    carbohydrate: numberOrNull(val(row, '炭水化物')),
    unit: splitList(val(row, '単位')),
    unitConversions: parseUnitConversions(val(row, '単位換算')),
    wikiUrl: val(row, 'Wiki URL') || '',
    imageUrl: val(row, '画像URL') || '',
    comment: val(row, 'コメント') || '',
    favorite: boolVal(val(row, 'お気に入り')),
    season: splitList(val(row, '旬な季節')),
    month: splitList(val(row, '旬な月')),
    entry_date: parseDateVal(val(row, '登録日')),
    update_date: parseDateVal(val(row, '更新日')),
    used_date: parseDateVal(val(row, '最終使用日')),
    group: val(row, 'グループID') || null,
    createdBy: val(row, '登録者ID') || null
  })).filter((d) => d.ingredient);
  const inserted = await Ingredient.insertMany(docs, { ordered: false });
  const map = new Map();
  inserted.forEach((doc) => {
    const key = buildIngredientMapKey(doc.ingredient);
    if (key) map.set(key, doc._id.toString());
  });
  console.log(`✅ 食材インポート ${inserted.length} 件`);
  return map;
}

async function importSeasonings() {
  const { rows, val } = await loadSheet('seasonings.xlsx');
  console.log(`読み込み: seasonings.xlsx (${rows.length} 行)`);
  await Seasoning.deleteMany({});
  const docs = rows.map((row) => ({
    classification: val(row, '分類') || '',
    seasoning: val(row, '調味料名') || '',
    yomi: val(row, 'よみ') || '',
    energy: numberOrNull(val(row, 'エネルギー')),
    water: numberOrNull(val(row, '水分')),
    protein: numberOrNull(val(row, 'たんぱく質')),
    lipid: numberOrNull(val(row, '脂質')),
    carbohydrate: numberOrNull(val(row, '炭水化物')),
    unit: splitList(val(row, '単位')),
    unitConversions: parseUnitConversions(val(row, '単位換算')),
    wikiUrl: val(row, 'Wiki URL') || '',
    imageUrl: val(row, '画像URL') || '',
    comment: val(row, 'コメント') || '',
    favorite: boolVal(val(row, 'お気に入り')),
    entry_date: parseDateVal(val(row, '登録日')),
    update_date: parseDateVal(val(row, '更新日')),
    used_date: parseDateVal(val(row, '最終使用日')),
    group: val(row, 'グループID') || null,
    createdBy: val(row, '登録者ID') || null
  })).filter((d) => d.seasoning);
  const inserted = await Seasoning.insertMany(docs, { ordered: false });
  const map = new Map();
  inserted.forEach((doc) => {
    const key = buildIngredientMapKey(doc.seasoning);
    if (key) map.set(key, doc._id.toString());
  });
  console.log(`✅ 調味料インポート ${inserted.length} 件`);
  return map;
}

const ensureIngredientByName = async (name, ingredientMap) => {
  const key = buildIngredientMapKey(name);
  if (!key) return null;
  if (ingredientMap.has(key)) return ingredientMap.get(key);
  const created = await Ingredient.create({
    ingredient: name,
    classification: 'その他'
  });
  ingredientMap.set(key, created._id.toString());
  return created._id.toString();
};

const ensureSeasoningByName = async (name, seasoningMap) => {
  const key = buildIngredientMapKey(name);
  if (!key) return null;
  if (seasoningMap.has(key)) return seasoningMap.get(key);
  const created = await Seasoning.create({
    seasoning: name,
    classification: 'その他'
  });
  seasoningMap.set(key, created._id.toString());
  return created._id.toString();
};

const parseIngredientJson = (text) => {
  if (!text) return [];
  if (Array.isArray(text)) return text;
  try {
    return JSON.parse(text);
  } catch (_) {
    return [];
  }
};

async function importMenus(ingredientMap, seasoningMap) {
  const { rows, val } = await loadSheet('menus.xlsx');
  console.log(`読み込み: menus.xlsx (${rows.length} 行)`);
  await Menu.deleteMany({});
  const docs = [];
  for (const row of rows) {
    const ingredientsText = val(row, '食材');
    const seasoningText = val(row, '調味料');
    const rawIngredients = parseIngredientJson(ingredientsText);
    const rawSeasonings = parseIngredientJson(seasoningText);
    const ingredients = [];
    for (const item of rawIngredients) {
      const name = item?.name || '';
      if (!name) continue;
      const id = await ensureIngredientByName(name, ingredientMap);
      if (!id) continue;
      const amount = numberOrNull(item.amount);
      ingredients.push({
        name: id,
        amount,
        unit: item.unit || ''
      });
    }
    const seasoning = [];
    for (const item of rawSeasonings) {
      const name = item?.name || '';
      if (!name) continue;
      const id = await ensureSeasoningByName(name, seasoningMap);
      if (!id) continue;
      const amount = numberOrNull(item.amount);
      seasoning.push({
        name: id,
        amount,
        unit: item.unit || ''
      });
    }
    const peopleVal = numberOrNull(val(row, '人数')) || 1;
    docs.push({
      name: val(row, 'メニュー名') || '',
      yomi: val(row, 'よみ') || '',
      kind: val(row, '種類') || '',
      menu: val(row, 'メニュー内容') || '',
      junle: val(row, 'ジャンル') || '',
      cook: val(row, '調理法') || '',
      url: val(row, 'URL') || '',
      imageUrl: val(row, '画像URL') || '',
      time: val(row, '時間') || '',
      people: peopleVal,
      material: boolVal(val(row, '素材フラグ')),
      isPrivate: boolVal(val(row, '非公開フラグ')),
      comment: val(row, 'コメント') || '',
      instructionText: val(row, '作り方テキスト') || '',
      ingredients,
      seasoning,
      share: boolVal(val(row, '共有')),
      entry_date: parseDateVal(val(row, '登録日')),
      update_date: parseDateVal(val(row, '更新日'))
    });
  }
  const filtered = docs.filter((d) => d.name && d.kind && d.junle && d.cook);
  await Menu.insertMany(filtered, { ordered: false });
  console.log(`✅ メニューインポート ${filtered.length} 件`);
}

async function main() {
  await mongoose.connect(mongoURI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });
  console.log(`MongoDB 接続: ${mongoURI}`);
  try {
    const ingredientMap = await importIngredients();
    const seasoningMap = await importSeasonings();
    await importMenus(ingredientMap, seasoningMap);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('インポートエラー', err);
  process.exitCode = 1;
});
