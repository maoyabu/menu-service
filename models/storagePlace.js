import mongoose from 'mongoose';

const storagePlaceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

const StoragePlace = mongoose.models.StoragePlace || mongoose.model('StoragePlace', storagePlaceSchema);
export default StoragePlace;

