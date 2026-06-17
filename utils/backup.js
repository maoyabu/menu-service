import archiver from 'archiver';
import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// すべてのモデルをインポート
import AdminLog from '../models/adminLog.js';
import CustomEquipmentPreset from '../models/customEquipmentPreset.js';
import Equipment from '../models/equipment.js';
import EquipmentInventoryReminder from '../models/equipmentInventoryReminder.js';
import FoodGuideline from '../models/foodGuideline.js';
import Group from '../models/groups.js';
import Ingredient from '../models/ingredients.js';
import Inquiry from '../models/inquiry.js';
import MailTemplateSetting from '../models/mailTemplateSetting.js';
import Menu from '../models/menu.js';
import MenuDo from '../models/menuDo.js';
import MenuApiConfig from '../models/menu_api_config.js';
import MonthlyStockReminder from '../models/monthlyStockReminder.js';
import MyEquipment from '../models/myEquipment.js';
import MyMenu from '../models/mymenu.js';
import Notice from '../models/notice.js';
import Notification from '../models/notification.js';
import PackingEvent from '../models/packingEvent.js';
import PackingItem from '../models/packingItem.js';
import PackingMasterItem from '../models/packingMasterItem.js';
import PackingStorage from '../models/packingStorage.js';
import PublicInquiry from '../models/publicInquiry.js';
import PurchaseReminderHistory from '../models/purchaseReminderHistory.js';
import PurchaseReminderLog from '../models/purchaseReminderLog.js';
import Qa from '../models/qa.js';
import SearchLog from '../models/searchLog.js';
import Seasoning from '../models/seasonings.js';
import ShoppingListState from '../models/shoppingListState.js';
import Stock from '../models/stock.js';
import StoragePlace from '../models/storagePlace.js';
import SupportFaq from '../models/supportFaq.js';
import SupportInquiry from '../models/supportInquiry.js';
import Task from '../models/task.js';
import User from '../models/users.js';
import WeeklyAnnouncement from '../models/weeklyAnnouncement.js';
import WeeklyMenuPlan from '../models/weeklyMenuPlan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = path.join(__dirname, '..', 'temp');

// Create temp directory if it doesn't exist
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// すべてのモデルのマッピング
const MODELS = {
  'AdminLog': AdminLog,
  'CustomEquipmentPreset': CustomEquipmentPreset,
  'Equipment': Equipment,
  'EquipmentInventoryReminder': EquipmentInventoryReminder,
  'FoodGuideline': FoodGuideline,
  'Group': Group,
  'Ingredient': Ingredient,
  'Inquiry': Inquiry,
  'MailTemplateSetting': MailTemplateSetting,
  'Menu': Menu,
  'MenuDo': MenuDo,
  'MenuApiConfig': MenuApiConfig,
  'MonthlyStockReminder': MonthlyStockReminder,
  'MyEquipment': MyEquipment,
  'MyMenu': MyMenu,
  'Notice': Notice,
  'Notification': Notification,
  'PackingEvent': PackingEvent,
  'PackingItem': PackingItem,
  'PackingMasterItem': PackingMasterItem,
  'PackingStorage': PackingStorage,
  'PublicInquiry': PublicInquiry,
  'PurchaseReminderHistory': PurchaseReminderHistory,
  'PurchaseReminderLog': PurchaseReminderLog,
  'Qa': Qa,
  'SearchLog': SearchLog,
  'Seasoning': Seasoning,
  'ShoppingListState': ShoppingListState,
  'Stock': Stock,
  'StoragePlace': StoragePlace,
  'SupportFaq': SupportFaq,
  'SupportInquiry': SupportInquiry,
  'Task': Task,
  'User': User,
  'WeeklyAnnouncement': WeeklyAnnouncement,
  'WeeklyMenuPlan': WeeklyMenuPlan
};

/**
 * バックアップファイルを作成してダウンロード
 */
export async function createBackupFile() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const backupDir = path.join(TEMP_DIR, `backup-${timestamp}`);
  const zipPath = path.join(TEMP_DIR, `backup-${timestamp}.zip`);

  console.log(`[Backup] Starting backup: ${zipPath}`);

  // Create backup directory
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
    console.log(`[Backup] Created directory: ${backupDir}`);
  }

  try {
    // Export all collections to JSON files and collect report data
    let exportedCount = 0;
    const reportData = {
      createdAt: new Date().toISOString(),
      collections: []
    };
    let totalRecords = 0;

    for (const [modelName, Model] of Object.entries(MODELS)) {
      try {
        const data = await Model.find({}).lean().exec();
        const filePath = path.join(backupDir, `${modelName}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        console.log(`[Backup] Exported ${modelName}: ${data.length} records`);
        
        // Add to report data
        reportData.collections.push({
          name: modelName,
          recordCount: data.length
        });
        totalRecords += data.length;
        exportedCount++;
      } catch (err) {
        console.error(`[Backup] Error exporting ${modelName}:`, err.message);
        // Continue with other models if one fails
      }
    }

    reportData.totalRecords = totalRecords;
    reportData.collectionCount = reportData.collections.length;

    console.log(`[Backup] Total collections exported: ${exportedCount}/${Object.keys(MODELS).length}`);

    // Generate HTML report
    console.log(`[Backup] Generating report...`);
    const htmlReport = generateHtmlReport(reportData);
    const reportPath = path.join(backupDir, 'BACKUP_REPORT.html');
    fs.writeFileSync(reportPath, htmlReport);
    console.log(`[Backup] Report generated: BACKUP_REPORT.html`);

    // Create zip file using adm-zip
    console.log(`[Backup] Creating zip file...`);
    const zip = new AdmZip();
    const files = fs.readdirSync(backupDir);
    
    console.log(`[Backup] Files to zip: ${files.length}`);
    for (const file of files) {
      const filePath = path.join(backupDir, file);
      if (fs.statSync(filePath).isFile()) {
        zip.addLocalFile(filePath, '');
        console.log(`[Backup] Added to zip: ${file}`);
      }
    }

    // Write zip file
    zip.writeZip(zipPath);
    console.log(`[Backup] Zip file created: ${zipPath}`);

    // Verify zip file was created
    if (!fs.existsSync(zipPath)) {
      throw new Error(`Zip file was not created at ${zipPath}`);
    }

    const zipStats = fs.statSync(zipPath);
    console.log(`[Backup] Zip file size: ${zipStats.size} bytes`);

    // Clean up backup directory after zipping
    fs.rmSync(backupDir, { recursive: true, force: true });
    console.log(`[Backup] Cleaned up backup directory`);

    return zipPath;
  } catch (err) {
    console.error('[Backup] Error during backup:', err);
    // Clean up on error
    if (fs.existsSync(backupDir)) {
      fs.rmSync(backupDir, { recursive: true, force: true });
    }
    throw err;
  }
}

/**
 * バックアップファイルのデータを取得
 */
export async function parseBackupFile(filePath) {
  const backupData = {};
  
  try {
    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();

    for (const entry of zipEntries) {
      if (!entry.isDirectory && entry.entryName.endsWith('.json')) {
        const fileName = path.basename(entry.entryName, '.json');
        const data = entry.getData().toString('utf8');
        try {
          backupData[fileName] = JSON.parse(data);
        } catch (err) {
          console.error(`Error parsing ${entry.entryName}:`, err);
        }
      }
    }

    return backupData;
  } catch (err) {
    throw new Error(`Failed to parse backup file: ${err.message}`);
  }
}

/**
 * バックアップからのリストア
 */
export async function restoreFromBackup(backupData) {
  const results = {
    success: [],
    failed: []
  };

  for (const [modelName, data] of Object.entries(backupData)) {
    if (!MODELS[modelName]) {
      results.failed.push({ collection: modelName, reason: 'Unknown model' });
      continue;
    }

    try {
      const Model = MODELS[modelName];
      
      // Clear existing data
      await Model.deleteMany({});
      
      // Insert new data
      if (Array.isArray(data) && data.length > 0) {
        await Model.insertMany(data, { ordered: false }).catch(err => {
          // Continue even if some documents fail to insert
          console.warn(`Warning inserting into ${modelName}:`, err.message);
        });
      }
      
      results.success.push({ collection: modelName, count: data.length });
    } catch (err) {
      results.failed.push({ 
        collection: modelName, 
        reason: err.message 
      });
    }
  }

  return results;
}

/**
 * HTMLレポートを生成
 */
function generateHtmlReport(reportData) {
  const { createdAt, collections, totalRecords, collectionCount } = reportData;
  const date = new Date(createdAt);
  const formattedDate = date.toLocaleString('ja-JP');

  const tableRows = collections
    .map(col => `
    <tr>
      <td class="table-cell">${col.name}</td>
      <td class="table-cell right-align">${col.recordCount.toLocaleString()}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>バックアップレポート</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: "Segoe UI", "Yu Gothic", system-ui, sans-serif;
      background-color: #f5f5f5;
      color: #333;
      padding: 20px;
    }
    
    .container {
      max-width: 900px;
      margin: 0 auto;
      background-color: white;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    
    .header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 40px 30px;
      text-align: center;
    }
    
    .header h1 {
      font-size: 32px;
      margin-bottom: 10px;
    }
    
    .header p {
      font-size: 14px;
      opacity: 0.9;
    }
    
    .content {
      padding: 30px;
    }
    
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    
    .summary-card {
      background-color: #f8f9fa;
      border-left: 4px solid #667eea;
      padding: 20px;
      border-radius: 4px;
    }
    
    .summary-card label {
      display: block;
      font-size: 12px;
      color: #666;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .summary-card .value {
      font-size: 28px;
      font-weight: bold;
      color: #667eea;
    }
    
    .table-section {
      margin-top: 30px;
    }
    
    .table-section h2 {
      font-size: 18px;
      margin-bottom: 15px;
      color: #333;
      border-bottom: 2px solid #667eea;
      padding-bottom: 10px;
    }
    
    .table-wrapper {
      overflow-x: auto;
      border-radius: 4px;
      border: 1px solid #ddd;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
    }
    
    thead {
      background-color: #f8f9fa;
    }
    
    th {
      padding: 12px;
      text-align: left;
      font-weight: 600;
      color: #333;
      border-bottom: 2px solid #ddd;
    }
    
    .table-cell {
      padding: 12px;
      border-bottom: 1px solid #eee;
    }
    
    tbody tr:hover {
      background-color: #f9f9f9;
    }
    
    .right-align {
      text-align: right;
      font-weight: 500;
      color: #667eea;
    }
    
    .footer {
      background-color: #f8f9fa;
      padding: 20px 30px;
      text-align: center;
      color: #666;
      font-size: 12px;
      border-top: 1px solid #ddd;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 バックアップレポート</h1>
      <p>システム全体のデータバックアップが正常に完了しました</p>
    </div>
    
    <div class="content">
      <div class="summary">
        <div class="summary-card">
          <label>作成日時</label>
          <div class="value">${formattedDate}</div>
        </div>
        <div class="summary-card">
          <label>テーブル数</label>
          <div class="value">${collectionCount}</div>
        </div>
        <div class="summary-card">
          <label>総レコード数</label>
          <div class="value">${totalRecords.toLocaleString()}</div>
        </div>
      </div>
      
      <div class="table-section">
        <h2>📋 バックアップ内容</h2>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>テーブル名</th>
                <th style="text-align: right;">レコード数</th>
              </tr>
            </thead>
            <tbody>
              ${tableRows}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    
    <div class="footer">
      <p>このレポートは自動生成されたものです。バックアップファイル内に保存されています。</p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * 一時ファイルをクリーンアップ
 */
export function cleanupTempFiles(olderThanMinutes = 60) {
  try {
    if (!fs.existsSync(TEMP_DIR)) return;

    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    const maxAge = olderThanMinutes * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > maxAge) {
        if (stats.isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(filePath);
        }
      }
    }
  } catch (err) {
    console.error('Error cleaning up temp files:', err);
  }
}

export default {
  createBackupFile,
  parseBackupFile,
  restoreFromBackup,
  cleanupTempFiles
};
