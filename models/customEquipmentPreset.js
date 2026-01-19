import mongoose from 'mongoose';

const customEquipmentPresetSchema = new mongoose.Schema({
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: { type: String, required: true },
  unit: { type: String, default: '' },
  houseCategory: { type: String, default: '' },
  disasterCategory: { type: String, default: '' },
  campingCategory: { type: String, default: '' },
  maintenance: { type: String, default: '' },
  isConsumable: { type: Boolean, default: false },
  productUrl: { type: String, default: '' },
  productImageUrl: { type: String, default: '' }
}, { timestamps: true });

const CustomEquipmentPreset = mongoose.models.CustomEquipmentPreset || mongoose.model('CustomEquipmentPreset', customEquipmentPresetSchema);
export default CustomEquipmentPreset;
