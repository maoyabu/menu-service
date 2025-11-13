import mongoose from 'mongoose';

const myEquipmentSchema = new mongoose.Schema({
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  equipment: { type: mongoose.Schema.Types.ObjectId, ref: 'Equipment', default: null },
  name: { type: String, required: true },
  quantity: { type: Number, default: 0 },
  unit: { type: String, default: '' },
  place: { type: mongoose.Schema.Types.ObjectId, ref: 'StoragePlace', default: null },
  isConsumable: { type: Boolean, default: false },
  houseCategory: { type: String, default: '' },
  disasterCategory: { type: String, default: '' },
  campingCategory: { type: String, default: '' },
  maintenance: { type: String, default: '' },
  productUrl: { type: String, default: '' },
  productImageUrl: { type: String, default: '' },
  expiryDate: { type: Date, default: null },
  comment: { type: String, default: '' }
}, { timestamps: true });

const MyEquipment = mongoose.models.MyEquipment || mongoose.model('MyEquipment', myEquipmentSchema);
export default MyEquipment;
