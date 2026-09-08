import mongoose from 'mongoose';

const { Schema } = mongoose;
const PACKING_PRIORITIES = ['最重要', '重要', '普通', 'あった方がいい', 'あってもいい'];

const packingMasterItemSchema = new Schema({
  name: { type: String, required: true, trim: true },
  owner: { type: String, default: 'all' }, // 'all' or userId
  defaultQuantity: { type: Number, default: 1 },
  defaultWeight: { type: Number, default: 0 }, // grams
  priority: { type: String, enum: PACKING_PRIORITIES, default: '普通' },
  category: { type: String, default: '', trim: true },
  comment: { type: String, default: '' },
  imageUrl: { type: String, default: '', trim: true },
  wish: { type: Boolean, default: false },
  group: { type: Schema.Types.ObjectId, ref: 'Group', index: true, required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

const PackingMasterItem = mongoose.models.PackingMasterItem || mongoose.model('PackingMasterItem', packingMasterItemSchema);
export default PackingMasterItem;
