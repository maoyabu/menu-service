import mongoose from 'mongoose';
import fs from 'fs';
import path, { dirname } from 'path';
import csv from 'csv-parser';
import Ingredient from '../models/ingredients.js';
import Seasoning from '../models/seasonings.js';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const mongoURI = process.env.MONGODB_URI || 'mongodb://localhost:27017/finance';

async function readCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (err) => reject(err));
  });
}

async function seedDatabase() {
  await mongoose.connect(mongoURI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  const ingredientCSV = path.join(__dirname, 'ingredient.csv');
  const seasoningCSV = path.join(__dirname, 'seasoning.csv');

  const ingredients = await readCSV(ingredientCSV);
  const seasonings = await readCSV(seasoningCSV);

// Ingredient insertion
const ingredientDocs = ingredients.map(row => ({
  classification: row['classification'],
  ingredient: row['ingredient'],
  yomi: row['yomi'],
  energy: parseFloat(row['energy']) || null,
  water: parseFloat(row['water']) || null,
  protein: parseFloat(row['protein']) || null,
  lipid: parseFloat(row['lipid']) || null,
  carbohydrate: parseFloat(row['carbohydrate']) || null,
  unit: row['unit']?.trim() ? row['unit'].split(',') : []
}));

const seasoningDocs = seasonings.map(row => ({
  classification: row['classification'],
  seasoning: row['seasoning'],
  yomi: row['yomi'],
  energy: parseFloat(row['energy']) || null,
  water: parseFloat(row['water']) || null,
  protein: parseFloat(row['protein']) || null,
  lipid: parseFloat(row['lipid']) || null,
  carbohydrate: parseFloat(row['carbohydrate']) || null,
  unit: row['unit']?.trim() ? row['unit'].split(',') : []
}));

  await Ingredient.deleteMany({});
  await Ingredient.insertMany(ingredientDocs);

  await Seasoning.deleteMany({});
  await Seasoning.insertMany(seasoningDocs);

  console.log('✅ Ingredients and Seasonings seeded.');
  await mongoose.disconnect();
}

seedDatabase();