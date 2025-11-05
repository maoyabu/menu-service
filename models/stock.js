import mongoose from 'mongoose';

const stockSchema = new mongoose.Schema({
  type: { type: String, enum: ['ingredient', 'seasoning'], required: true },
  item: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'typeRef' },
  typeRef: { type: String, enum: ['Ingredient', 'Seasoning'], required: true },
  amount: { type: Number, default: 0 },
  unit: { type: String, default: '' },
  place: { type: mongoose.Schema.Types.ObjectId, ref: 'StoragePlace', default: null },
  expiryDate: { type: Date, default: null },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true }
}, { timestamps: true });

const Stock = mongoose.models.Stock || mongoose.model('Stock', stockSchema);
export default Stock;

