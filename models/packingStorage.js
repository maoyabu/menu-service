import mongoose from 'mongoose';

const { Schema } = mongoose;

const packingStorageSchema = new Schema({
  name: { type: String, required: true, trim: true },
  group: { type: Schema.Types.ObjectId, ref: 'Group', index: true, required: true },
  maxWeight: { type: Number, default: 0 }, // grams
  displayOrder: { type: Number, default: null }, // smaller numbers are displayed first
  owner: { type: String, default: 'all' }, // 'all' or userId
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

const PackingStorage = mongoose.models.PackingStorage || mongoose.model('PackingStorage', packingStorageSchema);
export default PackingStorage;
