import mongoose from 'mongoose';

const { Schema } = mongoose;

const packingStorageSchema = new Schema({
  name: { type: String, required: true, trim: true },
  group: { type: Schema.Types.ObjectId, ref: 'Group', index: true, required: true },
  maxWeight: { type: Number, default: 0 }, // grams
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

const PackingStorage = mongoose.models.PackingStorage || mongoose.model('PackingStorage', packingStorageSchema);
export default PackingStorage;
