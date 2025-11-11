import mongoose from 'mongoose';

const equipmentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  quantity: { type: Number, default: 0 },
  unit: { type: String, default: '' },
  storagePlace: { type: String, default: '' },
  isConsumable: { type: Boolean, default: false },
  houseCategory: { type: String, default: '' },
  disasterCategory: { type: String, default: '' },
  campingCategory: { type: String, default: '' },
  maintenance: { type: String, default: '' },
  productUrl: { type: String, default: '' },
  expiryDate: { type: Date, default: null }
}, { timestamps: true });

const Equipment = mongoose.models.Equipment || mongoose.model('Equipment', equipmentSchema);
export default Equipment;

