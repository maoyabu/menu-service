import mongoose from 'mongoose';

const { Schema } = mongoose;

const packingItemSchema = new Schema({
  name: { type: String, required: true, trim: true },
  thingId: { type: Schema.Types.ObjectId, ref: 'PackingMasterItem', default: null },
  storageId: { type: Schema.Types.ObjectId, ref: 'PackingStorage', default: null },
  storageName: { type: String, default: '' },
  weight: { type: Number, default: 0 }, // grams
  owner: { type: String, default: 'all' }, // 'all' or userId
  quantity: { type: Number, default: 1 },
  category: { type: String, default: '', trim: true },
  comment: { type: String, default: '' },
  wish: { type: Boolean, default: false },
  checked: { type: Boolean, default: false },
  checkedAt: { type: Date, default: null },
  checkedBy: { type: String, default: '' },
  group: { type: Schema.Types.ObjectId, ref: 'Group', index: true, required: true },
  event: { type: Schema.Types.ObjectId, ref: 'PackingEvent', index: true, required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  reusedFrom: { type: Schema.Types.ObjectId, ref: 'PackingItem', default: null }
}, { timestamps: true });

const PackingItem = mongoose.models.PackingItem || mongoose.model('PackingItem', packingItemSchema);
export default PackingItem;
