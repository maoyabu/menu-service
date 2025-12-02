import mongoose from 'mongoose';

const { Schema } = mongoose;

const packingEventSchema = new Schema({
  name: { type: String, required: true, trim: true },
  // 旅行用の収納先をイベント単位で保持
  storageContainers: [{
    _id: { type: Schema.Types.ObjectId, default: () => new mongoose.Types.ObjectId() },
    name: { type: String, required: true, trim: true }
  }],
  storageIds: [{ type: Schema.Types.ObjectId, ref: 'PackingStorage', default: [] }],
  participants: [{ type: Schema.Types.ObjectId, ref: 'User', default: [] }],
  group: { type: Schema.Types.ObjectId, ref: 'Group', index: true, required: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now },
  lastOpenedAt: { type: Date, default: null }
});

const PackingEvent = mongoose.models.PackingEvent || mongoose.model('PackingEvent', packingEventSchema);
export default PackingEvent;
