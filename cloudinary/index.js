import dotenv from 'dotenv';
import multer from 'multer';
import { createRequire } from 'module';

dotenv.config();

const isCloudinaryDisabled = process.env.CLOUDINARY_DISABLE === 'true';

const require = createRequire(import.meta.url);
let cloudinary = null;
let storage = null;
let CloudinaryStorage = null;

function initCloudinary() {
  if (cloudinary || isCloudinaryDisabled) return;
  try {
    CloudinaryStorage = require('multer-storage-cloudinary').CloudinaryStorage;
    cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_KEY,
      api_secret: process.env.CLOUDINARY_SECRET
    });
  } catch (err) {
    console.error('🔥 Cloudinary 初期化エラー: ', err);
    cloudinary = null;
  }
}

function getStorage() {
  if (storage) return storage;
  if (isCloudinaryDisabled) {
    console.warn('⚠️ CLOUDINARY_DISABLE=true のため Cloudinary を無効化し、メモリストレージを使用します。');
    storage = multer.memoryStorage();
    return storage;
  }

  initCloudinary();
  if (cloudinary && CloudinaryStorage) {
    try {
      storage = new CloudinaryStorage({
        cloudinary,
        params: {
          folder: 'PackingPlan_Profile',
          allowed_formats: ['jpeg', 'png', 'jpg']
        }
      });
      return storage;
    } catch (err) {
      console.error('🔥 CloudinaryStorage 設定エラー:', err);
    }
  }

  storage = multer.memoryStorage();
  return storage;
}

export { cloudinary, getStorage };
