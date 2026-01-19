import mongoose from 'mongoose';

const { Schema } = mongoose;

const packingMasterItemSchema = new Schema({
  name: { type: String, required: true, trim: true },
  owner: { type: String, default: 'all' }, // 'all' or userId
  defaultQuantity: { type: Number, default: 1 },
  defaultWeight: { type: Number, default: 0 }, // grams
  category: { type: String, default: '', trim: true },
  comment: { type: String, default: '' },
  wish: { type: Boolean, default: false },
  group: { type: Schema.Types.ObjectId, ref: 'Group', index: true, required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

const PackingMasterItem = mongoose.models.PackingMasterItem || mongoose.model('PackingMasterItem', packingMasterItemSchema);
export default PackingMasterItem;
