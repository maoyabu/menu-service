import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import ExcelJS from 'exceljs';
import mongoose from 'mongoose';
import User from '../models/users.js';
import Group from '../models/groups.js';
import Ingredient from '../models/ingredients.js';
import Seasoning from '../models/seasonings.js';
import StoragePlace from '../models/storagePlace.js';
import MyEquipment from '../models/myEquipment.js';
import Stock from '../models/stock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/finance';
const PREFERRED_USER_ID = '67fee14baec9e540985a7c49';
const PREFERRED_GROUP_ID = '67fee15caec9e540985a7c57';

const boolVal = (v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return ['1','true','t','yes','y','on','はい'].includes(s);
};
const numberOrZero = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const parseDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') {
    const epoch = new Date(Math.round((v - 25569) * 86400 * 1000));
    return Number.isNaN(epoch.getTime()) ? null : epoch;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

async function loadSheet(filename) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(__dirname, filename));
  const ws = workbook.worksheets[0];
  const headers = new Map();
  ws.getRow(1).eachCell((cell, col) => {
    const key = (cell?.value ?? '').toString().trim();
    if (key) headers.set(key, col);
  });
  const rows = [];
  ws.eachRow((row, idx) => { if (idx > 1) rows.push(row); });
  const val = (row, key) => {
    const col = headers.get(key);
    if (!col) return '';
    const v = row.getCell(col)?.value;
    if (v && typeof v === 'object' && 'text' in v) return v.text;
    return v ?? '';
  };
  return { rows, val };
}

async function ensureUser(name) {
  const preferred = await User.findById(PREFERRED_USER_ID).lean();
  if (preferred) return preferred._id;
  const firstUser = await User.findOne().lean();
  if (!name) return firstUser?._id;
  const user = await User.findOne({ $or: [ { displayname: name }, { username: name } ] }).lean();
  return (user?._id) || (firstUser?._id) || null;
}

async function ensureGroup(name, ownerId) {
  // Prefer fixed group ID if exists
  const preferred = await Group.findById(PREFERRED_GROUP_ID).lean();
  if (preferred) return preferred._id;
  if (!name) return null;
  let g = await Group.findOne({ group_name: name }).lean();
  if (g) return g._id;
  const createdBy = ownerId || (await ensureUser(''));
  if (!createdBy) return null;
  g = await Group.create({ _id: PREFERRED_GROUP_ID, group_name: name, createdBy, members: [createdBy] });
  return g._id;
}

async function ensurePlace(groupId, name, userId) {
  if (!groupId || !name) return null;
  let place = await StoragePlace.findOne({ group: groupId, name }).lean();
  if (place) return place._id;
  place = await StoragePlace.create({ group: groupId, name, createdBy: userId });
  return place._id;
}

async function buildItemMaps() {
  const ingredients = await Ingredient.find().select('ingredient').lean();
  const seasonings = await Seasoning.find().select('seasoning').lean();
  const ingMap = new Map(ingredients.map((i) => [String(i.ingredient).trim(), i._id]));
  const seaMap = new Map(seasonings.map((s) => [String(s.seasoning).trim(), s._id]));
  return { ingMap, seaMap };
}

async function importMyStock() {
  const { rows, val } = await loadSheet('my-stock.xlsx');
  const { ingMap, seaMap } = await buildItemMaps();
  await Stock.deleteMany({});
  for (const row of rows) {
    const type = String(val(row, '種類') || val(row, 'type') || '').trim();
    const itemName = val(row, 'アイテム名') || val(row, 'itemName');
    const groupName = val(row, 'グループ') || val(row, 'group');
    const userName = val(row, 'ユーザー') || val(row, 'user');
    const amount = numberOrZero(val(row, '数量') || val(row, 'amount'));
    const unit = val(row, '単位') || val(row, 'unit') || '';
    const placeName = val(row, '保管場所') || val(row, 'place') || '';
    const expiryDate = parseDate(val(row, '賞味期限') || val(row, 'expiryDate'));
    const stockpile = boolVal(val(row, '備蓄品') || val(row, 'stockpile'));
    const productUrl = val(row, '商品URL') || val(row, 'productUrl') || '';
    const productImageUrl = val(row, '画像URL') || val(row, 'productImageUrl') || '';
    const comment = val(row, 'コメント') || val(row, 'comment') || '';
    const lastCheckedAt = parseDate(val(row, '最終チェック日時') || val(row, 'lastCheckedAt'));
    const lastCheckedNote = val(row, '最終チェックメモ') || val(row, 'lastCheckedNote') || '';
    const lastCheckedBy = val(row, '最終チェック実施者') || val(row, 'lastCheckedBy') || '';

    const userId = await ensureUser(userName);
    const groupId = await ensureGroup(groupName, userId);
    const placeId = await ensurePlace(groupId, placeName, userId);

    let item = null;
    if (type === 'ingredient') {
      item = ingMap.get(String(itemName).trim());
    } else if (type === 'seasoning') {
      item = seaMap.get(String(itemName).trim());
    }
    if (!item) continue; // skip unknown item

    await Stock.create({
      type,
      item,
      typeRef: type === 'ingredient' ? 'Ingredient' : 'Seasoning',
      amount,
      unit,
      place: placeId,
      expiryDate,
      stockpile,
      productUrl,
      productImageUrl,
      comment,
      lastCheckedAt,
      lastCheckedNote,
      lastCheckedBy,
      user: userId,
      group: groupId
    });
  }
  console.log(`✅ MyStock import 完了 (${rows.length} 行処理)`);
}

async function importMyEquipment() {
  const { rows, val } = await loadSheet('my-equipment.xlsx');
  await MyEquipment.deleteMany({});
  for (const row of rows) {
    const groupName = val(row, 'グループ') || val(row, 'group');
    const userName = val(row, '登録者') || val(row, 'user');
    const name = val(row, '備品名') || val(row, 'name');
    if (!name) continue;
    const quantity = numberOrZero(val(row, '数量') || val(row, 'quantity'));
    const unit = val(row, '単位') || val(row, 'unit') || '';
    const placeName = val(row, '保管場所') || val(row, 'place') || '';
    const isConsumable = boolVal(val(row, '消耗品') || val(row, 'isConsumable'));
    const houseCategory = val(row, '家ストック分類') || val(row, 'houseCategory') || '';
    const disasterCategory = val(row, '防災対策分類') || val(row, 'disasterCategory') || '';
    const campingCategory = val(row, 'キャンプ分類') || val(row, 'campingCategory') || '';
    const maintenance = val(row, 'メンテナンス周期') || val(row, 'maintenance') || '';
    const productUrl = val(row, '商品URL') || val(row, 'productUrl') || '';
    const productImageUrl = val(row, '画像URL') || val(row, 'productImageUrl') || '';
    const comment = val(row, 'コメント') || val(row, 'comment') || '';
    const expiryDate = parseDate(val(row, '消費期限') || val(row, 'expiryDate'));
    const lastInventoryAt = parseDate(val(row, '棚卸し日時') || val(row, 'lastInventoryAt'));
    const lastInventoryBy = null; // 名前のみのため未設定
    const lastCount = numberOrZero(val(row, '棚卸し数量') || val(row, 'lastCount'));
    const lastComment = val(row, '棚卸しコメント') || val(row, 'lastComment') || '';

    const userId = await ensureUser(userName);
    const groupId = await ensureGroup(groupName, userId);
    const placeId = await ensurePlace(groupId, placeName, userId);

    await MyEquipment.create({
      group: groupId,
      createdBy: userId,
      name,
      quantity,
      unit,
      place: placeId,
      isConsumable,
      houseCategory,
      disasterCategory,
      campingCategory,
      maintenance,
      productUrl,
      productImageUrl,
      comment,
      expiryDate,
      lastInventoryAt,
      lastInventoryBy,
      lastCount,
      lastComment,
      tracked: true
    });
  }
  console.log(`✅ MyEquipment import 完了 (${rows.length} 行処理)`);
}

async function main(){
  await mongoose.connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log(`MongoDB 接続: ${mongoURI}`);
  try {
    await importMyStock();
    await importMyEquipment();
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('インポートエラー', err);
  process.exitCode = 1;
});
